"use client";
/** useGatewayWS — ONE shared WebSocket to the gateway `/ws`, carrying user-scoped meeting-status frames.
 *
 *  The gateway resolves the user_id from the api_key at connect (Track ①) and auto-subscribes the socket
 *  to `u:{user_id}:meetings` — so the client just opens the socket; no `subscribe` frame is sent. Each
 *  frame is the `meeting.status` data message (ws.v1). Per §C.1 the user-channel frame is additive: it
 *  carries the flat fields `{meeting_id, native, status, when}` AND may keep the legacy nested shape
 *  `{meeting:{id,native_id}, payload:{status}, ts}` — we read either.
 *
 *  Transport: the browser connects KEYLESS to same-origin `/ws`. The custom Next server (server.mjs)
 *  intercepts the upgrade, opens a server-side socket to the gateway with the `x-api-key` header, and
 *  pipes frames — so the api_key never appears in any client-visible URL. Reconnect with capped
 *  backoff; the consumer re-seeds via one `GET /api/meetings` snapshot on each (re)connect.
 */

export interface MeetingStatusFrame {
  meeting_id?: number | string;
  native?: string;
  status: string;        // raw meeting-api status
  when?: string;
  auto_retry?: { state: string; attempt: number; max_attempts: number; next_at?: string };
}

type Listener = (f: MeetingStatusFrame) => void;
type ConnListener = (connected: boolean) => void;

let ws: WebSocket | null = null;
let starting = false;
let retry = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();
const connListeners = new Set<ConnListener>();
let connected = false;

function setConnected(v: boolean) {
  if (connected === v) return;
  connected = v;
  connListeners.forEach((f) => f(v));
}

/** Normalise either the flat (§C.1) or legacy-nested (§0.2) meeting.status shape to a flat frame.
 *  Exported (additive — no runtime behavior change) so the contract-conformance test can pin it to
 *  the ws.v1 golden frame. */
export function parseFrame(data: unknown): MeetingStatusFrame | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (o.type !== "meeting.status") return null;
  const meeting = (o.meeting ?? {}) as Record<string, unknown>;
  const payload = (o.payload ?? {}) as Record<string, unknown>;
  const status = (o.status ?? payload.status) as string | undefined;
  if (!status) return null;
  const meeting_id = (o.meeting_id ?? meeting.id) as number | string | undefined;
  const native = (o.native ?? meeting.native_id) as string | undefined;
  const when = (o.when ?? o.ts) as string | undefined;
  const retry = o.auto_retry as Record<string, unknown> | undefined;
  const auto_retry = retry && typeof retry.state === "string"
    && Number.isSafeInteger(retry.attempt) && Number.isSafeInteger(retry.max_attempts)
    ? retry as MeetingStatusFrame["auto_retry"] : undefined;
  return { meeting_id, native, status, when, ...(auto_retry ? { auto_retry } : {}) };
}

export function parseRevisionFrame(data: unknown): { meetingId: string; segmentId: string; revision: number } | null {
  if (!data || typeof data !== 'object') return null;
  const e = data as Record<string, unknown>;
  const isSpeaker = e.type === 'speaker.revised' && e.version === 'speaker-revision.v1';
  const isMemory = e.type === 'meeting.memory.updated' && e.version === 'meeting-memory-revision.v1';
  const isNotes = e.type === 'meeting.notes.updated' && e.version === 'processed-notes.v1';
  const subject = isNotes ? 'notes' : isMemory ? 'memory' : isSpeaker && typeof e.speaker_id === 'string' && e.speaker_id
    ? `speaker:${e.speaker_id}` : e.segment_id;
  if ((!isNotes && !isMemory && !isSpeaker && (e.type !== 'transcript.revised' || e.version !== 'transcript-revision.v1'))
      || !Number.isSafeInteger(e.meeting_id) || Number(e.meeting_id) < 1
      || typeof subject !== 'string' || !subject || !Number.isSafeInteger(e.revision) || Number(e.revision) < 1) return null;
  return { meetingId: String(e.meeting_id), segmentId: subject, revision: Number(e.revision) };
}

/** Open the ONE shared socket. The `ws`/`starting` guards make this idempotent, so the many
 *  components mounting `useGatewayWS` collapse onto a single socket no matter how often they call it.
 *  Connects KEYLESS to same-origin `/ws` — the custom server (server.mjs) injects the api_key
 *  server-side on the upgrade to the gateway. */
function connect() {
  if (typeof window === "undefined" || ws || starting) return;
  if (listeners.size === 0) return;            // only (re)connect when someone is listening
  starting = true;
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}/ws`);
    ws = sock;
    sock.onopen = () => { retry = 0; setConnected(true); };
    const revisions = new Map<string, number>();
    sock.onmessage = (m) => {
      let data: unknown;
      try { data = JSON.parse(typeof m.data === "string" ? m.data : ""); } catch { return; }
      const revision = parseRevisionFrame(data);
      if (revision) {
        const key = `${revision.meetingId}/${revision.segmentId}`;
        if (revision.revision <= (revisions.get(key) ?? 0)) return;
        revisions.set(key, revision.revision);
        window.dispatchEvent(new CustomEvent('tina:transcript-corrected', { detail: revision }));
        return;
      }
      const f = parseFrame(data);
      if (f) listeners.forEach((fn) => fn(f));
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      setConnected(false);
      scheduleReconnect();
    };
    sock.onerror = () => { try { sock.close(); } catch { /* noop */ } };
  } catch {
    ws = null;
    scheduleReconnect();
  } finally {
    starting = false;
  }
}

function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect() {
  if (reconnectTimer || listeners.size === 0) return;
  const delay = Math.min(1000 * 2 ** retry, 30000);  // 1s, 2s, 4s … capped at 30s
  retry += 1;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

/** Subscribe to meeting.status frames. Returns an unsubscribe fn; opens the socket on first subscriber. */
export function onMeetingStatus(fn: Listener): () => void {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      clearReconnect();                          // kill any pending reconnect on the last unsubscribe
      retry = 0;
      if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
    }
  };
}

/** Subscribe to connection-state changes (true once the socket is open). Fires the current state once. */
export function onGatewayWSConnected(fn: ConnListener): () => void {
  connListeners.add(fn);
  fn(connected);
  return () => { connListeners.delete(fn); };
}

export function isGatewayWSConnected(): boolean {
  return connected;
}
