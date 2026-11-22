import { detectMeeting } from './meeting';
import { readMeetAvatars } from './meet-avatars';

const COACHMARK_KEY = 'meetPanelCoachmarkDismissed';
const LAUNCHER_POSITION_KEY = 'meetLauncherPosition';
const MEET_LAUNCHER_SLOT = 'browser-extension-end-buttons';
const LAUNCHER_SIZE = 44;
type LauncherPosition = { x: number; y: number };
const defaultLauncherPosition: LauncherPosition = { x: 0, y: .4 };

// A re-injected extension build takes ownership from the previous content script.
try { (window as any).__tinaMeetOverlayTeardown?.(); } catch { /* previous build already gone */ }

let currentMeetId: string | null = null;
const meetAvatarCache = new Map<string, string>();
let buttonHost: HTMLDivElement | null = null;
let panelFrame: HTMLIFrameElement | null = null;
let observer: MutationObserver | null = null;
let routeTimer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
type PanelBounds = { left: number; top: number; width: number; height: number };
type PanelGesture = { kind: 'move' | 'resize'; screenX: number; screenY: number; start: PanelBounds };
let panelBounds: PanelBounds | null = null;
let panelGesture: PanelGesture | null = null;
let launcherPosition: LauncherPosition | null = null;

const unit = (value: number): number => Math.max(0, Math.min(1, value));

function launcherTravel(): { x: number; y: number } {
  return {
    x: Math.max(0, innerWidth - LAUNCHER_SIZE),
    y: Math.max(0, innerHeight - LAUNCHER_SIZE),
  };
}

function launcherParent(): HTMLElement {
  const slot = launcherPosition === null ? document.getElementById(MEET_LAUNCHER_SLOT) : null;
  return slot?.getClientRects().length ? slot : document.documentElement;
}

function positionLauncher(): void {
  if (!buttonHost) return;
  const parent = launcherParent();
  const docked = parent !== document.documentElement;
  buttonHost.toggleAttribute('data-docked', docked);
  if (buttonHost.parentElement !== parent) parent.append(buttonHost);
  let left: number;
  let top: number;
  if (docked) {
    buttonHost.style.removeProperty('left');
    buttonHost.style.removeProperty('top');
    ({ left, top } = buttonHost.getBoundingClientRect());
  } else {
    const travel = launcherTravel();
    const position = launcherPosition ?? defaultLauncherPosition;
    left = launcherPosition ? travel.x * position.x : Math.min(16, travel.x);
    top = travel.y * position.y;
    buttonHost.style.setProperty('left', `${left}px`, 'important');
    buttonHost.style.setProperty('top', `${top}px`, 'important');
  }
  const guideWidth = Math.min(300, innerWidth - 24);
  const guideLeft = Math.max(12, Math.min(innerWidth - guideWidth - 12, left));
  buttonHost.style.setProperty('--guide-left', `${guideLeft - left}px`);
  buttonHost.style.setProperty('--guide-pointer', `${left - guideLeft + 16}px`);
  buttonHost.toggleAttribute('data-guide-below', top < 158);
}

function moveLauncher(left: number, top: number): void {
  const travel = launcherTravel();
  const position = launcherPosition ?? defaultLauncherPosition;
  launcherPosition = {
    x: travel.x ? unit(left / travel.x) : position.x,
    y: travel.y ? unit(top / travel.y) : position.y,
  };
  positionLauncher();
}

function saveLauncherPosition(): void {
  try {
    void chrome.storage.local.set({ [LAUNCHER_POSITION_KEY]: launcherPosition }).catch(handleExtensionContextError);
  } catch (error) { handleExtensionContextError(error); }
}

