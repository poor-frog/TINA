import { NextResponse } from "next/server";
import { resolveApiKey } from "../../../proxyAuth";
import { refusedInMeetingsMode } from "../../../proxyMode";
import { canUseWorkspacePilot } from "../../../auth/workspacePilot";

export const dynamic = "force-dynamic";
const GATEWAY_URL = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/$/, "");
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

export async function GET() {
  if (refusedInMeetingsMode("models/openai/catalog") || !(await canUseWorkspacePilot("models/openai/catalog"))) {
    return NextResponse.json(
      { error: "not_found", detail: "agent endpoints are disabled in meetings mode" },
      { status: 404, headers: NO_STORE },
    );
  }
  try {
    const apiKey = await resolveApiKey();
    const upstream = await fetch(`${GATEWAY_URL}/agent/models/openai/catalog`, {
      headers: apiKey ? { "X-API-Key": apiKey } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const detail = typeof body?.detail === "string" ? body.detail : "Could not load ChatGPT models.";
      return NextResponse.json({ error: detail }, { status: upstream.status, headers: NO_STORE });
    }
    return NextResponse.json(body, { headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { error: "Could not load ChatGPT models. You can still type a model ID." },
      { status: 502, headers: NO_STORE },
    );
  }
}
