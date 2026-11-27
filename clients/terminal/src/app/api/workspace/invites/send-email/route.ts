/** Email an already-minted workspace invite link (`POST /api/workspace/invites/send-email`).
 *  Validates the caller's session AND verifies the invite token against the gateway's preview
 *  endpoint so arbitrary/revoked/phishing links can never be emailed through TINA's SES domain. */
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { meetingsOnly } from "../../../../mode";
import { canUseWorkspacePilot } from "../../../auth/workspacePilot";
import { AUTH_COOKIE, USER_INFO_COOKIE, validateAuthToken } from "../../../auth/adminApi";
import { resolveApiKey } from "../../../proxyAuth";
import { isValidEmailAddress } from "../../../mail/sesMailer";
import { consumeInviteEmailQuota, resolveAppBaseUrl, sendWorkspaceInviteEmails } from "../../../mail/templates";

export const dynamic = "force-dynamic";

const GATEWAY_URL = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/$/, "");
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;
const MAX_EMAILS = 10;

export async function POST(req: NextRequest) {
  if (meetingsOnly() || !(await canUseWorkspacePilot("workspace/invites", "POST"))) {
    return NextResponse.json(
      { error: "not_found", detail: "agent endpoints are disabled in meetings mode" },
      { status: 404, headers: NO_STORE },
    );
  }

  const cookieStore = await cookies();
  const authCookie = cookieStore.get(AUTH_COOKIE)?.value;
  if (!authCookie) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401, headers: NO_STORE });
  }
  const auth = await validateAuthToken(authCookie);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status || 401, headers: NO_STORE },
    );
  }

  let body: { token?: unknown; emails?: unknown };
  try {
    body = (await req.json()) as { token?: unknown; emails?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }

  const inviteToken = typeof body.token === "string" ? body.token.trim() : "";
  if (!inviteToken || inviteToken.length > 512) {
    return NextResponse.json({ error: "A valid invite token is required" }, { status: 400, headers: NO_STORE });
  }

  const rawEmails = Array.isArray(body.emails)
    ? body.emails.filter((v): v is string => typeof v === "string")
    : [];
  const validEmails: string[] = [];
  for (const raw of rawEmails) {
    const clean = raw.trim().toLowerCase();
    if (isValidEmailAddress(clean) && !validEmails.includes(clean)) {
      validEmails.push(clean);
      if (validEmails.length >= MAX_EMAILS) break;
    }
  }
  if (validEmails.length === 0) {
    return NextResponse.json(
      { error: "Enter at least one valid email address" },
      { status: 400, headers: NO_STORE },
    );
  }

  // Verify the invite token server-side so we only ever email genuine, active workspace invites.
  let preview: { workspace_id?: string; name?: string; role?: string; valid?: boolean; reason?: string | null };
  let apiKey: string | null = null;
  try {
    apiKey = await resolveApiKey();
    const res = await fetch(
      `${GATEWAY_URL}/agent/workspace/invites/preview?token=${encodeURIComponent(inviteToken)}`,
      {
        headers: apiKey ? { "X-API-Key": apiKey } : {},
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) {
      return NextResponse.json(
        { error: "Could not verify workspace invite token" },
        { status: res.status === 404 ? 400 : 502, headers: NO_STORE },
      );
    }
    preview = (await res.json()) as typeof preview;
  } catch {
    return NextResponse.json({ error: "Workspace service unavailable" }, { status: 502, headers: NO_STORE });
  }

  if (!preview?.valid || !preview.workspace_id) {
    return NextResponse.json(
      { error: `Invite link is no longer valid${preview?.reason ? ` (${preview.reason})` : ""}` },
      { status: 400, headers: NO_STORE },
    );
  }

  // Enforce workspace invite-management authorization: caller must be a contributor or owner of the
  // target workspace (matching POST /api/workspace/invites) so non-members holding an open link
  // cannot relay spam through TINA's SES domain.
  try {
    const authzRes = await fetch(
      `${GATEWAY_URL}/agent/workspace/invites?workspace_id=${encodeURIComponent(preview.workspace_id)}`,
      {
        headers: apiKey ? { "X-API-Key": apiKey } : {},
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      },
    );
    if (authzRes.status === 401 || authzRes.status === 403 || authzRes.status === 404) {
      return NextResponse.json(
        { error: "You do not have permission to send invites for this workspace" },
        { status: 403, headers: NO_STORE },
      );
    }
    if (!authzRes.ok) {
      return NextResponse.json(
        { error: "Could not verify workspace invite permission" },
        { status: 502, headers: NO_STORE },
      );
    }
  } catch {
    return NextResponse.json({ error: "Workspace service unavailable" }, { status: 502, headers: NO_STORE });
  }

  if (!consumeInviteEmailQuota(String(auth.userId), validEmails.length)) {
    return NextResponse.json(
      { error: "Too many invite emails sent recently. Please wait a few minutes and try again." },
      { status: 429, headers: NO_STORE },
    );
  }

  let displayName = "";
  const rawInfo = cookieStore.get(USER_INFO_COOKIE)?.value;
  if (rawInfo) {
    try {
      const parsed = JSON.parse(rawInfo) as { name?: string };
      displayName = (parsed.name || "").trim();
    } catch {
      /* ignore malformed display cookie */
    }
  }
  const inviterLabel =
    displayName && displayName.toLowerCase() !== auth.email.toLowerCase()
      ? `${displayName} (${auth.email})`
      : auth.email;

  const baseUrl = resolveAppBaseUrl(req.nextUrl?.origin);
  const inviteUrl = `${baseUrl}/?invite=${encodeURIComponent(inviteToken)}`;
  const email_delivery = await sendWorkspaceInviteEmails({
    emails: validEmails,
    workspaceName: String(preview.name || preview.workspace_id || "Workspace chung"),
    inviterLabel,
    role: String(preview.role || "contributor"),
    inviteUrl,
  });

  return NextResponse.json({ ok: true, email_delivery }, { status: 200, headers: NO_STORE });
}
