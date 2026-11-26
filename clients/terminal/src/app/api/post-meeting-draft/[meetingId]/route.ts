import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE } from "../../auth/adminApi";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ meetingId: string }> };
const headers = { "Cache-Control": "private, no-store" };
const gateway = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/$/, "");

async function forward(request: NextRequest, context: Context) {
  const { meetingId } = await context.params;
  if (!/^[1-9]\d{0,17}$/.test(meetingId)) {
    return Response.json({ detail: "Invalid meeting" }, { status: 400, headers });
  }
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!token) return Response.json({ detail: "Sign in required" }, { status: 401, headers });

  const upstream = new URL(`${gateway}/agent/workspace/meeting-knowledge/${meetingId}/draft-job`);
  const workspace = request.nextUrl.searchParams.get("workspace");
  if (request.method === "GET" && workspace !== null) upstream.searchParams.set("workspace", workspace);
  const body = request.method === "POST" ? await request.text() : undefined;
  if (body && body.length > 4096) {
    return Response.json({ detail: "Invalid document selection" }, { status: 413, headers });
  }
  try {
    const response = await fetch(upstream, {
      method: request.method,
      headers: { "X-API-Key": token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch {
    return Response.json({ detail: "Draft service unavailable" }, { status: 503, headers });
  }
}

export const GET = forward;
export const POST = forward;
