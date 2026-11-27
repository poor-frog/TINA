import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { cookieStore, validateAuthToken, resolveApiKey, canUseWorkspacePilot } = vi.hoisted(() => ({
  cookieStore: new Map<string, string>(),
  validateAuthToken: vi.fn(),
  resolveApiKey: vi.fn(),
  canUseWorkspacePilot: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieStore.get(name);
      return value !== undefined ? { value } : undefined;
    },
  }),
}));

vi.mock("../auth/adminApi", () => ({
  AUTH_COOKIE: "tina-token",
  USER_INFO_COOKIE: "tina-user-info",
  validateAuthToken,
}));

vi.mock("../proxyAuth", () => ({ resolveApiKey }));
vi.mock("../auth/workspacePilot", () => ({ canUseWorkspacePilot }));

import {
  _setMailTransportForTests,
  buildMimeMessage,
  isReservedTestEmail,
  isValidEmailAddress,
  sendSesEmail,
} from "../mail/sesMailer";
import {
  _resetLoginMailDedupeForTests,
  sendLoginEmail,
  sendWorkspaceInviteEmails,
} from "../mail/templates";
import { POST as mintWorkspaceInvite } from "../workspace/invites/route";
import { POST as sendInviteLinkEmail } from "../workspace/invites/send-email/route";

function configureSesEnv() {
  vi.stubEnv("TINA_SES_SMTP_USER", "AKIAEXAMPLE");
  vi.stubEnv("TINA_SES_SMTP_PASSWORD", "test-smtp-pass");
  vi.stubEnv("TINA_SES_FROM", "tina@meettina.site");
  vi.stubEnv("TINA_SES_REGION", "us-east-1");
  vi.stubEnv("TERMINAL_URL", "https://meettina.site");
}

