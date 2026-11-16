//! Windows 11: WASAPI microphone and process-excluding loopback, never screen capture.
use crate::capture::{discard_queued_events, AudioProcessingStatus, CaptureEvent, CaptureFrame};
use crate::{capture_protocol::audio_frame, capture_transport, Shared};
use anyhow::{bail, ensure, Context, Result};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};
use windows::Win32::System::{
    Com::CoUninitialize,
    Performance::{QueryPerformanceCounter, QueryPerformanceFrequency},
};

#[derive(Default)]
struct PacketClock {
    origin: Option<(u64, f64)>,
    previous_end: u64,
    previous_end_ms: f64,
    next_sample: u64,
}

impl PacketClock {
    fn stamp(&mut self, index: u64, timestamp_ms: f64, frames: u32) -> Result<u64> {
        ensure!(
            timestamp_ms.is_finite() && timestamp_ms > 0.0,
            "Invalid WASAPI timestamp"
        );
        ensure!(
            frames > 0 && frames <= 16_000,
            "Invalid WASAPI packet length"
        );
        let (first_index, first_ms) = *self.origin.get_or_insert((index, timestamp_ms));
        ensure!(
            index >= self.previous_end
                && timestamp_ms >= first_ms
                && timestamp_ms + 1.0 >= self.previous_end_ms,
            "WASAPI device clock reset; restart capture"
        );
        let sample = (index - first_index)
            .max(((timestamp_ms - first_ms) * 16.0).round() as u64)
            .max(self.next_sample);
        self.previous_end = index
            .checked_add(u64::from(frames))
            .context("WASAPI clock overflow")?;
        self.previous_end_ms = timestamp_ms + f64::from(frames) / 16.0;
        self.next_sample = sample
            .checked_add(u64::from(frames))
            .context("Capture clock overflow")?;
        Ok(sample)
    }
}

fn decode_pcm(bytes: &[u8], frames: u32, silent: bool) -> Result<Vec<f32>> {
    ensure!(
        frames <= 16_000 && bytes.len() == frames as usize * 4,
        "Invalid WASAPI audio format"
    );
    if silent {
        return Ok(vec![0.0; frames as usize]);
    }
    let pcm: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    ensure!(pcm.iter().all(|x| x.is_finite()), "Non-finite WASAPI audio");
    Ok(pcm)
}

#[derive(Clone, Copy)]
struct CaptureClock {
    offset_ms: f64,
    qpc_anchor_hns: f64,
    instant_anchor: Instant,
}

impl CaptureClock {
    fn packet_started(&self, timestamp: u64) -> Option<Instant> {
        let seconds = (timestamp as f64 - self.qpc_anchor_hns) / 10_000_000.0;
        self.instant_anchor
            .checked_add(Duration::try_from_secs_f64(seconds).ok()?)
    }
}

fn capture_clock() -> Result<CaptureClock> {
    let (mut counter, mut frequency) = (0, 0);
    // Take Instant first: the small calibration uncertainty discards extra boundary samples.
    let instant_anchor = Instant::now();
    unsafe {
        QueryPerformanceFrequency(&mut frequency)?;
        QueryPerformanceCounter(&mut counter)?;
    }
    ensure!(frequency > 0, "Invalid Windows performance clock");
    let qpc_anchor_hns = counter as f64 * 10_000_000.0 / frequency as f64;
    Ok(CaptureClock {
        instant_anchor,
        qpc_anchor_hns,
        offset_ms: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64() * 1000.0
            - qpc_anchor_hns / 10_000.0,
    })
}