function connectLauncherControls(button: HTMLButtonElement, host: HTMLDivElement): void {
  let drag: { id: number; x: number; y: number; left: number; top: number; start: LauncherPosition | null } | null = null;
  let moved = false;
  button.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const { left, top } = host.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left, top, start: launcherPosition };
    moved = false;
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    if (!moved) {
      moved = true;
      host.setAttribute('data-dragging', '');
      dismissCoachmark();
    }
    const parent = host.parentElement;
    moveLauncher(drag.left + dx, drag.top + dy);
    if (parent !== host.parentElement) button.setPointerCapture(event.pointerId);
  });
  const finish = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    if (moved) {
      if (event.type === 'pointerup') saveLauncherPosition();
      else {
        launcherPosition = drag.start;
        positionLauncher();
      }
    }
    drag = null;
    host.removeAttribute('data-dragging');
  };
  button.addEventListener('pointerup', finish);
  button.addEventListener('pointercancel', finish);
  button.addEventListener('lostpointercapture', finish);
  button.addEventListener('click', event => {
    if (moved && event.detail !== 0) return;
    if (panelFrame?.isConnected) closePanel();
    else openPanel();
  });
  button.addEventListener('keydown', event => {
    if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      launcherPosition = null;
      positionLauncher();
      button.focus({ preventScroll: true });
      saveLauncherPosition();
      return;
    }
    const step = event.shiftKey ? 32 : 8;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    event.stopPropagation();
    const { left, top } = host.getBoundingClientRect();
    dismissCoachmark();
    moveLauncher(left + dx, top + dy);
    button.focus({ preventScroll: true });
    saveLauncherPosition();
  });
}

function dismissCoachmark(): void {
  if (!buttonHost) return;
  buttonHost.shadowRoot?.querySelector('.coachmark')?.setAttribute('hidden', '');
  try {
    void chrome.storage.local.set({ [COACHMARK_KEY]: true }).catch(handleExtensionContextError);
  } catch (error) { handleExtensionContextError(error); }
}

function closePanel(): void {
  panelFrame?.remove();
  panelFrame = null;
  panelGesture = null;
  window.removeEventListener('resize', sizePanelFrame);
  buttonHost?.shadowRoot?.querySelector('.tina-button')?.setAttribute('aria-expanded', 'false');
}

function clampPanelBounds(bounds: PanelBounds): PanelBounds {
  const compact = innerWidth <= 520;
  const gap = compact ? 8 : 14;
  const top = compact ? gap : 60;
  const bottom = compact ? 92 : 90;
  const maxWidth = Math.max(240, Math.min(640, innerWidth - gap * 2));
  const minWidth = Math.min(compact ? 280 : 300, maxWidth);
  const maxHeight = Math.max(280, innerHeight - top - bottom);
  const minHeight = Math.min(280, maxHeight);
  const width = Math.max(minWidth, Math.min(maxWidth, bounds.width));
  const height = Math.max(minHeight, Math.min(maxHeight, bounds.height));
  return {
    left: Math.max(gap, Math.min(innerWidth - gap - width, bounds.left)),
    top: Math.max(top, Math.min(innerHeight - bottom - height, bounds.top)),
    width,
    height,
  };
}

function applyPanelBounds(bounds: PanelBounds): void {
  if (!panelFrame) return;
  panelBounds = clampPanelBounds(bounds);
  panelFrame.style.setProperty('left', `${panelBounds.left}px`, 'important');
  panelFrame.style.setProperty('top', `${panelBounds.top}px`, 'important');
  panelFrame.style.setProperty('right', 'auto', 'important');
  panelFrame.style.setProperty('width', `${panelBounds.width}px`, 'important');
  panelFrame.style.setProperty('height', `${panelBounds.height}px`, 'important');
}

function retireInvalidatedContext(): void {
  if (disposed) return;
  disposed = true;
  if (routeTimer) clearInterval(routeTimer);
  routeTimer = undefined;
  observer?.disconnect();
  observer = null;
  meetAvatarCache.clear();
  closePanel();
  window.removeEventListener('message', onPanelMessage);
  const shadow = buttonHost?.shadowRoot;
  const button = shadow?.querySelector<HTMLButtonElement>('.tina-button');
  if (button) {
    button.disabled = true;
    button.title = 'Tải lại tab Meet để kết nối TINA';
    button.setAttribute('aria-label', 'Tải lại tab Meet để kết nối TINA');
  }
  const guide = shadow?.querySelector<HTMLElement>('.coachmark');
  const title = guide?.querySelector<HTMLElement>('.coachmark-title');
  if (guide && title) {
    title.textContent = 'Extension đã được cập nhật. Tải lại tab Meet để tiếp tục.';
    guide.removeAttribute('hidden');
    guide.querySelector('.dismiss')?.remove();
    guide.querySelector('.got-it')?.remove();
    const footer = guide.querySelector('.coachmark-foot');
    if (footer) footer.textContent = 'Tải lại tab Meet';
  }
}

