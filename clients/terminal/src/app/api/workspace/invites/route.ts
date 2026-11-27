/** Workspace invites proxy (`GET`/`POST /api/workspace/invites`).
 *  Preserves the exact gateway proxy contract of `../[...seg]/route.ts`, and on successful POST
 *  automatically emails the minted shareable invite link via Amazon SES to `allowed_emails`
 *  (restricted mode) and any optional `notify_emails` supplied by the inviter. */
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { resolveApiKey } from "../../proxyAuth";
import { meetingsOnly } from "../../../mode";
import { canUseWorkspacePilot } from "../../auth/workspacePilot";
import { AUTH_COOKIE, USER_INFO_COOKIE, validateAuthToken } from "../../auth/adminApi";
import { resolveAppBaseUrl, sendWorkspaceInviteEmails } from "../../mail/templates";

export const dynamic = "force-dynamic";

const GATEWAY_URL = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/$/, "");

async function refusedResponse(method: "GET" | "POST"): Promise<Response | null> {
  if (!meetingsOnly() && (await canUseWorkspacePilot("workspace/invites", method))) return null;
  return new Response(
    JSON.stringify({ error: "not_found", detail: "agent endpoints are disabled in meetings mode" }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
}

async function resolveInviterLabel(): Promise<string> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(AUTH_COOKIE)?.value;
    const rawInfo = cookieStore.get(USER_INFO_COOKIE)?.value;
    let displayName = "";
    if (rawInfo) {
      try {
        const parsed = JSON.parse(rawInfo) as { name?: string };
        displayName = (parsed.name || "").trim();
      } catch {
        /* ignore malformed display cookie */
      }
    }
    if (token) {
      const auth = await validateAuthToken(token);
      if (auth.ok && auth.email) {
        return displayName && displayName.toLowerCase() !== auth.email.toLowerCase()
          ? `${displayName} (${auth.email})`
          : auth.email;
      }
    }
    return displayName || "Đồng đội của bạn";
  } catch {
    return "Đồng đội của bạn";
  }
}

export async function GET(req: NextRequest) {
  const refused = await refusedResponse("GET");
  if (refused) return refused;
  try {
    const apiKey = await resolveApiKey();
    const upstream = await fetch(`${GATEWAY_URL}/agent/workspace/invites${req.nextUrl.search}`, {
      headers: apiKey ? { "X-API-Key": apiKey } : {},
      cache: "no-store",
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[terminal-api] workspace invites read failed", err);
    return new Response(JSON.stringify({ error: "upstream_unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function POST(req: NextRequest) {
  const refused = await refusedResponse("POST");
  if (refused) return refused;

  let rawBodyText = "";
  let parsedBody: Record<string, unknown> | null = null;
  let notifyEmails: string[] = [];
  let allowedEmails: string[] = [];
  let workspaceDisplayName = "";

  try {
    rawBodyText = await req.text();
    if (rawBodyText) {
      const candidate = JSON.parse(rawBodyText) as unknown;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsedBody = { ...(candidate as Record<string, unknown>) };
        if (Array.isArray(parsedBody.notify_emails)) {
          notifyEmails = parsedBody.notify_emails.filter((v): v is string => typeof v === "string");
        }
        delete parsedBody.notify_emails;
        if (typeof parsedBody.workspace_name === "string") {
          workspaceDisplayName = parsedBody.workspace_name.trim().slice(0, 120);
        }
        delete parsedBody.workspace_name;
        if (Array.isArray(parsedBody.allowed_emails)) {
          allowedEmails = parsedBody.allowed_emails.filter((v): v is string => typeof v === "string");
        }
      }
    }
  } catch {
    /* Forward raw body verbatim so upstream returns its normal validation error */
  }

  try {
    const apiKey = await resolveApiKey();
    const headers: Record<string, string> = {
      "Content-Type": req.headers.get("Content-Type") || "application/json",
      ...(apiKey ? { "X-API-Key": apiKey } : {}),
    };
    const upstream = await fetch(`${GATEWAY_URL}/agent/workspace/invites${req.nextUrl.search}`, {
      method: "POST",
      headers,
      body: parsedBody ? JSON.stringify(parsedBody) : rawBodyText,
      cache: "no-store",
    });

    const responseText = await upstream.text();
    if (!upstream.ok) {
      return new Response(responseText, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
      });
    }

    const recipients = [...allowedEmails, ...notifyEmails];
    if (recipients.length === 0) {
      return new Response(responseText, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
      });
    }

    try {
      const minted = JSON.parse(responseText) as {
        token?: string;
        workspace_id?: string;
        name?: string;
        role?: string;
        expires_at?: string;
      };
      if (typeof minted.token === "string" && minted.token) {
        const baseUrl = resolveAppBaseUrl(req.nextUrl?.origin);
        const inviteUrl = `${baseUrl}/?invite=${encodeURIComponent(minted.token)}`;
        const inviterLabel = await resolveInviterLabel();
        const email_delivery = await sendWorkspaceInviteEmails({
          emails: recipients,
          workspaceName: String(
            workspaceDisplayName || minted.name || minted.workspace_id || parsedBody?.workspace_id || "Workspace chung",
          ),
          inviterLabel,
          role: String(minted.role || parsedBody?.role || "contributor"),
          inviteUrl,
          expiresAt: minted.expires_at ?? null,
        });
        return new Response(JSON.stringify({ ...minted, email_delivery }), {
          status: upstream.status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
    } catch {
      /* Never break invite creation if email serialization fails */
    }

    return new Response(responseText, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[terminal-api] workspace invites write failed", err);
    return new Response(JSON.stringify({ error: "upstream_unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
