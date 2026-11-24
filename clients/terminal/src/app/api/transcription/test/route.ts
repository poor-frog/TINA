import { cookies } from "next/headers";
import { AUTH_COOKIE } from "../../auth/adminApi";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!token) return Response.json({ detail: "Sign in to test transcription" }, { status: 401, headers });

  const gateway = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/+$/, "");
  try {
    // This meeting settings action uses the caller's verified Gateway identity in every Terminal mode.
    const upstream = await fetch(`${gateway}/agent/transcription/test`, {
      headers: { "X-API-Key": token },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(40000),
    });
    return Response.json(await upstream.json(), { status: upstream.status, headers });
  } catch {
    return Response.json({ detail: "Transcription test service is unavailable" }, { status: 502, headers });
  }
}
