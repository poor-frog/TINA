/** Direct email login — no SMTP, no magic link. POST {email} → find-or-create the user at admin-api,
 *  mint an APIToken (scopes bot,tx,browser), set the httpOnly `tina-token` + `tina-user-info` cookies.
 *
 *  Mirrors the dashboard's TINA_ALLOW_DIRECT_LOGIN branch (without importing it). No email is ever sent.
 *  Must never be cached — a cached response would pin one identity for every subsequent login.
 */
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, USER_INFO_COOKIE, findOrCreateUserToken } from "../adminApi";
import { sendLoginEmail } from "../../mail/templates";
import { CALENDAR_WELCOME_COOKIE } from "../googleCalendarLink";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isSecureRequest(): boolean {
  return (
    (process.env.TERMINAL_URL || "").startsWith("https://") ||
    (process.env.NEXTAUTH_URL || "").startsWith("https://") ||
    false
  );
}

export async function POST(request: NextRequest) {
  let email: unknown;
  try {
    ({ email } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  if (typeof email !== "string" || !email.trim()) {
    return NextResponse.json({ error: "Email is required" }, { status: 400, headers: NO_STORE });
  }
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400, headers: NO_STORE });
  }
  // Direct email login is local development only. The reserved test domain prevents a real account
  // whose address happens to contain "test" from being impersonated through this passwordless path.
  if (
    (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test")
    || !normalized.endsWith("@example.test")
  ) {
    return NextResponse.json(
      { error: "Direct email login is available only in development for @example.test accounts." },
      { status: 403, headers: NO_STORE },
    );
  }

  const result = await findOrCreateUserToken(normalized);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status || 500, headers: NO_STORE });
  }

  const { user, token, justCreated } = result;
  const secure = isSecureRequest();
  const cookieStore = await cookies();
  const opts = { httpOnly: true, secure, sameSite: "lax" as const, maxAge: 60 * 60 * 24 * 30, path: "/" };
  cookieStore.set(AUTH_COOKIE, token, opts);
  if (cookieStore.get(CALENDAR_WELCOME_COOKIE)) {
    cookieStore.set(CALENDAR_WELCOME_COOKIE, "", { ...opts, maxAge: 0 });
  }
  const displayName = user.name || user.email.split("@")[0];
  cookieStore.set(USER_INFO_COOKIE, JSON.stringify({ email: user.email, name: displayName }), opts);

  // Best-effort login / welcome notification (skips reserved .test domains on live SES).
  void sendLoginEmail({
    email: user.email,
    name: displayName,
    provider: "direct",
    isNewUser: justCreated,
  }).catch(() => undefined);

  return NextResponse.json(
    { success: true, user: { id: user.id, email: user.email, name: user.name ?? user.email } },
    { headers: NO_STORE },
  );
}
