import { NextResponse } from "next/server";
import { resolveApiKey } from "../../proxyAuth";
import { refusedInMeetingsMode } from "../../proxyMode";
import { canUseWorkspacePilot } from "../../auth/workspacePilot";

export const dynamic = "force-dynamic";
const GATEWAY_URL = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/$/, "");
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

/** POST /api/models/catalog — the provider's live model list for the picker.
 *
 *  The body is `{mode, api_key?}`. `api_key` is a DRAFT key the user is still typing (the picker
 *  shows the list before Save); it is forwarded once and never stored or echoed. Omitting it makes
 *  agent-api use the saved effective key for that provider. Never log the body. */
export async function POST(request: Request) {
  // Meetings-only / workspace-pilot gate: refuse unauthorized requests at the edge.
  if (refusedInMeetingsMode("models/catalog") || !(await canUseWorkspacePilot("models/catalog"))) {
    return NextResponse.json(
      { error: "not_found", detail: "agent endpoints are disabled in meetings mode" },
      { status: 404, headers: NO_STORE },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid model catalog request." }, { status: 400, headers: NO_STORE });
  }
  try {
    const apiKey = await resolveApiKey();
    const upstream = await fetch(`${GATEWAY_URL}/agent/models/catalog`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-API-Key": apiKey } : {}),
      },
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      // A bare 401 has no upstream `detail`: the gateway rejected TINA's own session key, which is
      // not the provider's verdict on the key in the form. Say which one failed.
      const detail = typeof payload?.detail === "string" ? payload.detail
        : upstream.status === 401
          ? "Your TINA session is no longer valid — sign in again."
          : "Could not load the model list.";
      return NextResponse.json({ error: detail }, { status: upstream.status, headers: NO_STORE });
    }
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { error: "Could not reach the model catalog service." },
      { status: 502, headers: NO_STORE },
    );
  }
}
