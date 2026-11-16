#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod captions;
mod capture;
mod capture_protocol;
mod capture_transport;
#[cfg(target_os = "windows")]
mod capture_windows;
#[cfg(all(target_os = "macos", feature = "speex-aec"))]
mod echo_cancel;
#[cfg(target_os = "macos")]
mod fn_key;
mod ingest_auth;
mod local_ws;
mod meeting;
mod overlay;
#[cfg(target_os = "macos")]
mod resampler;

#[cfg(not(target_os = "macos"))]
mod fn_key {
    pub fn start(_: tauri::AppHandle) {}
    pub fn status() -> &'static str {
        "unsupported"
    }
}

use captions::Captions;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Shared {
    stop: AtomicBool,
    running: AtomicBool,
    capturing: AtomicBool,
    dictation: bool,
    live_translation: bool,
    microphone: bool,
    system_audio: bool,
    frames: AtomicU64,
    dropped: AtomicU64,
    error: Mutex<Option<String>>,
    meeting: Mutex<Option<String>>,
    transcription: Mutex<Option<serde_json::Value>>,
    audio_processing: Mutex<Option<capture::AudioProcessingStatus>>,
    translation_target: Mutex<Option<String>>,
    clock: Mutex<Clock>,
    level: Mutex<f32>,
    captions: Mutex<Option<Arc<Captions>>>,
}

impl Shared {
    fn new(
        microphone: bool,
        system_audio: bool,
        dictation: bool,
        live_translation: bool,
        translation_target: Option<String>,
    ) -> Self {
        Self {
            microphone,
            system_audio,
            dictation,
            live_translation,
            translation_target: Mutex::new(translation_target),
            ..Self::default()
        }
    }

    fn elapsed_ms(&self) -> u64 {
        self.clock.lock().unwrap().elapsed_ms()
    }

    fn pause(&self) {
        self.clock.lock().unwrap().pause_at(Instant::now());
    }

    fn resume(&self) {
        self.clock.lock().unwrap().resume_at(Instant::now());
    }

    fn request_stop(&self) {
        let _clock = self.clock.lock().unwrap();
        self.stop.store(true, Ordering::Relaxed);
    }

    fn paused(&self) -> bool {
        self.clock.lock().unwrap().paused_at.is_some()
    }

    pub(crate) fn capture_epoch_for_enqueue(&self) -> Option<u64> {
        let clock = self.clock.lock().unwrap();
        (clock.paused_at.is_none() && !self.stop.load(Ordering::Relaxed)).then_some(clock.epoch)
    }

    #[cfg(any(target_os = "windows", test))]
    pub(crate) fn capture_epoch_for_packet(&self, packet_started: Instant) -> Option<u64> {
        let clock = self.clock.lock().unwrap();
        if clock.paused_at.is_some()
            || self.stop.load(Ordering::Relaxed)
            || clock
                .last_resumed
                .is_some_and(|resume| packet_started < resume)
        {
            return None;
        }
        Some(clock.epoch)
    }

    pub(crate) fn capture_epoch_is_active(&self, epoch: u64) -> bool {
        let clock = self.clock.lock().unwrap();
        crate::capture::can_dispatch_event(
            epoch,
            clock.epoch,
            clock.paused_at.is_some(),
            self.stop.load(Ordering::Relaxed),
        )
    }

    /// Peak-ish input meter with a fast attack and slow release. Zero while
    /// paused or before the stream is live. Presentation only.
    fn level(&self) -> f32 {
        if self.paused() || !self.capturing.load(Ordering::Relaxed) {
            return 0.0;
        }
        let value = *self.level.lock().unwrap();
        (value * 1000.0).round() / 1000.0
    }

    fn caption_snapshot(&self, limit: usize) -> serde_json::Value {
        let captions = self.captions.lock().unwrap().clone();
        match captions {
            Some(captions) => captions.snapshot(limit),
            None => serde_json::json!({
                "connected": false,
                "error": serde_json::Value::Null,
                "segments": [],
                "pending": "",
                "target_language": self.translation_target.lock().unwrap().clone(),
            }),
        }
    }
}

struct Clock {
    started: Instant,
    paused_total: Duration,
    paused_at: Option<Instant>,
    last_resumed: Option<Instant>,
    epoch: u64,
}

