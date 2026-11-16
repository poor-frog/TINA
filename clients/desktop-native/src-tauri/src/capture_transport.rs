use crate::{capture::can_dispatch_event, Shared};
use anyhow::{bail, Context, Result};
use std::{
    io::{Read, Write},
    sync::atomic::Ordering,
    time::Duration,
};
use tungstenite::{client::IntoClientRequest, Message};

fn is_transient_io_error(error: &tungstenite::Error) -> bool {
    matches!(
        error,
        tungstenite::Error::Io(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock
                    | std::io::ErrorKind::TimedOut
                    | std::io::ErrorKind::Interrupted
            )
    )
}

pub(crate) fn retry_transient_io<T>(
    mut operation: impl FnMut() -> std::result::Result<T, tungstenite::Error>,
) -> std::result::Result<T, tungstenite::Error> {
    match operation() {
        Err(error) if is_transient_io_error(&error) => operation(),
        result => result,
    }
}

pub(crate) fn send_wire<S: Read + Write>(
    socket: &mut tungstenite::WebSocket<S>,
    bytes: Vec<u8>,
    shared: &Shared,
    epoch: u64,
) -> Result<()> {
    let clock = shared.clock.lock().unwrap();
    if !can_dispatch_event(
        epoch,
        clock.epoch,
        clock.paused_at.is_some(),
        shared.stop.load(Ordering::Relaxed),
    ) {
        shared.dropped.fetch_add(1, Ordering::Relaxed);
        return Ok(());
    }
    if let Err(error) = socket.write(Message::Binary(bytes.into())) {
        if !is_transient_io_error(&error) {
            return Err(error.into());
        }
    }
    retry_transient_io(|| socket.flush())?;
    shared.frames.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

pub(crate) fn connect_capture() -> Result<(
    tungstenite::WebSocket<std::net::TcpStream>,
    serde_json::Value,
    String,
)> {
    let secret = crate::ingest_auth::read_secret()?;
    let id = format!("tina-native-{}", uuid::Uuid::new_v4());
    let challenge = uuid::Uuid::new_v4().simple().to_string();
    let mut request = format!("ws://127.0.0.1:9099/ingest?platform=desktop&native_meeting_id={id}")
        .into_client_request()?;
    request.headers_mut().insert(
        "x-tina-capture-challenge",
        challenge
            .parse()
            .context("Invalid local capture challenge")?,
    );
    let (mut socket, response) =
        crate::local_ws::connect_local(request, Duration::from_secs(5), Duration::from_secs(2))?;
    let proof = response
        .headers()
        .get("x-tina-capture-proof")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !crate::ingest_auth::verify_proof(&secret, &challenge, proof) {
        bail!("TINA Desktop could not be authenticated on loopback");
    }
    let ready = retry_transient_io(|| socket.read())?;
    let ready: serde_json::Value = serde_json::from_str(ready.to_text().unwrap_or(""))?;
    if ready["type"] != "ready" {
        bail!(
            "{}",
            ready["message"]
                .as_str()
                .unwrap_or("TINA Desktop did not accept capture")
        );
    }
    Ok((socket, ready, id))
}
