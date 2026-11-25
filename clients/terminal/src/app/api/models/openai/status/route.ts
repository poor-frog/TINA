import { NextResponse } from "next/server";
import { currentTinaSubject, readChatGPTProfile } from "../../../../../lib/chatgptPlanAuth";
import { workspacePilotMode } from "../../../../mode";
import { resolveApiKey } from "../../../proxyAuth";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const subject = await currentTinaSubject();
  if (!subject) return NextResponse.json({ connected: false }, { status: 401, headers: NO_STORE });
  if (workspacePilotMode()) {
    const gateway = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/+$/, "");
    try {
      const upstream = await fetch(`${gateway}/agent/models/openai/workspace-status`, {
        headers: { "X-API-Key": await resolveApiKey() }, cache: "no-store",
        redirect: "error", signal: AbortSignal.timeout(6000),
      });
      if (upstream.ok) {
        const body = await upstream.json();
        if (typeof body?.available === "boolean" && typeof body?.connected === "boolean") {
          return NextResponse.json({ available: body.available, connected: body.connected }, { headers: NO_STORE });
        }
      }
    } catch { /* Return a status failure instead of reporting a disconnected account. */ }
    return NextResponse.json({ error: "Could not check Workspace ChatGPT status." }, { status: 503, headers: NO_STORE });
  }
  const profile = await readChatGPTProfile(subject);
  const scopes = new Set(profile?.scopes || []);
  const connected = Boolean(profile?.access_token && profile?.refresh_token
    && scopes.has("chatgpt.tokens.use.direct") && scopes.has("resource.invoke"));
  return NextResponse.json({
    connected,
    email: connected ? profile?.email || "" : "",
    expires_at: connected ? profile?.expires_at || 0 : 0,
  }, { headers: NO_STORE });
}