impl Default for Clock {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            paused_total: Duration::ZERO,
            paused_at: None,
            last_resumed: None,
            epoch: 0,
        }
    }
}

impl Clock {
    fn elapsed_ms(&self) -> u64 {
        self.elapsed_ms_at(Instant::now())
    }

    fn elapsed_ms_at(&self, now: Instant) -> u64 {
        let end = self.paused_at.unwrap_or(now);
        end.saturating_duration_since(self.started)
            .saturating_sub(self.paused_total)
            .as_millis() as u64
    }

    fn pause_at(&mut self, at: Instant) {
        if self.paused_at.is_none() {
            self.paused_at = Some(at);
            self.epoch = self.epoch.wrapping_add(1);
        }
    }

    fn resume_at(&mut self, at: Instant) {
        if let Some(paused_at) = self.paused_at.take() {
            self.last_resumed = Some(at);
            self.paused_total += at.saturating_duration_since(paused_at);
            self.epoch = self.epoch.wrapping_add(1);
        }
    }
}

#[cfg(test)]
mod clock_tests {
    use super::Clock;
    use std::time::{Duration, Instant};

    #[test]
    fn pause_transitions_are_idempotent_and_elapsed_time_excludes_the_pause() {
        let started = Instant::now();
        let mut clock = Clock {
            started,
            paused_total: Duration::ZERO,
            paused_at: None,
            last_resumed: None,
            epoch: 0,
        };
        let first_pause = started + Duration::from_secs(2);
        clock.pause_at(first_pause);
        clock.pause_at(started + Duration::from_secs(3));

        assert_eq!(clock.paused_at, Some(first_pause));
        assert_eq!(clock.elapsed_ms_at(started + Duration::from_secs(5)), 2_000);

        clock.resume_at(started + Duration::from_secs(7));
        clock.resume_at(started + Duration::from_secs(8));
        assert_eq!(clock.paused_at, None);
        assert_eq!(clock.paused_total, Duration::from_secs(5));
        assert_eq!(
            clock.elapsed_ms_at(started + Duration::from_secs(10)),
            5_000
        );
    }

    #[test]
    fn shared_pause_state_is_derived_from_the_clock() {
        let shared = super::Shared::default();
        shared.pause();
        assert!(shared.paused());
        shared.resume();
        assert!(!shared.paused());
    }

    #[test]
    fn stop_invalidates_audio_enqueue_and_dispatch_epochs() {
        let shared = super::Shared::default();
        let epoch = shared.capture_epoch_for_enqueue().unwrap();

        shared.request_stop();

        assert!(shared.capture_epoch_for_enqueue().is_none());
        assert!(!shared.capture_epoch_is_active(epoch));
    }
}

#[cfg(test)]
mod export_tests {
    use super::{escape_markdown, write_note_without_overwrite};
    use std::fs;

