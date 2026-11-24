/** POST /api/stt[?prompt=…] — speech-to-text proxy for composer dictation.
 *
 *  Body: audio/wav (16 kHz mono PCM from ui-kit/micDictation). Forwards to the signed-in
 *  user's selected FunASR/Apple/NVIDIA/custom backend, with the deployment service as fallback.
 *  Backends use the same OpenAI-compatible /v1/audio/transcriptions contract — see
 *  @tina/transcribe-whisper's TranscriptionClient. `prompt` carries the already-
 *  confirmed text for context continuity (streaming re-submission, exactly like the
 *  meeting pipeline). Returns `{ text, words }` — word timestamps drive the client's
 *  LocalAgreement confirm/trim. The bearer token stays server-side.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE } from "../auth/adminApi";
import { resolveApiKey } from "../proxyAuth";
import { currentUser } from "../tokens/currentUser";
import { sttEndpoint } from "./endpoint";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // ~13 min of 16 kHz WAV — far beyond any dictation window

interface UpstreamWord { word?: string; start?: number; end?: number }
interface UpstreamSegment { text?: string; words?: UpstreamWord[] }

async function selectedTranscription(): Promise<{ url: string; token: string; backend?: string; model?: string }> {
  const user = await currentUser();
  if (!user.ok) {
    // A deployment key without a login cookie has no per-user preference; retain its env default.
    // A present but invalid/unverifiable cookie must not silently route to another backend.
    if ((await cookies()).get(AUTH_COOKIE)?.value) throw new Error("Could not resolve the signed-in user's ASR backend");
    const url = (process.env.TRANSCRIPTION_SERVICE_URL ?? "").replace(/\/+$/, "");
    if (!url) throw new Error("No deployment transcription endpoint is configured");
    return { url, token: process.env.TRANSCRIPTION_SERVICE_TOKEN ?? "" };
  }

  const admin = (process.env.TINA_ADMIN_API_URL ?? "").replace(/\/+$/, "");
  const secret = process.env.TINA_INTERNAL_API_SECRET ?? "";
  if (!admin || !secret) throw new Error("Identity configuration is unavailable");
  const response = await fetch(`${admin}/internal/users/${encodeURIComponent(user.userId)}/transcription`, {
    headers: { "X-Internal-Secret": secret },
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Could not resolve the selected ASR backend");
  const transcription = await response.json() as { backend?: string; url?: string; token?: string; model?: string; disabled?: boolean };
  if (transcription.disabled) throw new Error("Transcription is stopped for this account; start it in Settings");
  const backend = transcription.backend;
  if (["apple", "nvidia", "funasr", "sherpa", "viegem", "custom"].includes(backend ?? "") && !transcription.url) {
    throw new Error(`The selected ${backend} ASR backend is not configured`);
  }
  if (transcription.url) {
    return { url: transcription.url, token: transcription.token ?? "", backend, model: transcription.model };
  }
  if (backend && backend !== "deployment") throw new Error("The selected ASR backend is unavailable");

  const url = (process.env.TRANSCRIPTION_SERVICE_URL ?? "").replace(/\/+$/, "");
  if (!url) throw new Error("No deployment transcription endpoint is configured");
  return { url, token: process.env.TRANSCRIPTION_SERVICE_TOKEN ?? "", backend: "deployment", model: process.env.TRANSCRIPTION_MODEL };
}

export async function POST(req: Request): Promise<NextResponse> {
  // Auth gate: this forwards to the shared transcription service with a server-side
  // bearer token. Without a check it's an open, credentialed Whisper proxy (cost/abuse
  // vector) — require the same per-user key every other proxy route resolves.
  if (!(await resolveApiKey())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let transcription: Awaited<ReturnType<typeof selectedTranscription>>;
  try {
    transcription = await selectedTranscription();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "ASR backend unavailable" }, { status: 503 });
  }
  const endpoint = sttEndpoint(transcription.url);

  const wav = await req.arrayBuffer();
  if (wav.byteLength < 100) return NextResponse.json({ error: "Empty recording" }, { status: 400 });
  if (wav.byteLength > MAX_BYTES) return NextResponse.json({ error: "Recording too long" }, { status: 413 });

  const prompt = new URL(req.url).searchParams.get("prompt") ?? "";

  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "dictation.wav");
  // Backends that validate model IDs can use the deployment-wide model; otherwise this form
  // field is ignored by the service's configured backend model. Unset → whisper-1.
  form.append("model", transcription.model || process.env.TRANSCRIPTION_MODEL || "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities", "word");
  if (prompt) form.append("prompt", prompt.slice(0, 800));

  const headers: Record<string, string> = {};
  headers["X-ASR-Source"] = "dictation";
  headers["X-ASR-Request-ID"] = crypto.randomUUID();
  const captureMs = req.headers.get("X-ASR-Capture-Ms");
  if (captureMs != null && Number.isFinite(Number(captureMs)) && Number(captureMs) >= 0 && Number(captureMs) <= 3_600_000) {
    headers["X-ASR-Capture-Ms"] = captureMs;
  }
  if (transcription.token) headers.Authorization = `Bearer ${transcription.token}`;

  try {
    const r = await fetch(endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(30000) });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return NextResponse.json({ error: `Transcription failed (${r.status})`, detail: detail.slice(0, 300) }, { status: 502 });
    }
    const data = (await r.json()) as { text?: string; segments?: UpstreamSegment[] };
    const words = (data.segments ?? []).flatMap((s) => s.words ?? [])
      .filter((w) => typeof w.word === "string")
      .map((w) => ({ word: w.word as string, start: w.start ?? 0, end: w.end ?? 0 }));
    return NextResponse.json({ text: (data.text ?? "").trim(), words }, { headers: {
      "X-ASR-Request-ID": r.headers.get("X-ASR-Request-ID") || headers["X-ASR-Request-ID"],
      ...(r.headers.get("Server-Timing") ? { "Server-Timing": r.headers.get("Server-Timing")! } : {}),
    } });
  } catch (err) {
    const timeout = err instanceof Error && err.name === "TimeoutError";
    return NextResponse.json({ error: timeout ? "Transcription timed out" : "Transcription unreachable" }, { status: 502 });
  }
}