describe("SES transactional mailer & templates", () => {
  beforeEach(() => {
    cookieStore.clear();
    _resetLoginMailDedupeForTests();
    _setMailTransportForTests(null);
    canUseWorkspacePilot.mockResolvedValue(true);
    resolveApiKey.mockResolvedValue("user-api-key");
  });

  afterEach(() => {
    _setMailTransportForTests(null);
    _resetLoginMailDedupeForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("validates addresses, blocks reserved test domains on real transport, and builds UTF-8 MIME", async () => {
    expect(isValidEmailAddress("lethanhquang094@gmail.com")).toBe(true);
    expect(isValidEmailAddress("bad\r\nBcc:evil@x.com")).toBe(false);
    expect(isReservedTestEmail("alice@example.test")).toBe(true);
    expect(isReservedTestEmail("lethanhquang094@gmail.com")).toBe(false);

    // Unconfigured SES cleanly skips
    const skippedUnconfigured = await sendSesEmail({
      to: "lethanhquang094@gmail.com",
      subject: "Test",
      text: "Hello",
      html: "<p>Hello</p>",
    });
    expect(skippedUnconfigured).toEqual({ ok: false, skipped: true, reason: "ses_not_configured" });

    // Reserved test domain cleanly skips on live transport
    configureSesEnv();
    const skippedReserved = await sendSesEmail({
      to: "dev@example.test",
      subject: "Test",
      text: "Hello",
      html: "<p>Hello</p>",
    });
    expect(skippedReserved).toEqual({ ok: false, skipped: true, reason: "reserved_test_domain" });

    const mime = buildMimeMessage(
      "tina@meettina.site",
      {
        to: "lethanhquang094@gmail.com",
        subject: "Thông báo đăng nhập mới vào Tina",
        text: "Xin chào",
        html: "<p>Xin chào</p>",
      },
      "<msg-1@meettina.site>",
    );
    expect(mime).toContain("From: Tina <tina@meettina.site>");
    expect(mime).toContain("To: lethanhquang094@gmail.com");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain("Content-ID: <tina-logo@tina>");
  });

  it("sends welcome and sign-in emails for Google, Microsoft, and direct logins with short dedupe", async () => {
    configureSesEnv();
    const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
    _setMailTransportForTests(async (_cfg, payload) => {
      sent.push(payload);
    });

    const r1 = await sendLoginEmail({
      email: "newuser@gmail.com",
      name: "Quang",
      provider: "google",
      isNewUser: true,
    });
    expect(r1.ok).toBe(true);
    expect(sent[0].subject).toContain("Chào mừng");
    expect(sent[0].html).toContain("https://meettina.site");

    // Duplicate callback within 30s is deduplicated
    const dup = await sendLoginEmail({
      email: "newuser@gmail.com",
      name: "Quang",
      provider: "google",
      isNewUser: true,
    });
    expect(dup).toEqual({ ok: false, skipped: true, reason: "deduplicated" });

    // Returning Microsoft login sends security sign-in alert
    const r2 = await sendLoginEmail({
      email: "newuser@gmail.com",
      name: "Quang",
      provider: "microsoft",
      isNewUser: false,
    });
    expect(r2.ok).toBe(true);
    expect(sent[1].subject).toContain("Thông báo đăng nhập mới");
    expect(sent[1].text).toContain("Microsoft");
    expect(sent[1].html).toContain("/?nav=settings&amp;settingsSection=account");

    // Direct email login also triggers notification
    const r3 = await sendLoginEmail({
      email: "direct@company.com",
      name: "Direct User",
      provider: "direct",
      isNewUser: false,
    });
    expect(r3.ok).toBe(true);
    expect(sent[2].text).toContain("Email");
  });

  it("POST /api/workspace/invites strips notify_emails upstream and emails the minted share link", async () => {
    configureSesEnv();
    const sent: Array<{ to: string; subject: string; html: string; text: string }> = [];
    _setMailTransportForTests(async (_cfg, payload) => {
      sent.push(payload);
    });

    cookieStore.set("tina-token", "tok-owner");
    cookieStore.set("tina-user-info", JSON.stringify({ name: "Quang Thanh", email: "lethanhquang094@gmail.com" }));
    validateAuthToken.mockResolvedValue({ ok: true, userId: 2, email: "lethanhquang094@gmail.com", isAdmin: true });

    let forwardedBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        forwardedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "inv-1",
            token: "SECRET_INVITE_TOK",
            role: "contributor",
            workspace_id: "engineering-syncs",
            expires_at: "2026-12-05T00:00:00Z",
            max_uses: 25,
            mode: "open",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const req = new NextRequest("https://meettina.site/api/workspace/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "engineering-syncs",
        role: "contributor",
        mode: "open",
        expires_in_sec: 604800,
        max_uses: 25,
        allowed_emails: null,
        notify_emails: ["alice@company.com", "bob@company.com"],
      }),
    });

    const res = await mintWorkspaceInvite(req);
    expect(res.status).toBe(201);
    expect(forwardedBody).not.toHaveProperty("notify_emails");

    const data = (await res.json()) as { token: string; email_delivery: { sent: string[]; failed: string[] } };
    expect(data.token).toBe("SECRET_INVITE_TOK");
    expect(data.email_delivery.sent).toEqual(["alice@company.com", "bob@company.com"]);
    expect(sent).toHaveLength(2);
    expect(sent[0].subject).toContain("engineering-syncs");
    expect(sent[0].text).toContain("https://meettina.site/?invite=SECRET_INVITE_TOK");
    expect(sent[0].text).toContain("Quang Thanh (lethanhquang094@gmail.com)");
  });

  it("POST /api/workspace/invites/send-email verifies the invite token before emailing teammates", async () => {
    configureSesEnv();
    const sent: Array<{ to: string; text: string }> = [];
    _setMailTransportForTests(async (_cfg, payload) => {
      sent.push({ to: payload.to, text: payload.text });
    });

    cookieStore.set("tina-token", "tok-owner");
    cookieStore.set("tina-user-info", JSON.stringify({ name: "Quang Thanh" }));
    validateAuthToken.mockResolvedValue({ ok: true, userId: 2, email: "lethanhquang094@gmail.com", isAdmin: true });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("token=REVOKED")) {
          return new Response(JSON.stringify({ valid: false, reason: "revoked" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ workspace_id: "sales-hub", name: "Sales Hub", role: "contributor", valid: true }),
          { status: 200 },
        );
      }),
    );

    const revokedReq = new NextRequest("https://meettina.site/api/workspace/invites/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "REVOKED", emails: ["alice@company.com"] }),
    });
    expect((await sendInviteLinkEmail(revokedReq)).status).toBe(400);
    expect(sent).toHaveLength(0);

    const okReq = new NextRequest("https://meettina.site/api/workspace/invites/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "VALID_TOK", emails: ["alice@company.com"] }),
    });
    const okRes = await sendInviteLinkEmail(okReq);
    expect(okRes.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("alice@company.com");
    expect(sent[0].text).toContain("Sales Hub");
    expect(sent[0].text).toContain("https://meettina.site/?invite=VALID_TOK");
  });

  it("sendWorkspaceInviteEmails ignores invalid entries and deduplicates recipients", async () => {
    configureSesEnv();
    const sent: string[] = [];
    _setMailTransportForTests(async (_cfg, payload) => {
      sent.push(payload.to);
    });
    const report = await sendWorkspaceInviteEmails({
      emails: ["Alice@Company.com", "alice@company.com", "not-an-email"],
      workspaceName: "Demo",
      inviterLabel: "Quang",
      role: "owner",
      inviteUrl: "https://meettina.site/?invite=abc",
    });
    expect(report).toEqual({ attempted: 1, sent: ["alice@company.com"], failed: [], skipped: false });
    expect(sent).toEqual(["alice@company.com"]);
  });
});