    #[test]
    fn creates_a_new_export_instead_of_truncating_an_existing_note() {
        let directory =
            std::env::temp_dir().join(format!("tina-capture-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let stem = "TINA meeting 2026-10-26 12-00-00";
        let first = directory.join(format!("{stem}.md"));
        fs::write(&first, "first session").unwrap();

        let second = write_note_without_overwrite(&directory, stem, "second session").unwrap();

        assert_eq!(second, directory.join(format!("{stem} (1).md")));
        assert_eq!(fs::read_to_string(first).unwrap(), "first session");
        assert_eq!(fs::read_to_string(second).unwrap(), "second session");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn escapes_transcript_markdown_that_could_load_remote_content() {
        let escaped = escape_markdown("![pixel](https://example.invalid/pixel)");

        assert!(escaped.starts_with(r"\!\["));
        assert!(!escaped.contains("]("));
        assert!(!escaped.contains("<"));
    }
}

struct Session {
    stop: Arc<Shared>,
    worker: std::thread::JoinHandle<()>,
}

#[derive(Clone, Copy)]
pub(crate) struct Sources {
    pub microphone: bool,
    pub system_audio: bool,
}

impl Default for Sources {
    fn default() -> Self {
        // Matches the meeting flow: one click records both sides.
        Self {
            microphone: true,
            system_audio: true,
        }
    }
}

#[derive(Default)]
pub(crate) struct Control {
    session: Mutex<Option<Session>>,
    shared: Mutex<Arc<Shared>>,
    sources: Mutex<Sources>,
    overlay: Mutex<overlay::OverlayState>,
    subtitles: AtomicBool,
}

#[cfg(test)]
mod windows_packet_tests {
    use super::*;
    #[test]
    fn buffered_packets_captured_before_resume_are_discarded() {
        let shared = Shared::default();
        let start = shared.clock.lock().unwrap().started;
        shared
            .clock
            .lock()
            .unwrap()
            .pause_at(start + Duration::from_millis(10));
        shared
            .clock
            .lock()
            .unwrap()
            .resume_at(start + Duration::from_millis(20));
        assert!(shared
            .capture_epoch_for_packet(start + Duration::from_millis(15))
            .is_none());
        assert!(shared
            .capture_epoch_for_packet(start + Duration::from_millis(19))
            .is_none());
        assert!(shared
            .capture_epoch_for_packet(start + Duration::from_millis(21))
            .is_some());
    }
}

#[derive(serde::Serialize)]
struct Status {
    running: bool,
    capturing: bool,
    paused: bool,
    dictation: bool,
    live_translation: bool,
    microphone: bool,
    system_audio: bool,
    frames: u64,
    dropped: u64,
    elapsed_ms: u64,
    level: f32,
    error: Option<String>,
    meeting: Option<String>,
    transcription: Option<serde_json::Value>,
    audio_processing: Option<capture::AudioProcessingStatus>,
    translation_target: Option<String>,
}

fn status(shared: &Shared) -> Status {
    Status {
        running: shared.running.load(Ordering::Relaxed),
        capturing: shared.capturing.load(Ordering::Relaxed),
        paused: shared.paused(),
        dictation: shared.dictation,
        live_translation: shared.live_translation,
        microphone: shared.microphone,
        system_audio: shared.system_audio,
        frames: shared.frames.load(Ordering::Relaxed),
        dropped: shared.dropped.load(Ordering::Relaxed),
        elapsed_ms: shared.elapsed_ms(),
        level: shared.level(),
        error: shared.error.lock().unwrap().clone(),
        meeting: shared.meeting.lock().unwrap().clone(),
        transcription: shared.transcription.lock().unwrap().clone(),
        audio_processing: shared.audio_processing.lock().unwrap().clone(),
        translation_target: shared.translation_target.lock().unwrap().clone(),
    }
}

#[tauri::command]
async fn transcription_config() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let response = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(7))
            .build()
            .get("http://127.0.0.1:8056/transcription/config")
            .call()
            .map_err(|_| {
                "Could not read ASR configuration. Check TINA Desktop and the settings service."
                    .to_string()
            })?;
        response
            .into_json()
            .map_err(|_| "The ASR configuration is invalid.".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn polish_dictation(text: String) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > 50_000 {
        return Err("Invalid dictation transcript.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let response = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(66))
            .build()
            .post("http://127.0.0.1:8057/dictation/polish")
            .send_json(serde_json::json!({ "text": text }))
            .map_err(|_| "Text polish is unavailable.".to_string())?;
        use std::io::Read;
        let mut reader = response.into_reader();
        let mut encoded = Vec::new();
        reader
            .by_ref()
            .take(256 * 1024)
            .read_to_end(&mut encoded)
            .map_err(|_| "Text polish returned an invalid response.".to_string())?;
        let body: serde_json::Value = serde_json::from_slice(&encoded)
            .map_err(|_| "Text polish returned an invalid response.".to_string())?;
        body["polished_text"]
            .as_str()
            .map(str::trim)
            .filter(|polished| !polished.is_empty() && polished.chars().count() <= 50_000)
            .map(str::to_string)
            .ok_or_else(|| "Text polish returned an invalid response.".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn capture_transcript(
    control: tauri::State<'_, Arc<Control>>,
) -> Result<serde_json::Value, String> {
    let shared = control.shared.lock().unwrap().clone();
    let meeting = shared.meeting.lock().unwrap().clone();
    let Some(meeting) = meeting else {
        return Ok(serde_json::json!({"segments":[]}));
    };
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let response = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(2)).build()
            .get(&format!("http://127.0.0.1:8056/transcripts/{meeting}")).call().map_err(|e|e.to_string())?;
        let data: serde_json::Value = serde_json::from_reader(response.into_reader().take(8*1024*1024)).map_err(|e|e.to_string())?;
        let segments = data["segments"].as_array().map(|all|all.iter().rev().take(200).rev().map(|s|
            serde_json::json!({"text":s["text"],"start":s["start"],"end":s["end"],"speaker":s["speaker"]})
        ).collect::<Vec<_>>()).unwrap_or_default();
        Ok(serde_json::json!({"segments":segments}))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn capture_status(control: tauri::State<'_, Arc<Control>>) -> Status {
    status(&control.shared.lock().unwrap().clone())
}

#[tauri::command]
fn overlay_state(control: tauri::State<'_, Arc<Control>>) -> serde_json::Value {
    control.overlay.lock().unwrap().payload.clone()
}

#[tauri::command]
async fn overlay_action(
    action: String,
    app: AppHandle,
    control: tauri::State<'_, Arc<Control>>,
) -> Result<(), String> {
    overlay::action(action, app, control.inner().clone()).await
}

#[tauri::command]
fn captions_snapshot(
    control: tauri::State<'_, Arc<Control>>,
    limit: Option<usize>,
) -> serde_json::Value {
    control
        .shared
        .lock()
        .unwrap()
        .clone()
        .caption_snapshot(limit.unwrap_or(6).clamp(1, 400))
}

#[tauri::command]
fn set_live_translation_target(
    target_language: Option<String>,
    control: tauri::State<'_, Arc<Control>>,
) -> Result<(), String> {
    if let Some(language) = target_language.as_deref() {
        if !captions::supports_translation_language(language) {
            return Err("Unsupported translation language".into());
        }
    }
    let shared = control.shared.lock().unwrap().clone();
    if !shared.live_translation || !shared.running.load(Ordering::Relaxed) {
        return Err("Live Translation is not active".into());
    }
    *shared.translation_target.lock().unwrap() = target_language.clone();
    if let Some(captions) = shared.captions.lock().unwrap().clone() {
        captions.set_target_language(target_language);
    }
    Ok(())
}

#[tauri::command]
async fn translate_live_caption(
    caption_id: u64,
    source_text: String,
    target_language: String,
    session: String,
    control: tauri::State<'_, Arc<Control>>,
) -> Result<(), String> {
    if caption_id == 0
        || source_text.trim().is_empty()
        || source_text.chars().count() > 10_000
        || !captions::supports_translation_language(&target_language)
        || session.len() > 128
    {
        return Err("Invalid live translation request".into());
    }
    let control = control.inner().clone();
    let shared = control.shared.lock().unwrap().clone();
    if !shared.running.load(Ordering::Relaxed)
        || !shared.live_translation
        || shared.meeting.lock().unwrap().as_deref() != Some(session.as_str())
        || shared.translation_target.lock().unwrap().as_deref() != Some(target_language.as_str())
    {
        return Ok(());
    }

    let request_text = source_text.clone();
    let request_language = target_language.clone();
    let translated = tauri::async_runtime::spawn_blocking(move || {
        let response = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(45))
            .build()
            .post("http://127.0.0.1:8057/dictation/translate")
            .send_json(serde_json::json!({
                "text": request_text,
                "target_language": request_language,
            }))
            .map_err(|_| {
                "Live translation is unavailable. Check TINA Agent settings.".to_string()
            })?;
        use std::io::Read;
        let mut reader = response.into_reader();
        let mut encoded = Vec::new();
        reader
            .by_ref()
            .take(256 * 1024)
            .read_to_end(&mut encoded)
            .map_err(|_| "Live translation returned an invalid response.".to_string())?;
        let body: serde_json::Value = serde_json::from_slice(&encoded)
            .map_err(|_| "Live translation returned an invalid response.".to_string())?;
        body["translated_text"]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty() && text.chars().count() <= 50_000)
            .map(str::to_string)
            .ok_or_else(|| "Live translation returned an invalid response.".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let current = control.shared.lock().unwrap().clone();
    if !current.running.load(Ordering::Relaxed)
        || !current.live_translation
        || current.meeting.lock().unwrap().as_deref() != Some(session.as_str())
        || current.translation_target.lock().unwrap().as_deref() != Some(target_language.as_str())
    {
        return Ok(());
    }
    if let Some(captions) = current.captions.lock().unwrap().clone() {
        captions.set_translation(caption_id, &source_text, &target_language, translated);
    }
    Ok(())
}

#[tauri::command]
fn toggle_subtitles(app: AppHandle, control: tauri::State<'_, Arc<Control>>) -> bool {
    let shared = control.shared.lock().unwrap().clone();
    if !shared.running.load(Ordering::Relaxed) || shared.dictation {
        control.subtitles.store(false, Ordering::Relaxed);
        overlay::set_subtitles(&app, false);
        return false;
    }
    let next = !control.subtitles.load(Ordering::Relaxed);
    control.subtitles.store(next, Ordering::Relaxed);
    overlay::set_subtitles(&app, next);
    next
}

#[tauri::command]
fn pause_capture(control: tauri::State<'_, Arc<Control>>) -> Result<(), String> {
    let shared = control.shared.lock().unwrap().clone();
    if !shared.running.load(Ordering::Relaxed) {
        return Err("Capture is not running".into());
    }
    shared.pause();
    Ok(())
}

#[tauri::command]
fn resume_capture(control: tauri::State<'_, Arc<Control>>) -> Result<(), String> {
    let shared = control.shared.lock().unwrap().clone();
    if !shared.running.load(Ordering::Relaxed) {
        return Err("Capture is not running".into());
    }
    shared.resume();
    Ok(())
}

pub(crate) async fn start_session(
    microphone: bool,
    system_audio: bool,
    dictation: bool,
    live_translation: bool,
    translation_target: Option<String>,
    app: AppHandle,
    control: Arc<Control>,
) -> Result<bool, String> {
    let paste_to_active_app = dictation
        && !app
            .get_webview_window("main")
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        if !microphone && !system_audio {
            return Err("Choose at least one audio source".into());
        }
        if dictation && !microphone {
            return Err("Dictation requires the microphone source".into());
        }
        if dictation && live_translation {
            return Err("Dictation cannot start a Live Translation session".into());
        }
        if translation_target.is_some() && !live_translation {
            return Err("A translation target requires a Live Translation session".into());
        }
        if translation_target
            .as_deref()
            .is_some_and(|language| !captions::supports_translation_language(language))
        {
            return Err("Unsupported translation language".into());
        }
        let mut session = control.session.lock().unwrap();
        if let Some(previous) = session.take() {
            if previous.stop.running.load(Ordering::Relaxed) {
                *session = Some(previous);
                return Err("Capture is already running".into());
            }
            let _ = previous.worker.join();
        }
        overlay::set_subtitles(&app, false);
        let shared = Arc::new(Shared::new(
            microphone,
            system_audio,
            dictation,
            live_translation,
            translation_target,
        ));
        shared.running.store(true, Ordering::Relaxed);
        *control.shared.lock().unwrap() = shared.clone();
        control.subtitles.store(false, Ordering::Relaxed);
        let worker_state = shared.clone();
        let worker = std::thread::spawn(move || {
            if let Err(e) = capture::run(microphone, system_audio, worker_state.clone()) {
                *worker_state.error.lock().unwrap() = Some(format!("{e:#}"));
            }
            if let Some(captions) = worker_state.captions.lock().unwrap().take() {
                captions.stop();
            }
            worker_state.running.store(false, Ordering::Relaxed);
            worker_state.capturing.store(false, Ordering::Relaxed);
            worker_state.resume();
        });
        *session = Some(Session {
            stop: shared,
            worker,
        });
        Ok(paste_to_active_app)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_capture(
    microphone: bool,
    system_audio: bool,
    dictation: bool,
    live_translation: bool,
    translation_target: Option<String>,
    app: AppHandle,
    control: tauri::State<'_, Arc<Control>>,
) -> Result<bool, String> {
    if !dictation {
        *control.sources.lock().unwrap() = Sources {
            microphone,
            system_audio,
        };
    }
    start_session(
        microphone,
        system_audio,
        dictation,
        live_translation,
        translation_target,
        app,
        control.inner().clone(),
    )
    .await
}

pub(crate) fn stop_session(control: &Arc<Control>) -> Result<(), String> {
    let session = control.session.lock().unwrap().take();
    control.subtitles.store(false, Ordering::Relaxed);
    let mut stopped_meeting = false;
    if let Some(session) = session {
        stopped_meeting = !session.stop.dictation;
        session.stop.request_stop();
        let _ = session.worker.join();
    }
    // A deliberate stop must not immediately re-offer the same meeting. The
    // session id changes when the app reacquires the mic, so a real new call
    // still surfaces. Dictation must not silence the suggestion.
    if stopped_meeting {
        let apps = meeting::snapshot();
        control.overlay.lock().unwrap().dismiss(&apps);
    }
    Ok(())
}

fn request_exit_stop(control: &Control) -> bool {
    // ExitRequested runs on the UI event loop; never wait for capture locks here.
    let Ok(session) = control.session.try_lock() else {
        return false;
    };
    if let Some(session) = session.as_ref() {
        session.stop.stop.store(true, Ordering::Relaxed);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod exit_tests {
    use super::{request_exit_stop, Control, Session, Shared};
    use std::sync::{atomic::Ordering, mpsc, Arc};
    use std::time::Duration;

    #[test]
    fn exit_request_signals_capture_without_joining_the_worker() {
        let control = Control::default();
        let shared = Arc::new(Shared::default());
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = release_rx.recv();
        });
        *control.session.lock().unwrap() = Some(Session {
            stop: shared.clone(),
            worker,
        });

        assert!(request_exit_stop(&control));
        assert!(shared.stop.load(Ordering::Relaxed));

        release_tx.send(()).unwrap();
        control
            .session
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .worker
            .join()
            .unwrap();
    }

    #[test]
    fn exit_request_does_not_wait_for_the_session_lock() {
        let control = Arc::new(Control::default());
        let session_guard = control.session.lock().unwrap();
        let request_control = control.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let request = std::thread::spawn(move || {
            done_tx.send(request_exit_stop(&request_control)).unwrap();
        });

        assert!(!done_rx.recv_timeout(Duration::from_secs(2)).unwrap());
        drop(session_guard);
        request.join().unwrap();
    }
}

#[tauri::command]
async fn stop_capture(
    app: AppHandle,
    control: tauri::State<'_, Arc<Control>>,
) -> Result<(), String> {
    let control = control.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = stop_session(&control);
        overlay::set_subtitles(&app, false);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_transcript(control: tauri::State<'_, Arc<Control>>) -> Result<String, String> {
    let meeting = control
        .shared
        .lock()
        .unwrap()
        .meeting
        .lock()
        .unwrap()
        .clone()
        .ok_or("There is no captured session to save.")?;
    tauri::async_runtime::spawn_blocking(move || write_notes(&meeting))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("The saved file no longer exists.".into());
    }
    reveal_in_folder(&path)
}

fn reveal_in_folder(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer.exe")
        .arg("/select,")
        .arg(path)
        .spawn()
        .map_err(|_| "Could not open Explorer.".to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|_| "Could not open Finder.".to_string())?;
    Ok(())
}

fn capture_app_bundle_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    return std::env::current_exe().map_err(|e| format!("Could not locate TINA Capture: {e}"));
    #[cfg(not(target_os = "windows"))]
    std::env::current_exe()
        .map_err(|e| format!("Could not locate TINA Capture: {e}"))?
        .ancestors()
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        .map(PathBuf::from)
        .ok_or_else(|| "TINA Capture must be launched from its app bundle.".into())
}

#[tauri::command]
fn capture_app_path() -> Result<String, String> {
    capture_app_bundle_path().map(|path| path.display().to_string())
}

#[tauri::command]
fn reveal_capture_app() -> Result<(), String> {
    let path = capture_app_bundle_path()?;
    reveal_in_folder(&path)
}

#[tauri::command]
fn paste_active_app() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos_paste::paste();

    #[cfg(not(target_os = "macos"))]
    Err("Automatic text insertion is only available on macOS".into())
}

#[tauri::command]
async fn insert_text_to_active_app(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Ok(());
    }
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(trimmed)
        .map_err(|e| format!("Clipboard error: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(60));
        #[cfg(target_os = "macos")]
        return macos_paste::paste();
        #[cfg(not(target_os = "macos"))]
        Err("Automatic text insertion is only available on macOS".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn permissions_status() -> serde_json::Value {
    #[cfg(target_os = "windows")]
    return serde_json::json!({"platform": "windows", "accessibility": false, "microphone": "not-determined", "screenAudio": true});
    #[cfg(target_os = "macos")]
    return serde_json::json!({
        "accessibility": macos_paste::has_accessibility_access(),
        "microphone": macos_permissions::microphone_status(),
        "screenAudio": capture::has_screen_audio_access(),
    });

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    serde_json::json!({"accessibility": false, "microphone": "unsupported", "screenAudio": false})
}

#[tauri::command]
fn open_privacy_settings(section: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let uri = match section.as_str() {
            "microphone" => "ms-settings:privacy-microphone",
            "screen-audio" => "ms-settings:sound",
            _ => return Err("This permission is not used by Windows Capture".into()),
        };
        std::process::Command::new("explorer.exe")
            .arg(uri)
            .spawn()
            .map_err(|e| format!("Could not open Windows Settings: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let pane = match section.as_str() {
            "accessibility" => "Privacy_Accessibility",
            "microphone" => "Privacy_Microphone",
            "screen-audio" => "Privacy_ScreenCapture",
            _ => return Err("Unknown privacy setting".into()),
        };
        std::process::Command::new("open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{pane}"
            ))
            .spawn()
            .map_err(|e| format!("Could not open System Settings: {e}"))?;
        Ok(())
    }
}

#[tauri::command]
fn fn_shortcut_status() -> &'static str {
    fn_key::status()
}

fn write_notes(meeting: &str) -> Result<String, String> {
    use std::io::Read;
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .build()
        .get(&format!("http://127.0.0.1:8056/transcripts/{meeting}"))
        .call()
        .map_err(|_| "TINA Desktop did not return the transcript.".to_string())?;
    let data: serde_json::Value =
        serde_json::from_reader(response.into_reader().take(16 * 1024 * 1024))
            .map_err(|_| "The transcript is invalid.".to_string())?;
    let segments = data["segments"].as_array().cloned().unwrap_or_default();
    let captured = chrono::Local::now();
    let mut body = String::new();
    body.push_str("# TINA meeting notes\n\n");
    body.push_str(&format!(
        "- **Captured:** {}\n",
        captured.format("%Y-%m-%d %H:%M")
    ));
    body.push_str(&format!("- **Session:** `{meeting}`\n"));
    body.push_str(&format!("- **Segments:** {}\n\n", segments.len()));
    body.push_str("## Transcript\n\n");
    if segments.is_empty() {
        body.push_str("_No speech was transcribed in this session._\n");
    }
    for segment in segments.iter().take(5000) {
        let text = escape_markdown(segment["text"].as_str().unwrap_or("").trim());
        if text.is_empty() {
            continue;
        }
        let start = segment["start"].as_f64().unwrap_or(0.0).max(0.0);
        let speaker = escape_markdown(segment["speaker"].as_str().unwrap_or("Audio"));
        body.push_str(&format!(
            "**[{}] {speaker}**\n\n{text}\n\n",
            clock_label(start)
        ));
    }
    let home = std::env::var_os(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .map(PathBuf::from)
    .ok_or("Cannot locate the home directory.")?;
    let downloads = home.join("Downloads");
    let directory = if downloads.is_dir() { downloads } else { home };
    let stem = format!("TINA meeting {}", captured.format("%Y-%m-%d %H-%M-%S"));
    let path = write_note_without_overwrite(&directory, &stem, &body)
        .map_err(|e| format!("Could not save the transcript: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn escape_markdown(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if character.is_ascii_punctuation() {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn write_note_without_overwrite(
    directory: &std::path::Path,
    stem: &str,
    body: &str,
) -> std::io::Result<PathBuf> {
    use std::fs::OpenOptions;
    use std::io::Write;

    let mut suffix = 0u32;
    loop {
        let filename = if suffix == 0 {
            format!("{stem}.md")
        } else {
            format!("{stem} ({suffix}).md")
        };
        let path = directory.join(filename);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(body.as_bytes()) {
                    let _ = std::fs::remove_file(&path);
                    return Err(error);
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                suffix = suffix.checked_add(1).ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::AlreadyExists,
                        "too many transcript exports",
                    )
                })?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn clock_label(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "—".into();
    }
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis((seconds * 1000.0).round() as i64)
        .map(|time| {
            time.with_timezone(&chrono::Local)
                .format("%H:%M:%S")
                .to_string()
        })
        .unwrap_or_else(|| "—".into())
}

#[cfg(target_os = "macos")]
mod macos_paste {
    use std::ffi::c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    pub fn has_accessibility_access() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceCreate(state_id: u32) -> *const c_void;
        fn CGEventCreateKeyboardEvent(
            source: *const c_void,
            virtual_key: u16,
            key_down: bool,
        ) -> *const c_void;
        fn CGEventSetFlags(event: *const c_void, flags: u64);
        fn CGEventPost(tap: u32, event: *const c_void);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }

    pub fn paste() -> Result<(), String> {
        if !has_accessibility_access() {
            return Err(
                "Transcript copied. Enable TINA Capture in System Settings → Privacy & Security → Accessibility to paste automatically.".into(),
            );
        }

        unsafe {
            let source = CGEventSourceCreate(1);
            if source.is_null() {
                return Err("Could not create a keyboard event source".into());
            }
            let down = CGEventCreateKeyboardEvent(source, 9, true); // V
            let up = CGEventCreateKeyboardEvent(source, 9, false);
            if down.is_null() || up.is_null() {
                if !down.is_null() {
                    CFRelease(down);
                }
                if !up.is_null() {
                    CFRelease(up);
                }
                CFRelease(source);
                return Err("Could not create the paste shortcut".into());
            }
            const COMMAND: u64 = 1 << 20;
            CGEventSetFlags(down, COMMAND);
            CGEventSetFlags(up, COMMAND);
            CGEventPost(0, down);
            std::thread::sleep(std::time::Duration::from_millis(20));
            CGEventPost(0, up);
            CFRelease(down);
            CFRelease(up);
            CFRelease(source);
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos_permissions {
    use std::ffi::{c_char, c_void};

    #[link(name = "AVFoundation", kind = "framework")]
    unsafe extern "C" {
        static AVMediaTypeAudio: *mut c_void;
    }

    #[link(name = "objc", kind = "dylib")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn authorization_status(
            class: *mut c_void,
            selector: *mut c_void,
            media_type: *mut c_void,
        ) -> isize;
    }

    pub fn microphone_status() -> &'static str {
        let (class, selector) = unsafe {
            (
                objc_getClass(b"AVCaptureDevice\0".as_ptr().cast()),
                sel_registerName(b"authorizationStatusForMediaType:\0".as_ptr().cast()),
            )
        };
        if class.is_null() || selector.is_null() || unsafe { AVMediaTypeAudio.is_null() } {
            return "unavailable";
        }
        match unsafe { authorization_status(class, selector, AVMediaTypeAudio) } {
            0 => "not-determined",
            1 => "restricted",
            2 => "denied",
            3 => "authorized",
            _ => "unknown",
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(Control::default()))
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            fn_key::start(app.handle().clone());
            meeting::start();
            let control = app.state::<Arc<Control>>().inner().clone();
            overlay::start(app.handle().clone(), control);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_capture,
            stop_capture,
            capture_status,
            capture_transcript,
            transcription_config,
            polish_dictation,
            pause_capture,
            resume_capture,
            captions_snapshot,
            set_live_translation_target,
            translate_live_caption,
            overlay_state,
            overlay_action,
            toggle_subtitles,
            export_transcript,
            reveal_path,
            capture_app_path,
            reveal_capture_app,
            permissions_status,
            open_privacy_settings,
            fn_shortcut_status,
            paste_active_app,
            insert_text_to_active_app
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api: _api, .. } = event {
                // The main window is the control surface, not the session. Hide it
                // so an active capture and its floating overlay keep running;
                // Dock/Cmd+Tab reopens it through RunEvent::Reopen.
                if window.label() == "main" {
                    #[cfg(target_os = "windows")]
                    {
                        window.app_handle().exit(0);
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        _api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Cannot build TINA Capture")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                // ExitRequested runs on the main event loop; request stop without
                // waiting for ScreenCaptureKit or the capture worker to finish.
                let control = app.state::<Arc<Control>>();
                let _ = request_exit_stop(control.inner());
            }
            _ => {}
        });
}