function handleExtensionContextError(error: unknown): void {
  if (String(error).includes('Extension context invalidated')) retireInvalidatedContext();
}

function sizePanelFrame(): void {
  if (!panelFrame) return;
  const compact = innerWidth <= 520;
  const gap = compact ? 8 : 14;
  const top = compact ? gap : 60;
  const bottom = compact ? 92 : 90;
  const availableHeight = Math.max(280, innerHeight - top - bottom);
  panelFrame.style.setProperty('position', 'fixed', 'important');
  panelFrame.style.setProperty('z-index', '2147483646', 'important');
  panelFrame.style.setProperty('box-sizing', 'border-box', 'important');
  panelFrame.style.setProperty('border', '1px solid var(--line, #D3DED5)', 'important');
  panelFrame.style.setProperty('border-radius', '14px', 'important');
  panelFrame.style.setProperty('background', 'var(--canvas, #F7F8F3)', 'important');
  panelFrame.style.setProperty('box-shadow', '0 16px 54px rgb(0 0 0 / .34)', 'important');
  panelFrame.style.setProperty('pointer-events', 'auto', 'important');
  panelBounds ??= {
    left: innerWidth - gap - Math.min(compact ? Math.max(280, innerWidth - gap * 2) : 410, innerWidth - gap * 2),
    top,
    width: compact ? Math.max(280, innerWidth - gap * 2) : Math.min(410, innerWidth - gap * 2),
    height: compact ? availableHeight : Math.min(640, availableHeight),
  };
  applyPanelBounds(panelBounds);
}

function openPanel(): void {
  if (!currentMeetId || panelFrame?.isConnected) return;
  panelFrame = null;
  let panelUrl: string;
  try { panelUrl = chrome.runtime.getURL('meet-panel.html'); }
  catch { retireInvalidatedContext(); return; }
  dismissCoachmark();
  if (disposed) return;
  const frame = document.createElement('iframe');
  frame.dataset.tinaMeetPanel = 'true';
  frame.title = 'TINA meeting transcript';
  frame.referrerPolicy = 'no-referrer';
  frame.allow = 'clipboard-write';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reducedMotion) {
    frame.style.setProperty('opacity', '0', 'important');
    frame.style.setProperty('transform', 'translateY(8px)', 'important');
    frame.style.setProperty('transition', 'opacity 160ms ease, transform 160ms ease', 'important');
  }
  const url = new URL(panelUrl);
  url.searchParams.set('meet', currentMeetId);
  url.searchParams.set('parentOrigin', location.origin);
  frame.src = url.href;
  panelFrame = frame;
  sizePanelFrame();
  document.documentElement.append(frame);
  window.addEventListener('resize', sizePanelFrame);
  buttonHost?.shadowRoot?.querySelector('.tina-button')?.setAttribute('aria-expanded', 'true');
  if (!reducedMotion) requestAnimationFrame(() => {
    if (!frame.isConnected || panelFrame !== frame) return;
    frame.style.setProperty('opacity', '1', 'important');
    frame.style.setProperty('transform', 'translateY(0)', 'important');
  });
}

