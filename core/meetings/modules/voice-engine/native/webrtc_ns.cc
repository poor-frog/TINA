#include <webrtc/modules/audio_processing/include/audio_processing.h>

extern "C" {
void* tina_ns_create() {
  auto* apm = webrtc::AudioProcessing::Create();
  if (!apm) return nullptr;
  if (apm->noise_suppression()->set_level(webrtc::NoiseSuppression::kLow) != 0 ||
      apm->noise_suppression()->Enable(true) != 0) {
    delete apm;
    return nullptr;
  }
  return apm;
}

int tina_ns_process(void* state, const float* input, float* output) {
  if (!state || !input || !output) return -1;
  const float* src[] = {input};
  float* dest[] = {output};
  const webrtc::StreamConfig config(16000, 1);
  return static_cast<webrtc::AudioProcessing*>(state)->ProcessStream(src, config, config, dest);
}

int tina_ns_flags(void* state) {
  if (!state) return -1;
  auto* apm = static_cast<webrtc::AudioProcessing*>(state);
  return (apm->noise_suppression()->is_enabled() ? 1 : 0) |
         (apm->high_pass_filter()->is_enabled() ? 2 : 0) |
         (apm->gain_control()->is_enabled() ? 4 : 0) |
         (apm->echo_cancellation()->is_enabled() ? 8 : 0) |
         (apm->echo_control_mobile()->is_enabled() ? 16 : 0);
}

void tina_ns_destroy(void* state) {
  delete static_cast<webrtc::AudioProcessing*>(state);
}
}