fn source(
    microphone: bool,
    shared: Arc<Shared>,
    cancelled: Arc<AtomicBool>,
    sender: mpsc::SyncSender<CaptureEvent>,
    ready: mpsc::SyncSender<()>,
    indexed: bool,
    calibration: CaptureClock,
) -> Result<()> {
    wasapi::initialize_mta().ok()?;
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let _com = Com;
    let mut client = if microphone {
        DeviceEnumerator::new()?
            .get_default_device(Direction::Capture)
            .context("No default Windows microphone. Connect an input device and select it in Windows Sound settings")?
            .get_iaudioclient()?
    } else {
        AudioClient::new_application_loopback_client(std::process::id(), false)?
    };
    let format = WaveFormat::new(32, 32, SampleType::Float, 16_000, 1, None);
    client.initialize_client(
        &format,
        Direction::Capture,
        StreamMode::PollingShared {
            autoconvert: true,
            buffer_duration_hns: 1_000_000,
        },
        None,
    )?;
    // Process loopback does not support GetBufferSize; cap packets independently of the driver.
    let capacity = 16_000;
    let capture = client.get_audiocaptureclient()?;
    let mut bytes = vec![0; capacity as usize * 4];
    let mut clock = PacketClock::default();
    if cancelled.load(Ordering::Relaxed) || shared.stop.load(Ordering::Relaxed) {
        return Ok(());
    }
    client
        .start_stream()
        .context("Cannot start WASAPI; check Windows microphone privacy and audio devices")?;
    let result = (|| -> Result<()> {
        ready.send(()).context("Capture setup cancelled")?;
        while !cancelled.load(Ordering::Relaxed) && !shared.stop.load(Ordering::Relaxed) {
            let packet_frames = capture.get_next_packet_size()?.unwrap_or(0);
            ensure!(
                packet_frames <= capacity,
                "WASAPI packet exceeds one second"
            );
            if packet_frames == 0 {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            let (frames, info) = capture.read_from_device(&mut bytes)?;
            if frames == 0 {
                continue;
            }
            if info.flags.timestamp_error || info.timestamp == 0 {
                shared.dropped.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let timestamp_ms = calibration.offset_ms + info.timestamp as f64 / 10_000.0;
            let sample = clock.stamp(info.index, timestamp_ms, frames)?;
            ensure!(frames <= capacity, "WASAPI packet exceeds capture buffer");
            let pcm = decode_pcm(&bytes[..frames as usize * 4], frames, info.flags.silent)?;
            let Some(epoch) = calibration
                .packet_started(info.timestamp)
                .and_then(|started| shared.capture_epoch_for_packet(started))
            else {
                continue;
            };
            if !shared.capture_epoch_is_active(epoch) {
                continue;
            }
            if microphone {
                let rms = (pcm.iter().map(|v| v * v).sum::<f32>() / pcm.len() as f32).sqrt();
                let mut level = shared.level.lock().unwrap();
                *level = (*level * 0.78).max(rms.clamp(0.0, 1.0));
                if let Some(status) = shared.audio_processing.lock().unwrap().as_mut() {
                    status.mic_clipped_samples +=
                        pcm.iter().filter(|v| v.abs() >= 1.0).count() as u64;
                }
            }
            let (channel, name) = if microphone {
                (1000, "You")
            } else {
                (999, "System audio")
            };
            let event = CaptureEvent {
                epoch,
                frame: CaptureFrame::Wire(audio_frame(
                    channel,
                    name,
                    timestamp_ms,
                    indexed.then_some(sample),
                    &pcm,
                )),
            };
            match sender.try_send(event) {
                Ok(()) => {}
                Err(mpsc::TrySendError::Full(_)) => {
                    shared.dropped.fetch_add(1, Ordering::Relaxed);
                }
                Err(mpsc::TrySendError::Disconnected(_)) => bail!("Capture connection closed"),
            }
        }
        Ok(())
    })();
    let stopped = client.stop_stream();
    result?;
    stopped?;
    Ok(())
}

pub(crate) fn run(microphone: bool, system_audio: bool, shared: Arc<Shared>) -> Result<()> {
    // Verify the server before opening either audio source.
    let (mut socket, ready, id) = capture_transport::connect_capture()?;
    let indexed = ready["audio_timeline"].as_str() == Some("sample-index.v1");
    *shared.meeting.lock().unwrap() = Some(format!("desktop/{id}"));
    *shared.transcription.lock().unwrap() = ready.get("transcription").cloned();
    if !shared.dictation {
        let captions = crate::captions::Captions::start(id.clone());
        captions.set_target_language(shared.translation_target.lock().unwrap().clone());
        *shared.captions.lock().unwrap() = Some(captions);
    }
    let mut audio_processing = AudioProcessingStatus::default();
    audio_processing.fallback_reason =
        Some("Windows capture uses original microphone audio; use headphones to avoid echo");
    *shared.audio_processing.lock().unwrap() = Some(audio_processing);
    let calibration = capture_clock()?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel(128);
    let (ready_tx, ready_rx) = mpsc::sync_channel(2);
    let (errors_tx, errors_rx) = mpsc::sync_channel(2);
    let mut workers = Vec::new();
    for is_mic in [true, false]
        .into_iter()
        .filter(|mic| if *mic { microphone } else { system_audio })
    {
        let (shared, cancelled, tx, ready_tx, errors_tx) = (
            shared.clone(),
            cancelled.clone(),
            tx.clone(),
            ready_tx.clone(),
            errors_tx.clone(),
        );
        workers.push(std::thread::spawn(move || {
            if let Err(error) = source(
                is_mic,
                shared,
                cancelled.clone(),
                tx,
                ready_tx,
                indexed,
                calibration,
            ) {
                let _ = errors_tx.send(error.to_string());
                cancelled.store(true, Ordering::Relaxed);
            }
        }));
    }
    drop(tx);
    drop(ready_tx);
    drop(errors_tx);
    let result = (|| -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut remaining = workers.len();
        while remaining > 0 && !shared.stop.load(Ordering::Relaxed) {
            if let Ok(error) = errors_rx.try_recv() {
                bail!("WASAPI capture failed: {error}");
            }
            ensure!(Instant::now() < deadline, "WASAPI initialization timed out");
            if ready_rx.recv_timeout(Duration::from_millis(50)).is_ok() {
                remaining -= 1;
            }
        }
        shared
            .capturing
            .store(!shared.stop.load(Ordering::Relaxed), Ordering::Relaxed);
        while !shared.stop.load(Ordering::Relaxed) {
            if let Ok(error) = errors_rx.try_recv() {
                bail!("WASAPI capture failed: {error}");
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(event) if !cancelled.load(Ordering::Relaxed) => {
                    let CaptureFrame::Wire(bytes) = event.frame;
                    capture_transport::send_wire(&mut socket, bytes, &shared, event.epoch)?;
                }
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => bail!("WASAPI sources disconnected"),
            }
        }
        Ok(())
    })();
    cancelled.store(true, Ordering::Relaxed);
    retire_workers(workers);
    discard_queued_events(&rx, &shared);
    shared.capturing.store(false, Ordering::Relaxed);
    let _ = socket.close(None);
    result
}

fn retire_workers(workers: Vec<std::thread::JoinHandle<()>>) {
    // shortcut: Windows activation cannot be cancelled; late workers retire when the OS returns.
    for worker in workers {
        if worker.is_finished() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_device_gaps_instead_of_concatenating_missing_audio() {
        let mut clock = PacketClock::default();
        assert_eq!(clock.stamp(100, 1000.0, 160).unwrap(), 0);
        assert_eq!(clock.stamp(580, 1030.0, 160).unwrap(), 480);
        assert!(clock.stamp(10, 1040.0, 160).is_err());
    }

    #[test]
    fn rejects_a_timestamp_regression_even_when_device_index_advances() {
        let mut clock = PacketClock::default();
        clock.stamp(0, 1000.0, 160).unwrap();
        clock.stamp(160, 1010.0, 160).unwrap();
        assert!(clock.stamp(320, 1005.0, 160).is_err());
    }
    #[test]
    fn invalid_timestamps_and_pcm_fail_closed() {
        assert!(PacketClock::default().stamp(0, f64::NAN, 160).is_err());
        assert!(decode_pcm(&f32::NAN.to_le_bytes(), 1, false).is_err());
        assert!(decode_pcm(&[0; 3], 1, false).is_err());
        assert_eq!(
            decode_pcm(&f32::NAN.to_le_bytes(), 1, true).unwrap(),
            vec![0.0]
        );
    }

    #[test]
    fn stop_does_not_wait_for_a_stalled_windows_activation() {
        let (release, wait) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = wait.recv();
        });
        let start = Instant::now();
        retire_workers(vec![worker]);
        assert!(start.elapsed() < Duration::from_millis(100));
        let _ = release.send(());
    }

    #[test]
    #[ignore = "hardware check: enumerates Windows endpoints without recording"]
    fn windows_input_and_output_devices_are_available() {
        wasapi::initialize_mta().ok().unwrap();
        let enumerator = DeviceEnumerator::new().unwrap();
        assert!(enumerator.get_default_device(Direction::Capture).is_ok());
        assert!(enumerator.get_default_device(Direction::Render).is_ok());
        drop(enumerator);
        unsafe {
            CoUninitialize();
        }
    }
}
