import { voiceActivity, voiceActivityStatus, VOICE_ACTIVITY_TTL } from './voice-activity';

export function createVoiceActivity(root: HTMLElement) {
  root.className = 'voice-activity'; root.hidden = true;
  root.setAttribute('role', 'status'); root.setAttribute('aria-live', 'polite'); root.setAttribute('aria-atomic', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('voice-wave');
  for (const d of ['M3 6v4', 'M8 3v10', 'M13 5v6']) {
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path);
  }
  const name = document.createElement('span'); name.className = 'voice-name'; name.textContent = 'TINA';
  const label = document.createElement('span'); label.className = 'voice-label';
  root.replaceChildren(svg, name, label);
  let expiry: ReturnType<typeof setTimeout> | undefined;
  function update(value: unknown, ended = false) {
    clearTimeout(expiry);
    const phase = voiceActivity(value, Date.now(), ended), status = voiceActivityStatus(value, Date.now(), ended);
    root.hidden = false;
    if (root.dataset.phase !== phase || label.textContent !== status.label) {
      root.dataset.phase = phase; root.title = status.title; label.textContent = status.label;
      root.setAttribute('aria-label', `TINA · ${status.label}`);
    }
    if (!ended && value != null) {
      const observed = (value as any)?.runtime?.kws?.observed_at_ms ?? Date.now();
      const wait = Math.max(0, Math.min(VOICE_ACTIVITY_TTL, (typeof observed === 'number' ? observed : 0) + VOICE_ACTIVITY_TTL - Date.now()));
      if (wait > 0) expiry = setTimeout(() => update(null), wait);
    }
  }
  return { update, reset() { clearTimeout(expiry); root.hidden = true; delete root.dataset.phase; } };
}