function mountButton(): void {
  if (!currentMeetId || disposed) return;
  if (!buttonHost) {
    const host = document.createElement('div');
    host.dataset.tinaMeetControl = 'true';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; z-index: 2147483647; display: inline-flex; align-items: center; margin: 0; font-family: system-ui, sans-serif; --tina-canvas:#F7F8F3; --tina-surface:#FFFFFF; --tina-ink:#173B36; --tina-muted:#526860; --tina-brand:#176B5B; --tina-brand-hover:#115447; --tina-on-brand:#FFFFFF; --tina-line:#D3DED5; --tina-focus:#176B5B; }
        :host([data-docked]) { position: relative; margin-inline-end: 8px; vertical-align: middle; }
        :host([data-dragging]) .tina-button { cursor: grabbing; }
        @media (prefers-color-scheme: dark) { :host { --tina-canvas:#0E2423; --tina-surface:#173330; --tina-ink:#ECF5EE; --tina-muted:#B6CCC0; --tina-brand:#91D7BE; --tina-brand-hover:#B5E8D1; --tina-on-brand:#0E2423; --tina-line:#3D5F55; --tina-focus:#91D7BE; } }
        * { box-sizing: border-box; }
        .tina-button { display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: var(--tina-brand); color: var(--tina-on-brand); cursor: grab; touch-action: none; user-select: none; box-shadow: 0 2px 10px rgb(0 0 0 / .28); }
        .tina-button:hover { background: var(--tina-brand-hover); }
        .tina-button:focus-visible, .coachmark button:focus-visible { outline: 3px solid var(--tina-focus); outline-offset: 3px; }
        .mark { display: grid; place-items: center; width: 26px; height: 26px; border: 2px solid currentColor; border-radius: 8px 8px 8px 2px; font: 700 15px/1 system-ui, sans-serif; }
        .coachmark { position: absolute; left: var(--guide-left, 0px); bottom: calc(100% + 14px); width: min(300px, calc(100vw - 24px)); padding: 15px; border: 1px solid var(--tina-line); border-radius: 12px; background: var(--tina-ink); color: var(--tina-canvas); box-shadow: 0 14px 36px rgb(0 0 0 / .32); }
        :host([data-guide-below]) .coachmark { top: calc(100% + 14px); bottom: auto; }
        :host([data-guide-below]) .coachmark:after { top: -7px; bottom: auto; transform: rotate(225deg); }
        .coachmark[hidden] { display: none; }
        .coachmark-title { display: block; padding-right: 22px; font-size: 15px; font-weight: 650; line-height: 1.35; }
        .coachmark-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; color: var(--tina-muted); font-size: 12px; }
        .coachmark .got-it { min-height: 34px; padding: 0 12px; border: 0; border-radius: 8px; background: var(--tina-canvas); color: var(--tina-ink); cursor: pointer; font: inherit; font-weight: 600; }
        .coachmark .dismiss { position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; border: 0; background: transparent; color: var(--tina-muted); cursor: pointer; font-size: 19px; }
        .coachmark:after { position: absolute; left: var(--guide-pointer, 16px); bottom: -7px; width: 12px; height: 12px; border-right: 1px solid var(--tina-line); border-bottom: 1px solid var(--tina-line); background: var(--tina-ink); content: ''; transform: rotate(45deg); }
      </style>
      <button class="tina-button" type="button" aria-label="Mở bảng transcript TINA" aria-expanded="false" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home" title="TINA · Kéo để di chuyển · Home để về vị trí mặc định">
        <span class="mark" aria-hidden="true">T</span>
      </button>
      <section class="coachmark" role="dialog" aria-label="Hướng dẫn TINA" hidden>
        <button class="dismiss" type="button" aria-label="Đóng hướng dẫn">×</button>
        <strong class="coachmark-title">Bấm để xem transcript. Kéo nút TINA để đổi vị trí.</strong>
        <div class="coachmark-foot"><span>1 of 1</span><button class="got-it" type="button">Đã hiểu</button></div>
      </section>`;
    connectLauncherControls(shadow.querySelector<HTMLButtonElement>('.tina-button')!, host);
    shadow.querySelector('.got-it')!.addEventListener('click', dismissCoachmark);
    shadow.querySelector('.dismiss')!.addEventListener('click', dismissCoachmark);
    buttonHost = host;
    try {
      void chrome.storage.local.get([COACHMARK_KEY, LAUNCHER_POSITION_KEY]).then(stored => {
        if (disposed || buttonHost !== host) return;
        const position = stored[LAUNCHER_POSITION_KEY];
        if (typeof position?.x === 'number' && Number.isFinite(position.x)
            && typeof position?.y === 'number' && Number.isFinite(position.y)) {
          launcherPosition ??= { x: unit(position.x), y: unit(position.y) };
          positionLauncher();
        }
        if (stored[COACHMARK_KEY] !== true) shadow.querySelector('.coachmark')?.removeAttribute('hidden');
      }).catch(handleExtensionContextError);
    } catch (error) { handleExtensionContextError(error); }
  }

  positionLauncher();
}

function updateRoute(): void {
  const meeting = detectMeeting(location.href);
  const next = meeting?.platform === 'google_meet' ? meeting.nativeMeetingId : null;
  if (next !== currentMeetId) {
    closePanel();
    meetAvatarCache.clear();
    panelBounds = null;
    buttonHost?.remove(); buttonHost = null;
    currentMeetId = next;
  }
  if (!currentMeetId || disposed) return;
  if (!buttonHost?.isConnected) mountButton();
  else if (launcherPosition === null && buttonHost.parentElement !== launcherParent()) positionLauncher();
}

function teardown(): void {
  disposed = true;
  if (routeTimer) clearInterval(routeTimer);
  observer?.disconnect();
  meetAvatarCache.clear();
  closePanel();
  buttonHost?.remove();
  window.removeEventListener('message', onPanelMessage);
  window.removeEventListener('resize', positionLauncher);
}

function onPanelMessage(event: MessageEvent): void {
  if (!panelFrame || event.source !== panelFrame.contentWindow) return;
  let extensionOrigin: string;
  try { extensionOrigin = new URL(chrome.runtime.getURL('/')).origin; }
  catch { retireInvalidatedContext(); return; }
  if (event.origin !== extensionOrigin) return;
  const message = event.data;
  if (message?.source !== 'tina-meet-panel') return;
  if (message.type === 'read-avatars' && currentMeetId && message.meet === currentMeetId
      && detectMeeting(location.href)?.nativeMeetingId === currentMeetId) {
    panelFrame.contentWindow?.postMessage({
      source: 'tina-meet-content', type: 'avatars', meet: currentMeetId,
      entries: readMeetAvatars(document, meetAvatarCache),
    }, extensionOrigin);
    return;
  }
  if (message.type === 'close') { closePanel(); return; }
  if (message.type === 'interaction-end') { panelGesture = null; return; }
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  if (message.type === 'interaction-start' && ['move', 'resize'].includes(message.kind)
      && finite(message.screenX) && finite(message.screenY)) {
    const rect = panelFrame.getBoundingClientRect();
    const start = panelBounds ?? { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    panelGesture = { kind: message.kind, screenX: message.screenX, screenY: message.screenY, start };
    return;
  }
  if (message.type === 'interaction-move' && panelGesture && finite(message.screenX) && finite(message.screenY)) {
    const dx = message.screenX - panelGesture.screenX;
    const dy = message.screenY - panelGesture.screenY;
    const { kind, start } = panelGesture;
    applyPanelBounds(kind === 'move'
      ? { ...start, left: start.left + dx, top: start.top + dy }
      : { ...start, width: start.width + dx, height: start.height + dy });
    return;
  }
  if (message.type === 'nudge' && panelBounds && ['move', 'resize'].includes(message.kind)) {
    const dx = finite(message.dx) ? message.dx : 0;
    const dy = finite(message.dy) ? message.dy : 0;
    const dw = finite(message.dw) ? message.dw : 0;
    const dh = finite(message.dh) ? message.dh : 0;
    applyPanelBounds(message.kind === 'move'
      ? { ...panelBounds, left: panelBounds.left + dx, top: panelBounds.top + dy }
      : { ...panelBounds, width: panelBounds.width + dw, height: panelBounds.height + dh });
  }
}

(window as any).__tinaMeetOverlayTeardown = teardown;
window.addEventListener('message', onPanelMessage);
window.addEventListener('resize', positionLauncher);
updateRoute();
observer = new MutationObserver(updateRoute);
observer.observe(document.documentElement, { childList: true, subtree: true });
routeTimer = setInterval(updateRoute, 1000);
