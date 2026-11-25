/** Read proxy for the workspace knowledge graph → agent-api /api/workspace/* (host stays server-side). */
import type { NextRequest } from "next/server";
import { resolveApiKey } from "../../proxyAuth";
import { meetingsOnly } from "../../../mode";
import { canUseWorkspacePilot } from "../../auth/workspacePilot";

export const dynamic = "force-dynamic";

/** Meetings-only mode: the workspace KG is an agent surface — refused at the edge (404). */
async function refusedResponse(seg: string[]): Promise<Response | null> {
  if (!meetingsOnly() && !seg.some(part => !part || part === "." || part === ".." || /[/%\\?#]/.test(part))
      && (await canUseWorkspacePilot(["workspace", ...seg].join("/")))) return null;
  return new Response(JSON.stringify({ error: "not_found", detail: "agent endpoints are disabled in meetings mode" }), { status: 404, headers: { "Content-Type": "application/json" } });
}

// One authenticated edge: workspace KG reads go through the gateway (which injects X-User-Id), not agent-api directly.
const GATEWAY_URL = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/$/, "");

export async function GET(req: NextRequest, ctx: { params: Promise<{ seg: string[] }> }) {
  const { seg } = await ctx.params;
  const refused = await refusedResponse(seg);
  if (refused) return refused;
  try {
    const apiKey = await resolveApiKey();
    const upstream = await fetch(`${GATEWAY_URL}/agent/workspace/${seg.join("/")}${req.nextUrl.search}`, {
      headers: apiKey ? { "X-API-Key": apiKey } : {},
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[terminal-api] workspace read proxy failed", err);
    return new Response(JSON.stringify({ error: "upstream_unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function forwardWrite(req: NextRequest, seg: string[], method: "POST" | "PUT" | "DELETE") {
  const refused = await refusedResponse(seg);
  if (refused) return refused;
  try {
    const apiKey = await resolveApiKey();
    const headers: Record<string, string> = apiKey ? { "X-API-Key": apiKey } : {};
    const init: RequestInit & { duplex?: "half" } = { method, headers, cache: "no-store" };
    if (method !== "DELETE") {
      headers["Content-Type"] = req.headers.get("Content-Type") ?? "";
      init.body = req.body;
      init.duplex = "half";
    }
    const upstream = await fetch(`${GATEWAY_URL}/agent/workspace/${seg.join("/")}${req.nextUrl.search}`, init);
    if (upstream.status === 204 || upstream.status === 205 || upstream.status === 304) {
      return new Response(null, { status: upstream.status, headers: { "Cache-Control": "no-cache" } });
    }
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
    });
  } catch (err) {
    console.error("[terminal-api] workspace write proxy failed", err);
    return new Response(JSON.stringify({ error: "upstream_unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ seg: string[] }> }) {
  const { seg } = await ctx.params;
  return forwardWrite(req, seg, "POST");
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ seg: string[] }> }) {
  const { seg } = await ctx.params;
  return forwardWrite(req, seg, "PUT");
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ seg: string[] }> }) {
  const { seg } = await ctx.params;
  return forwardWrite(req, seg, "DELETE");
}
