(function (scope) {
  function normalizeAudioSource(value) {
    return ["both", "microphone", "system"].includes(value) ? value : "both";
  }

  function audioSourceFlags(value) {
    const source = normalizeAudioSource(value);
    return {
      microphone: source !== "system",
      systemAudio: source !== "microphone",
    };
  }

  function startCaptureArgs({
    microphone,
    systemAudio,
    dictation,
    liveTranslation = false,
    translationTarget = null,
  } = {}) {
    return {
      microphone: Boolean(microphone),
      systemAudio: Boolean(systemAudio),
      dictation: Boolean(dictation),
      liveTranslation: Boolean(liveTranslation),
      translationTarget: translationTarget ?? null,
    };
  }

  function shouldPlayChime(enabled, preview = false) {
    return enabled || preview;
  }

  function audioProcessingLabel(capture) {
    if (!capture.running) return "Not recording";
    if (capture.paused) return "Paused";
    const audio = capture.audio_processing;
    if (!audio) return "Waiting for capture setup";
    if (!audio.aec) return `Original mic · ${audio.fallback_reason || "Echo cancellation unavailable"}`;
    const stages = [audio.processed_blocks > 0 ? "AEC processing" : "AEC ready · waiting for aligned audio"];
    if (audio.residual_suppression) stages.push("Residual suppression");
    if (audio.high_pass_hz) stages.push(`High-pass ${audio.high_pass_hz} Hz`);
    if (audio.noise_suppression_db != null) stages.push(`Noise suppression ${audio.noise_suppression_db} dB`);
    stages.push(`${audio.processed_blocks || 0} blocks processed`);
    stages.push(`${audio.bypassed_samples || 0} samples bypassed`);
    if (audio.mic_clipped_samples > 0) stages.push(`${audio.mic_clipped_samples} mic samples clipped · lower input gain`);
    return stages.join(" · ");
  }

  function platformPresentation(platform) {
    const windows = platform === "windows";
    return {
      name: windows ? "Windows" : "macOS",
      reveal: windows ? "Show in Explorer" : "Show in Finder",
      automaticPaste: !windows,
      dictation: windows ? "Select Start dictation, speak, then Stop. Text is copied; use Ctrl+V to paste." : "Double-tap Fn for hands-free.",
      privacy: windows ? "Windows 11 · WASAPI microphone and system audio. Recording starts only when you select Start. No screen recording." : "Requires macOS 15+.",
    };
  }

  scope.TinaCaptureSettings = Object.freeze({
    platformPresentation,
    normalizeAudioSource,
    audioSourceFlags,
    startCaptureArgs,
    shouldPlayChime,
    audioProcessingLabel,
  });
})(globalThis);
