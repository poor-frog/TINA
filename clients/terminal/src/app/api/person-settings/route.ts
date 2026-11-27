/** Per-user email & timezone preferences (`GET`/`PUT /api/person-settings`).
 *  Resolves the logged-in user's verified `userId` via `validateAuthToken` and proxies server-side
 *  to admin-api's `/internal/users/{user_id}/settings` (the single source of truth read by
 *  `core/flows` before emailing a user). Never accepts a client-supplied user ID. */
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, internalRequest, validateAuthToken } from "../auth/adminApi";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

const BOOLEAN_KEYS = new Set(["mail_minutes", "mail_rsvp", "mail_join", "mail_prep"]);
const STRING_KEYS = new Set(["timezone"]);

export interface PersonSettingsResponse {
  timezone: string;
  mail_minutes: boolean;
  mail_join: boolean;
  mail_rsvp: boolean;
  mail_prep: boolean;
}

async function resolveAuthenticatedUserId(): Promise<
  { ok: true; userId: string | number } | { ok: false; response: NextResponse }
> {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not authenticated" }, { status: 401, headers: NO_STORE }),
    };
  }
  const auth = await validateAuthToken(token);
  if (!auth.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: auth.error },
        { status: auth.status || 401, headers: NO_STORE },
      ),
    };
  }
  return { ok: true, userId: auth.userId };
}

function validateUpdateBody(raw: unknown): { ok: true; update: Record<string, boolean | string> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, error: "Provide at least one setting to update" };
  }
  const update: Record<string, boolean | string> = {};
  for (const [key, value] of entries) {
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== "boolean") {
        return { ok: false, error: `${key} must be a boolean` };
      }
      update[key] = value;
      continue;
    }
    if (STRING_KEYS.has(key)) {
      if (typeof value !== "string") {
        return { ok: false, error: `${key} must be a string` };
      }
      update[key] = value.trim();
      continue;
    }
    return { ok: false, error: `Unknown setting '${key}'` };
  }
  return { ok: true, update };
}

export async function GET() {
  const identity = await resolveAuthenticatedUserId();
  if (!identity.ok) return identity.response;

  const res = await internalRequest<PersonSettingsResponse>(
    `/internal/users/${encodeURIComponent(String(identity.userId))}/settings`,
    { method: "GET" },
  );
  if (!res.ok || !res.data) {
    return NextResponse.json(
      { error: res.error || "Failed to load email settings" },
      { status: res.status || 502, headers: NO_STORE },
    );
  }
  return NextResponse.json(res.data, { status: 200, headers: NO_STORE });
}

export async function PUT(req: NextRequest) {
  const identity = await resolveAuthenticatedUserId();
  if (!identity.ok) return identity.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }

  const parsed = validateUpdateBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  }

  const res = await internalRequest<PersonSettingsResponse>(
    `/internal/users/${encodeURIComponent(String(identity.userId))}/settings`,
    { method: "PUT", body: JSON.stringify(parsed.update) },
  );
  if (!res.ok || !res.data) {
    return NextResponse.json(
      { error: res.error || "Failed to save email settings" },
      { status: res.status || 502, headers: NO_STORE },
    );
  }
  return NextResponse.json(res.data, { status: 200, headers: NO_STORE });
}
