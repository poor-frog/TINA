use crate::Shared;
use std::sync::Arc;

#[derive(Clone, Default, serde::Serialize)]
pub(crate) struct AudioProcessingStatus {
    aec: bool,
    residual_suppression: bool,
    high_pass_hz: u32,
    noise_suppression_db: Option<i32>,
    pub(crate) fallback_reason: Option<&'static str>,
    processed_blocks: u64,
    residual_blocks: u64,
    bypassed_samples: u64,
    pub(crate) mic_clipped_samples: u64,
}

#[cfg(any(target_os = "macos", test))]
fn echo_mode(
    microphone: bool,
    system_audio: bool,
    aec_override: Option<&str>,
    residual_override: Option<&str>,
) -> (bool, bool) {
    let aec = cfg!(all(target_os = "macos", feature = "speex-aec"))
        && microphone
        && system_audio
        && aec_override != Some("0");
    (aec, aec && residual_override != Some("0"))
}

#[cfg(all(target_os = "macos", feature = "speex-aec"))]
pub(crate) const AEC_RAW_MIC_CHANNEL: i32 = 1002;

#[cfg(all(target_os = "macos", feature = "speex-aec"))]
pub(crate) struct CapturePcm {
    pub channel: i32,
    pub name: &'static str,
    pub timestamp_ms: f64,
    pub start_sample: Option<u64>,
    pub samples: Vec<f32>,
}

pub(crate) enum CaptureFrame {
    Wire(Vec<u8>),
    #[cfg(all(target_os = "macos", feature = "speex-aec"))]
    Pcm(CapturePcm),
}

pub(crate) struct CaptureEvent {
    pub epoch: u64,
    pub frame: CaptureFrame,
}

pub(crate) fn can_dispatch_event(
    event_epoch: u64,
    current_epoch: u64,
    paused: bool,
    stopping: bool,
) -> bool {
    !paused && !stopping && event_epoch == current_epoch
}

pub(crate) fn discard_queued_events(
    receiver: &std::sync::mpsc::Receiver<CaptureEvent>,
    shared: &Shared,
) -> usize {
    let discarded = receiver.try_iter().count();
    shared
        .dropped
        .fetch_add(discarded as u64, std::sync::atomic::Ordering::Relaxed);
    discarded
}

#[cfg(test)]
mod queue_tests {
    use super::{can_dispatch_event, discard_queued_events, echo_mode, CaptureEvent, CaptureFrame};
    use crate::Shared;
    use std::sync::mpsc;

    #[test]
    fn production_echo_defaults_require_both_sources_and_allow_rollback() {
        let built = cfg!(all(target_os = "macos", feature = "speex-aec"));
        assert_eq!(echo_mode(true, true, None, None), (built, built));
        assert_eq!(echo_mode(true, false, None, None), (false, false));
        assert_eq!(echo_mode(false, true, None, None), (false, false));
        assert_eq!(echo_mode(false, false, None, None), (false, false));
        assert_eq!(echo_mode(true, true, Some("0"), None), (false, false));
        assert_eq!(echo_mode(true, true, None, Some("0")), (built, false));
        assert_eq!(echo_mode(true, true, Some("1"), Some("1")), (built, built));
    }

    #[test]
    fn pause_invalidates_frames_queued_before_the_pause_and_drops_while_paused() {
        assert!(!can_dispatch_event(4, 5, true, false));
        assert!(!can_dispatch_event(4, 5, false, false));
        assert!(!can_dispatch_event(5, 5, true, false));
        assert!(can_dispatch_event(5, 5, false, false));
        assert!(!can_dispatch_event(5, 5, false, true));
    }

