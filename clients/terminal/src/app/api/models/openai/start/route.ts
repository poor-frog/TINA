import { NextRequest, NextResponse } from "next/server";
import {
  beginChatGPTAuth, callbackUri, currentTinaSubject, readChatGPTProfile, storePending, chatGPTConnection,
} from "../../../../../lib/chatgptPlanAuth";
import { workspacePilotMode } from "../../../../mode";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

function loopbackOrigin(req: NextRequest): string {
  const raw = req.headers.get("origin") || req.nextUrl.origin;
  const origin = new URL(raw);
  const port = (process.env.TINA_TERMINAL_PUBLIC_PORT || "23000").trim();
  // The callback is pinned to 127.0.0.1. Requiring the same host here ensures the
  // authenticated TINA cookie is sent on the OAuth redirect back to this service.
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"
      || origin.port !== port) {
    throw new Error(`ChatGPT plan sign-in is available from http://127.0.0.1:${port} only.`);
  }
  return origin.origin;
}

export async function POST(req: NextRequest) {
  if (workspacePilotMode()) {
    return NextResponse.json({ error: "Contact your staging operator to manage Workspace ChatGPT." }, { status: 403, headers: NO_STORE });
  }
  const subject = await currentTinaSubject();
  if (!subject) return NextResponse.json({ error: "Sign in to TINA before connecting ChatGPT." }, { status: 401, headers: NO_STORE });
  try {
    const uiOrigin = loopbackOrigin(req);
    const redirect = new URL(callbackUri());
    const publicPort = (process.env.TINA_TERMINAL_PUBLIC_PORT || "23000").trim();
    if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1"
        || redirect.port !== publicPort || redirect.pathname !== "/api/models/openai/callback") {
      throw new Error("The ChatGPT callback must use TINA's local loopback address and terminal port.");
    }
    const { generation } = await chatGPTConnection(subject, "GET");
    if (!generation) throw new Error("Could not start ChatGPT connection; retry.");
    const existing = await readChatGPTProfile(subject);
    const hostId = existing?.host_id || `urn:uuid:${crypto.randomUUID()}`;
    const clientId = existing?.client_id || "dynamic_agent_client";
    const { authorizationUrl, pending } = beginChatGPTAuth({
      redirect_uri: redirect.toString(), ui_origin: uiOrigin, subject_id: subject,
      generation,
      host_id: hostId, client_id: clientId,
      ...(clientId === "dynamic_agent_client" ? { agent_name_hint: "TINA" } : {}),
      ...(existing?.id_token ? { id_token_hint: existing.id_token } : {}),
      ...(existing?.email ? { login_hint: existing.email } : {}),
    });
    storePending(pending);
    return NextResponse.json({ authorization_url: authorizationUrl }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to start ChatGPT sign-in." },
      { status: 400, headers: NO_STORE },
    );
  }
}
