import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, validateAuthToken } from "../adminApi";
import { createGoogleCalendarLinkIntent, GOOGLE_CALENDAR_LINK_COOKIE } from "../googleCalendarLink";

export const dynamic = "force-dynamic";

function expectedOrigin(request: NextRequest): string {
  const configured = process.env.NEXTAUTH_URL || process.env.TERMINAL_URL;
  try { return new URL(configured || request.url).origin; }
  catch { return request.nextUrl.origin; }
}

export async function POST(request: NextRequest) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return NextResponse.json({ error: "Google OAuth is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const origin = request.headers.get("origin");
  if (!origin || origin !== expectedOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "Sign in before connecting a calendar" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const identity = await validateAuthToken(token);
  if (!identity.ok) return NextResponse.json({ error: "Sign in before connecting a calendar" }, { status: identity.status, headers: { "Cache-Control": "no-store" } });
  const value = createGoogleCalendarLinkIntent(identity.userId);
  if (!value) return NextResponse.json({ error: "Calendar linking is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });

  const response = NextResponse.json({ ready: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(GOOGLE_CALENDAR_LINK_COOKIE, value, {
    httpOnly: true,
    secure: (process.env.NEXTAUTH_URL || process.env.TERMINAL_URL || "").startsWith("https://") || process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/api/auth",
  });
  return response;
}