    #[test]
    fn pause_and_resume_advance_the_capture_epoch() {
        let shared = Shared::default();
        let queued_epoch = shared.capture_epoch_for_enqueue().unwrap();
        shared.pause();

        assert!(shared.capture_epoch_for_enqueue().is_none());
        assert!(!shared.capture_epoch_is_active(queued_epoch));

        shared.resume();
        let resumed_epoch = shared.capture_epoch_for_enqueue().unwrap();
        assert_ne!(queued_epoch, resumed_epoch);
        assert!(!shared.capture_epoch_is_active(queued_epoch));
        assert!(shared.capture_epoch_is_active(resumed_epoch));
    }

    #[test]
    fn stop_discards_only_the_bounded_local_queue_tail() {
        let shared = Shared::default();
        let (sender, receiver) = mpsc::sync_channel(4);
        for _ in 0..3 {
            sender
                .send(CaptureEvent {
                    epoch: 0,
                    frame: CaptureFrame::Wire(vec![1, 2, 3]),
                })
                .unwrap();
        }

        assert_eq!(discard_queued_events(&receiver, &shared), 3);
        assert_eq!(shared.dropped.load(std::sync::atomic::Ordering::Relaxed), 3);
        assert_eq!(receiver.try_iter().count(), 0);
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn run(_: bool, _: bool, _: Arc<Shared>) -> anyhow::Result<()> {
    anyhow::bail!("Native system audio capture currently requires macOS 15+")
}

#[cfg(target_os = "windows")]
pub fn run(microphone: bool, system_audio: bool, shared: Arc<Shared>) -> anyhow::Result<()> {
    crate::capture_windows::run(microphone, system_audio, shared)
}

#[cfg(target_os = "macos")]
pub fn run(microphone: bool, system_audio: bool, shared: Arc<Shared>) -> anyhow::Result<()> {
    macos::run(microphone, system_audio, shared)
}

#[cfg(target_os = "macos")]
pub fn has_screen_audio_access() -> bool {
    macos::has_screen_audio_access()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn has_screen_audio_access() -> bool {
    false
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use crate::capture_protocol::audio_frame;
    use crate::capture_transport::{retry_transient_io, send_wire};
    #[cfg(feature = "speex-aec")]
    use crate::echo_cancel::EchoAligner;
    use crate::resampler::Resampler;
    use anyhow::{bail, Context, Result};
    use screencapturekit::prelude::*;
    use std::{
        io::{Read, Write},
        sync::{atomic::Ordering, mpsc, Mutex, OnceLock},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tungstenite::{client::IntoClientRequest, Message};

    #[cfg(feature = "speex-aec")]
    fn send_pcm<S: Read + Write>(
        socket: &mut tungstenite::WebSocket<S>,
        frame: CapturePcm,
        shared: &Shared,
        epoch: u64,
    ) -> Result<()> {
        let bytes = audio_frame(
            frame.channel as u32,
            frame.name,
            frame.timestamp_ms,
            frame.start_sample,
            &frame.samples,
        );
        send_wire(socket, bytes, shared, epoch)
    }

    #[cfg(feature = "speex-aec")]
    fn dispatch(
        socket: &mut tungstenite::WebSocket<impl Read + Write>,
        event: CaptureEvent,
        aec: &mut Option<EchoAligner>,
        shared: &Shared,
    ) -> Result<()> {
        let CaptureEvent { epoch, frame } = event;
        if !shared.capture_epoch_is_active(epoch) {
            shared.dropped.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
        match frame {
            CaptureFrame::Wire(bytes) => send_wire(socket, bytes, shared, epoch),
            CaptureFrame::Pcm(frame) => {
                let echo = aec
                    .as_mut()
                    .context("Speex AEC was requested but is unavailable")?;
                match frame.channel {
                    999 => {
                        echo.push_reference(&frame);
                        send_pcm(socket, frame, shared, epoch)?;
                    }
                    1000 => {
                        send_pcm(
                            socket,
                            CapturePcm {
                                channel: AEC_RAW_MIC_CHANNEL,
                                name: "You (raw)",
                                timestamp_ms: frame.timestamp_ms,
                                start_sample: frame.start_sample,
                                samples: frame.samples.clone(),
                            },
                            shared,
                            epoch,
                        )?;
                        echo.push_microphone(&frame);
                    }
                    _ => send_pcm(socket, frame, shared, epoch)?,
                }
                for clean in echo.drain(std::time::Instant::now(), false) {
                    send_pcm(socket, clean, shared, epoch)?;
                }
                publish_echo_stats(shared, echo);
                Ok(())
            }
        }
    }

    #[cfg(feature = "speex-aec")]
    fn publish_echo_stats(shared: &Shared, echo: &EchoAligner) {
        if let Some(status) = shared.audio_processing.lock().unwrap().as_mut() {
            let stats = echo.stats();
            status.processed_blocks = stats.processed_blocks;
            status.residual_blocks = stats.residual_blocks;
            status.bypassed_samples = stats.bypassed_samples;
            status.mic_clipped_samples = stats.mic_clipped_samples;
        }
    }

    #[cfg(feature = "speex-aec")]
    fn synchronize_echo_epoch(
        shared: &Shared,
        last_epoch: &mut Option<u64>,
        echo: &mut Option<EchoAligner>,
        residual_suppression: bool,
        mic_cleanup: bool,
    ) -> Result<()> {
        let current_epoch = shared.capture_epoch_for_enqueue();
        if *last_epoch != current_epoch {
            if let Some(echo) = echo {
                echo.reset_epoch(residual_suppression, mic_cleanup)?;
            }
            *last_epoch = current_epoch;
        }
        Ok(())
    }

    #[cfg(not(feature = "speex-aec"))]
    fn dispatch(
        socket: &mut tungstenite::WebSocket<impl Read + Write>,
        event: CaptureEvent,
        shared: &Shared,
    ) -> Result<()> {
        let CaptureEvent { epoch, frame } = event;
        if !shared.capture_epoch_is_active(epoch) {
            shared.dropped.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
        match frame {
            CaptureFrame::Wire(bytes) => send_wire(socket, bytes, shared, epoch),
        }
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn has_screen_audio_access() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    #[cfg(test)]
    mod tests {
        use super::{audio_capture_configuration, audio_frame, retry_transient_io, send_wire};
        use crate::Shared;
        use std::io::{self, Cursor, Read, Write};
        use std::sync::{atomic::Ordering, Arc, Mutex};
        use tungstenite::{protocol::Role, Message, WebSocket};

        #[cfg(feature = "speex-aec")]
        #[test]
        fn processed_mic_keeps_raw_archive_system_audio_and_sample_offsets_on_wire() {
            use super::{
                dispatch, AudioProcessingStatus, CaptureEvent, CaptureFrame, CapturePcm,
                EchoAligner,
            };
            use std::time::Duration;
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut peer = tungstenite::accept(stream).unwrap();
                (0..3)
                    .map(|_| peer.read().unwrap().into_data().to_vec())
                    .collect::<Vec<_>>()
            });
            let (mut socket, _) = crate::local_ws::connect_local(
                format!("ws://{address}/ingest"),
                Duration::from_secs(3),
                Duration::from_secs(3),
            )
            .unwrap();
            let shared = Shared::new(true, true, false, false, None);
            *shared.audio_processing.lock().unwrap() = Some(AudioProcessingStatus::default());
            let epoch = shared.capture_epoch_for_enqueue().unwrap();
            let mut echo = Some(EchoAligner::new(true, true).unwrap());
            let input = vec![0.02; 160];
            for (channel, name, samples) in [
                (999, "System audio", vec![0.0; 160]),
                (1000, "You", input.clone()),
            ] {
                dispatch(
                    &mut socket,
                    CaptureEvent {
                        epoch,
                        frame: CaptureFrame::Pcm(CapturePcm {
                            channel,
                            name,
                            timestamp_ms: 1000.0,
                            start_sample: Some(320),
                            samples,
                        }),
                    },
                    &mut echo,
                    &shared,
                )
                .unwrap();
            }
            let frames = server.join().unwrap();
            assert_eq!(
                frames[0],
                audio_frame(999, "System audio", 1000.0, Some(320), &[0.0; 160])
            );
            assert_eq!(
                frames[1],
                audio_frame(1002, "You (raw)", 1000.0, Some(320), &input)
            );
            let expected_header = audio_frame(1000, "You", 1000.0, Some(320), &[]);
            assert_eq!(
                &frames[2][..expected_header.len()],
                expected_header.as_slice()
            );
            assert_eq!(frames[2].len(), expected_header.len() + input.len() * 4);
            assert_ne!(
                frames[2],
                audio_frame(1000, "You", 1000.0, Some(320), &input)
            );
            let status = shared.audio_processing.lock().unwrap();
            assert_eq!(status.as_ref().unwrap().processed_blocks, 1);
            assert_eq!(status.as_ref().unwrap().residual_blocks, 1);
        }

        struct RetryOnceStream {
            output: Arc<Mutex<Vec<u8>>>,
            block_next_write: bool,
        }

        impl Read for RetryOnceStream {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Ok(0)
            }
        }

        impl Write for RetryOnceStream {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if self.block_next_write {
                    self.block_next_write = false;
                    return Err(io::Error::from(io::ErrorKind::WouldBlock));
                }
                self.output.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        #[test]
        fn buffered_websocket_send_retries_would_block_without_duplicate_frames() {
            let output = Arc::new(Mutex::new(Vec::new()));
            let stream = RetryOnceStream {
                output: output.clone(),
                block_next_write: true,
            };
            let mut socket = WebSocket::from_raw_socket(stream, Role::Client, None);
            let shared = Shared::default();
            let epoch = shared.capture_epoch_for_enqueue().unwrap();

            send_wire(&mut socket, vec![1, 2, 3], &shared, epoch).unwrap();

            assert_eq!(shared.frames.load(Ordering::Relaxed), 1);
            let mut peer = WebSocket::from_raw_socket(
                Cursor::new(output.lock().unwrap().clone()),
                Role::Server,
                None,
            );
            assert_eq!(peer.read().unwrap(), Message::Binary(vec![1, 2, 3].into()));
            assert!(peer.read().is_err());
        }

        #[test]
        fn retries_transient_local_websocket_io_once() {
            for kind in [
                std::io::ErrorKind::WouldBlock,
                std::io::ErrorKind::TimedOut,
                std::io::ErrorKind::Interrupted,
            ] {
                let mut attempts = 0;
                let result = retry_transient_io(|| {
                    attempts += 1;
                    if attempts == 1 {
                        Err(tungstenite::Error::Io(std::io::Error::from(kind)))
                    } else {
                        Ok(())
                    }
                });

                assert!(result.is_ok());
                assert_eq!(attempts, 2);
            }
        }

        #[test]
        fn does_not_retry_permanent_websocket_errors() {
            let mut attempts = 0;
            let result = retry_transient_io::<()>(|| {
                attempts += 1;
                Err(tungstenite::Error::ConnectionClosed)
            });

            assert!(matches!(result, Err(tungstenite::Error::ConnectionClosed)));
            assert_eq!(attempts, 1);
        }

        #[test]
        fn indexed_and_legacy_headers_match_the_shared_codec() {
            let indexed = audio_frame(1000, "You", 123.0, Some(32000), &[0.5]);
            assert_eq!(indexed.len(), 32);
            assert_eq!(
                u32::from_le_bytes(indexed[0..4].try_into().unwrap()),
                0xc00003e8
            );
            assert_eq!(
                f64::from_le_bytes(indexed[4..12].try_into().unwrap()),
                123.0
            );
            assert_eq!(
                f64::from_le_bytes(indexed[12..20].try_into().unwrap()),
                32000.0
            );
            assert_eq!(&indexed[24..27], b"You");
            assert_eq!(f32::from_le_bytes(indexed[28..32].try_into().unwrap()), 0.5);
            let old = audio_frame(1000, "You", 123.0, None, &[0.5]);
            assert_eq!(old.len(), 24);
            assert_eq!(
                u32::from_le_bytes(old[0..4].try_into().unwrap()),
                0x800003e8
            );
            assert_eq!(&old[16..19], b"You");
            assert_eq!(f32::from_le_bytes(old[20..24].try_into().unwrap()), 0.5);
        }

        #[test]
        fn audio_capture_configuration_throttles_unused_screen_output() {
            let config = audio_capture_configuration(true, true).unwrap();

            assert_eq!(config.fps(), 1);
            assert!(config.captures_audio());
            assert!(config.captures_microphone());
        }
    }

    struct Lane {
        next_sample: u64,
        origin_ms: Option<f64>,
        rate: i32,
        resampler: Option<Resampler>,
        next_ts: Option<f64>,
        last_end: Option<f64>,
    }
    struct Handler {
        indexed: bool,
        #[cfg(feature = "speex-aec")]
        aec_enabled: bool,
        channel: i32,
        name: &'static str,
        lane: Mutex<Lane>,
        clock: Arc<OnceLock<f64>>,
        tx: mpsc::SyncSender<CaptureEvent>,
        shared: Arc<Shared>,
    }
    impl Handler {
        fn process(&self, sample: CMSampleBuffer) -> Result<()> {
            let fmt = sample
                .format_description()
                .context("Audio format is missing")?;
            let rate = fmt.audio_sample_rate().context("Audio rate is missing")? as i32;
            let channels = fmt
                .audio_channel_count()
                .context("Audio channels are missing")? as usize;
            let bits = fmt
                .audio_bits_per_channel()
                .context("Audio bit depth is missing")?;
            if !(8000..=192000).contains(&rate)
                || !(1..=8).contains(&channels)
                || fmt.audio_is_big_endian()
            {
                bail!("Unsupported captured audio format");
            }
            let float = fmt.audio_is_float();
            if !((float && bits == 32) || (!float && matches!(bits, 16 | 32))) {
                bail!("Unsupported captured sample encoding");
            }
            let frames = usize::try_from(sample.num_samples())?;
            if frames == 0 {
                return Ok(());
            }
            if frames > 192000 {
                bail!("Captured packet exceeds one second");
            }
            let buffers = sample
                .audio_buffer_list()
                .map_err(|_| anyhow::anyhow!("Cannot access captured audio"))?;
            let mut mono = vec![0.0_f32; frames];
            let mut count = 0;
            for buffer in &buffers {
                let n = buffer.number_channels as usize;
                let width = bits as usize / 8;
                if n == 0 || n > channels || buffer.data().len() != frames * n * width {
                    bail!("Invalid captured audio buffer");
                }
                count += n;
                for (i, frame) in buffer.data().chunks_exact(width * n).enumerate() {
                    for bytes in frame.chunks_exact(width) {
                        let value = if float {
                            f32::from_le_bytes(bytes.try_into()?)
                        } else if bits == 16 {
                            i16::from_le_bytes(bytes.try_into()?) as f32 / 32768.0
                        } else {
                            i32::from_le_bytes(bytes.try_into()?) as f32 / 2147483648.0
                        };
                        if !value.is_finite() {
                            bail!("Non-finite captured audio");
                        }
                        mono[i] += value / channels as f32;
                    }
                }
            }
            if count != channels {
                bail!("Captured channel layout changed");
            }
            if self.channel == 1000 {
                let rms = (mono.iter().map(|value| value * value).sum::<f32>() / mono.len() as f32)
                    .sqrt();
                let mut level = self.shared.level.lock().unwrap();
                *level = (*level * 0.78).max(rms.clamp(0.0, 1.0));
            }
            let pts = sample
                .presentation_timestamp()
                .as_seconds()
                .context("Invalid capture timestamp")?;
            if !pts.is_finite() {
                bail!("Invalid capture clock");
            }
            let epoch = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
            // Calibrate once against host PTS; never stamp queued audio with its send time.
            let offset = *self
                .clock
                .get_or_init(|| epoch - pts - frames as f64 / rate as f64);
            let ts = (pts + offset) * 1000.0;
            let mut lane = self.lane.lock().unwrap();
            if lane.rate != rate || lane.last_end.is_some_and(|end| (ts - end).abs() > 100.0) {
                lane.resampler = if rate == 16000 {
                    None
                } else {
                    Some(Resampler::new(rate as u32)?)
                };
                if let Some(origin) = lane.origin_ms {
                    lane.next_sample = lane
                        .next_sample
                        .max(((ts - origin) * 16.0).round().max(0.0) as u64);
                }
                lane.rate = rate;
                lane.next_ts = Some(ts);
            }
            lane.last_end = Some(ts + frames as f64 * 1000.0 / rate as f64);
            let pcm = match &mut lane.resampler {
                Some(r) => r.process(&mono)?,
                None => mono,
            };
            if pcm.is_empty() {
                return Ok(());
            }
            let frame_ts = lane.next_ts.unwrap_or(ts);
            lane.next_ts = Some(frame_ts + pcm.len() as f64 / 16.0);
            lane.origin_ms.get_or_insert(frame_ts);
            let sample_index = lane.next_sample;
            lane.next_sample += pcm.len() as u64;
            let epoch = match self.shared.capture_epoch_for_enqueue() {
                Some(epoch) => epoch,
                None => {
                    self.shared.dropped.fetch_add(1, Ordering::Relaxed);
                    return Ok(());
                }
            };
            #[cfg(feature = "speex-aec")]
            let frame = if self.aec_enabled {
                CaptureFrame::Pcm(CapturePcm {
                    channel: self.channel,
                    name: self.name,
                    timestamp_ms: frame_ts,
                    start_sample: self.indexed.then_some(sample_index),
                    samples: pcm,
                })
            } else {
                CaptureFrame::Wire(audio_frame(
                    self.channel as u32,
                    self.name,
                    frame_ts,
                    self.indexed.then_some(sample_index),
                    &pcm,
                ))
            };
            #[cfg(not(feature = "speex-aec"))]
            let frame = CaptureFrame::Wire(audio_frame(
                self.channel as u32,
                self.name,
                frame_ts,
                self.indexed.then_some(sample_index),
                &pcm,
            ));
            let event = CaptureEvent { epoch, frame };
            match self.tx.try_send(event) {
                Ok(()) => {}
                Err(mpsc::TrySendError::Full(_)) => {
                    self.shared.dropped.fetch_add(1, Ordering::Relaxed);
                }
                Err(mpsc::TrySendError::Disconnected(_)) => bail!("TINA capture connection closed"),
            }
            Ok(())
        }
    }
    impl SCStreamOutputTrait for Handler {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, _: SCStreamOutputType) {
            if self.shared.stop.load(Ordering::Relaxed) {
                return;
            }
            if let Err(error) = self.process(sample) {
                *self.shared.error.lock().unwrap() = Some(error.to_string());
                self.shared.stop.store(true, Ordering::Relaxed);
            }
        }
    }

    fn audio_capture_configuration(
        system_audio: bool,
        microphone: bool,
    ) -> Result<SCStreamConfiguration> {
        Ok(SCStreamConfiguration::new()
            .with_width(2)
            .with_height(2)
            .with_fps(1)
            .with_sample_rate(16000)
            .with_channel_count(1)
            .with_captures_audio(system_audio)
            .with_excludes_current_process_audio(true)
            .with_captures_microphone(microphone)?)
    }

    pub fn run(microphone: bool, system_audio: bool, shared: Arc<Shared>) -> Result<()> {
        let aec_override = std::env::var("TINA_SPEEX_AEC").ok();
        let residual_override = std::env::var("TINA_SPEEX_RESIDUAL_SUPPRESSION").ok();
        let cleanup_override = std::env::var("TINA_MIC_CLEANUP").ok();
        let (aec_enabled, residual_enabled) = echo_mode(
            microphone,
            system_audio,
            aec_override.as_deref(),
            residual_override.as_deref(),
        );
        let mic_cleanup = residual_enabled && cleanup_override.as_deref() != Some("0");
        #[cfg(not(feature = "speex-aec"))]
        if microphone && system_audio && aec_override.as_deref() == Some("1") {
            bail!("Speex AEC is unavailable in this build; rebuild with default features or --features speex-aec");
        }
        let (mut socket, ready, id) = crate::capture_transport::connect_capture()?;
        let audio_processing = AudioProcessingStatus {
            fallback_reason: Some(if !microphone || !system_audio {
                "Echo cancellation requires microphone and system audio"
            } else if !cfg!(feature = "speex-aec") {
                "This build does not include Speex AEC"
            } else {
                "Echo cancellation disabled by configuration"
            }),
            ..Default::default()
        };
        #[cfg(feature = "speex-aec")]
        let mut audio_processing = audio_processing;
        #[cfg(feature = "speex-aec")]
        let mut echo = if aec_enabled {
            if ready.get("audio_timeline").and_then(|v| v.as_str()) == Some("sample-index.v1") {
                match EchoAligner::new(residual_enabled, mic_cleanup) {
                    Ok(echo) => {
                        audio_processing.aec = true;
                        audio_processing.residual_suppression = residual_enabled;
                        audio_processing.high_pass_hz = if mic_cleanup { 70 } else { 0 };
                        audio_processing.noise_suppression_db = mic_cleanup.then_some(-3);
                        audio_processing.fallback_reason = None;
                        Some(echo)
                    }
                    Err(error) => {
                        audio_processing.fallback_reason =
                            Some("Speex initialization failed; original microphone used");
                        eprintln!("[capture] Speex AEC unavailable: {error}; using original mic");
                        None
                    }
                }
            } else {
                audio_processing.fallback_reason =
                    Some("Desktop lacks sample-index.v1; original microphone used");
                eprintln!("[capture] Speex AEC requires sample-index.v1; using original mic");
                None
            }
        } else {
            None
        };
        #[cfg(feature = "speex-aec")]
        let aec_enabled = echo.is_some();
        #[cfg(feature = "speex-aec")]
        let residual_enabled = aec_enabled && residual_enabled;
        *shared.audio_processing.lock().unwrap() = Some(audio_processing);
        if aec_enabled {
            eprintln!("[capture] Speex AEC enabled; residual_suppression={residual_enabled}; mic_cleanup={mic_cleanup}; raw mic is archived separately, ASR receives the processed mic");
        }

        // Ad-hoc rebuilds change cdhash; a checked Settings row may authorize an older binary.
        if !unsafe { CGPreflightScreenCaptureAccess() }
            && !unsafe { CGRequestScreenCaptureAccess() }
        {
            bail!("macOS has not granted Screen & System Audio Recording access to this build of TINA Capture. If the switch is already on, remove the old TINA Capture entry, add the current app, then reopen it.");
        }
        let content =
            SCShareableContent::get().context("Cannot enumerate macOS capture sources")?;
        *shared.transcription.lock().unwrap() = ready.get("transcription").cloned();
        *shared.meeting.lock().unwrap() = Some(format!("desktop/{id}"));
        // Subscribe to Desktop's live transcript for the overlay and subtitles.
        // Failure is non-fatal: audio keeps flowing and the main window falls
        // back to polling GET /transcripts.
        if !shared.dictation {
            let captions = crate::captions::Captions::start(id.clone());
            captions.set_target_language(shared.translation_target.lock().unwrap().clone());
            *shared.captions.lock().unwrap() = Some(captions);
        }
        let display = content
            .displays()
            .into_iter()
            .next()
            .context("No display available for system audio")?;
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build()?;
        let config = audio_capture_configuration(system_audio, microphone)?;
        let (tx, rx) = mpsc::sync_channel::<CaptureEvent>(128);
        let clock = Arc::new(OnceLock::new());
        let handler = |channel, name| Handler {
            indexed: ready.get("audio_timeline").and_then(|v| v.as_str())
                == Some("sample-index.v1"),
            #[cfg(feature = "speex-aec")]
            aec_enabled,
            channel,
            name,
            lane: Mutex::new(Lane {
                next_sample: 0,
                origin_ms: None,
                rate: 0,
                resampler: None,
                next_ts: None,
                last_end: None,
            }),
            clock: clock.clone(),
            tx: tx.clone(),
            shared: shared.clone(),
        };
        let mut stream = SCStream::new(&filter, &config)?;
        // The display stream still produces screen output even though TINA uses
        // only its audio. Consume the small, one-fps frames to avoid ScreenCaptureKit
        // repeatedly reporting an unregistered video output.
        stream.add_output_handler(
            |_sample: CMSampleBuffer, _output_type: SCStreamOutputType| {},
            SCStreamOutputType::Screen,
        )?;
        if system_audio {
            stream.add_output_handler(handler(999, "System audio"), SCStreamOutputType::Audio)?;
        }
        if microphone {
            stream.add_output_handler(handler(1000, "You"), SCStreamOutputType::Microphone)?;
        }
        stream.start_capture().context(
            "Cannot start audio capture; check macOS microphone and system audio permissions",
        )?;
        shared.capturing.store(true, Ordering::Relaxed);
        #[cfg(feature = "speex-aec")]
        let mut last_epoch = shared.capture_epoch_for_enqueue();
        let result = (|| -> Result<()> {
            while !shared.stop.load(Ordering::Relaxed) {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(event) => {
                        #[cfg(feature = "speex-aec")]
                        synchronize_echo_epoch(
                            &shared,
                            &mut last_epoch,
                            &mut echo,
                            residual_enabled,
                            mic_cleanup,
                        )?;
                        #[cfg(feature = "speex-aec")]
                        dispatch(&mut socket, event, &mut echo, &shared)?;
                        #[cfg(not(feature = "speex-aec"))]
                        dispatch(&mut socket, event, &shared)?;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        #[cfg(feature = "speex-aec")]
                        {
                            synchronize_echo_epoch(
                                &shared,
                                &mut last_epoch,
                                &mut echo,
                                residual_enabled,
                                mic_cleanup,
                            )?;
                            if let (Some(epoch), Some(echo)) =
                                (shared.capture_epoch_for_enqueue(), echo.as_mut())
                            {
                                for clean in echo.drain(std::time::Instant::now(), false) {
                                    send_pcm(&mut socket, clean, &shared, epoch)?;
                                }
                                publish_echo_stats(&shared, echo);
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            Ok(())
        })();
        let stopped = stream.stop_capture();
        // Stop is a bounded discard policy, not a synchronous network flush.
        // Preserve already delivered frames and drop only the local queue tail.
        discard_queued_events(&rx, &shared);
        #[cfg(feature = "speex-aec")]
        if let Some(echo) = echo.as_mut() {
            publish_echo_stats(&shared, echo);
            let stats = echo.stats();
            eprintln!(
                "[capture] Speex AEC processed_blocks={} residual_blocks={} bypassed_samples={}",
                stats.processed_blocks, stats.residual_blocks, stats.bypassed_samples
            );
        }
        shared.capturing.store(false, Ordering::Relaxed);
        // Closing ingest finalizes Desktop's existing transcript pipeline.
        let _ = socket.close(None);
        result?;
        stopped?;
        Ok(())
    }
}
