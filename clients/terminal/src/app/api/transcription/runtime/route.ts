import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "../../tokens/currentUser";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

async function proxy(req: NextRequest, write: boolean) {
  if (write) {
    let refused = req.headers.get("sec-fetch-site") === "cross-site";
    try {
      const origin = req.headers.get("origin");
      if (origin) {
        const source = new URL(origin), target = new URL(req.url);
        const host = req.headers.get("host") || target.host;
        target.host = host;
        // Behind a TLS-terminating proxy, the internal request URL may still be HTTP.
        const configured = process.env.NEXTAUTH_URL || "";
        const publicUrl = URL.canParse(configured) ? new URL(configured) : null;
        const expected = publicUrl?.host === host.toLowerCase() ? publicUrl : target;
        const local = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
        refused ||= source.origin !== expected.origin && !(local(source.hostname) && local(expected.hostname)
          && source.port === expected.port && source.protocol === expected.protocol);
      }
    } catch { refused = true; }
    if (refused) return NextResponse.json({ detail: "Origin refused" }, { status: 403, headers });
  }
  const user = await currentUser();
  if (!user.ok) return NextResponse.json({ detail: "Sign in to control transcription" }, { status: 401, headers });
  const base = (process.env.TINA_ASR_CONTROL_URL || "").replace(/\/+$/, "");
  const secret = process.env.TINA_INTERNAL_API_SECRET || "";
  if (!base || !secret) return NextResponse.json({ detail: "ASR controller is not configured; run make all" }, { status: 503, headers });
  try {
    let body: string | undefined;
    if (write) {
      const length = Number(req.headers.get("content-length") || 0);
      if (Number.isFinite(length) && length > 1024) return NextResponse.json({ detail: "Request too large" }, { status: 413, headers });
      if (!req.body) return NextResponse.json({ detail: "Invalid request" }, { status: 422, headers });
      const reader = req.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024) {
          await reader.cancel();
          return NextResponse.json({ detail: "Request too large" }, { status: 413, headers });
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let value;
      try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return NextResponse.json({ detail: "Invalid request" }, { status: 422, headers }); }
      if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "backend,enabled,revision"
          || !["gipformer", "viegem"].includes(value.backend) || typeof value.enabled !== "boolean"
          || !Number.isSafeInteger(value.revision) || value.revision < 0) {
        return NextResponse.json({ detail: "Invalid ASR selection" }, { status: 422, headers });
      }
      body = JSON.stringify({ ...value, user_id: user.userId });
    }
    const response = await fetch(`${base}/runtime${write ? "" : `?user_id=${encodeURIComponent(user.userId)}`}`, {
      method: write ? "POST" : "GET", body, cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json", "X-ASR-Control-Key": createHmac("sha256", secret).update("tina-asr-control:v1").digest("hex") },
      signal: AbortSignal.timeout(write ? 120000 : 10000),
    });
    return new NextResponse(await response.text(), { status: response.status, headers: { ...headers, "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ detail: "ASR controller is unavailable; refresh status before retrying" }, { status: 503, headers });
  }
}
export async function GET(req: NextRequest) { return proxy(req, false); }
export async function POST(req: NextRequest) { return proxy(req, true); }
