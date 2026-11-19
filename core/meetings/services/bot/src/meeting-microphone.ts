/** Serialized into the meeting page; keep every dependency inside this function. */
export async function setMeetingMicrophone({desiredOn,platform}:{desiredOn:boolean;platform:string}):Promise<boolean|undefined> {
  const doc = (globalThis as any).document;
  const findButton = (): any => {
    if (platform === 'teams') return doc?.querySelector('#microphone-button');
    if (platform === 'zoom') return doc?.querySelector('.join-audio-container__btn');
    return Array.from(doc?.querySelectorAll('[role="button"],button') ?? [])
      .find((candidate: any) => /microphone|mute audio/i.test(candidate.getAttribute('aria-label') ?? '')
        && readState(candidate) !== undefined);
  };
  const readState = (button: any): boolean | undefined => {
    if (!button) return undefined;
    const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`.toLowerCase();
    if (/problem|show more info|settings/.test(label)) return undefined;
    if (platform === 'google_meet') {
      // Meet also renders remote-participant mute controls; only self-microphone actions are authoritative.
      if (!/^(?:turn (?:on|off)|unmute|mute|enable|disable|toggle)(?: (?:the|my))? microphone\b/.test(label.trim())) return undefined;
      const muted = button.getAttribute('data-is-muted');
      if (muted === 'true' || muted === 'false') return muted === 'false';
    }
    if (/unmute|turn on.*microphone|enable microphone/.test(label)) return false;
    if (!/toggle/.test(label) && /mute|turn off.*microphone|disable microphone/.test(label)) return true;
    return undefined;
  };
  // Chromium's system-mute notification can lag after PulseAudio recovers.
  let button = findButton();
  for (let attempt = 0; !button && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50)); button = findButton();
  }
  if (!button) return undefined;
  const currentOn = readState(button);
  if (currentOn === desiredOn) return currentOn;
  if (currentOn === undefined || button.disabled || button.getAttribute('aria-disabled') === 'true') return undefined;
  button.click();
  // The meeting UI can refuse or delay a click; never synthesize against an assumed state.
  for (let attempt = 0; attempt < 20; attempt++) {
    const actual = readState(findButton());
    if (actual === desiredOn) return actual;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return undefined;
}
