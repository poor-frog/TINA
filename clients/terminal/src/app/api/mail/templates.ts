/** Branded MeetTINA transactional email templates & high-level senders for:
 *  1. Login / Welcome emails (Google OAuth, Microsoft OAuth, Direct email login)
 *  2. Workspace share-link invitation emails (restricted & open links) */
import { LOGO_CID, isValidEmailAddress, sendSesEmail, type MailSendResult } from "./sesMailer";

export type LoginProvider = "google" | "microsoft" | "direct";

const PROVIDER_LABELS: Record<LoginProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
  direct: "Email",
};

const LOGIN_DEDUPE_MS = 30_000;
const recentLoginMails = new Map<string, number>();

const INVITE_RATE_WINDOW_MS = 10 * 60 * 1000;
const INVITE_MAX_EMAILS_PER_WINDOW = 20;
const inviteSendHistory = new Map<string, number[]>();

export function _resetLoginMailDedupeForTests(): void {
  recentLoginMails.clear();
}

export function _resetInviteEmailRateLimitForTests(): void {
  inviteSendHistory.clear();
}

export function consumeInviteEmailQuota(userKey: string, count: number): boolean {
  const now = Date.now();
  const cutoff = now - INVITE_RATE_WINDOW_MS;
  const recent = (inviteSendHistory.get(userKey) || []).filter((ts) => ts > cutoff);
  if (recent.length + count > INVITE_MAX_EMAILS_PER_WINDOW) {
    inviteSendHistory.set(userKey, recent);
    return false;
  }
  for (let i = 0; i < count; i++) recent.push(now);
  inviteSendHistory.set(userKey, recent);
  if (inviteSendHistory.size > 500) {
    for (const [key, list] of inviteSendHistory) {
      if (!list.some((ts) => ts > cutoff)) inviteSendHistory.delete(key);
    }
  }
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function resolveAppBaseUrl(fallbackOrigin?: string): string {
  const candidates = [
    process.env.TERMINAL_URL,
    process.env.NEXTAUTH_URL,
    fallbackOrigin,
    "https://meettina.site",
  ];
  for (const raw of candidates) {
    const trimmed = (raw || "").trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        return `${parsed.protocol}//${parsed.host}`;
      }
    } catch {
      /* Try next candidate */
    }
  }
  return "https://meettina.site";
}

function formatVietnamTime(date: Date): string {
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour12: false,
    }).format(date) + " (UTC+7)";
  } catch {
    return date.toISOString();
  }
}

function renderBrandedEmail(opts: {
  subject: string;
  preheader: string;
  heading: string;
  subtitle: string;
  paragraphs: string[];
  ctaLabel: string;
  ctaUrl: string;
  secondaryNote?: string;
}): string {
  const bodyBlocks = opts.paragraphs
    .map(
      (p) =>
        `<p style="font-size:15px;line-height:24px;margin:0 0 14px;color:#2A433D">${escapeHtml(p)}</p>`,
    )
    .join("");

  const secondaryHtml = opts.secondaryNote
    ? `<p style="font-size:13px;line-height:20px;margin:16px 0 0;color:#526860">${escapeHtml(opts.secondaryNote)}</p>`
    : "";

  const safeUrl = escapeHtml(opts.ctaUrl);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="vi">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <title>${escapeHtml(opts.subject)}</title>
  </head>
  <body lang="vi" dir="ltr" style="background-color:#F7F8F3;margin:0;padding:0">
    <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">
      ${escapeHtml(opts.preheader)}
    </div>
    <table border="0" width="100%" cellpadding="0" cellspacing="0" role="presentation" align="center">
      <tbody>
        <tr>
          <td style="margin:0;padding:32px 12px;background-color:#F7F8F3;font-family:Arial,Helvetica,sans-serif">
            <table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;margin:0 auto">
              <tbody>
                <tr>
                  <td>
                    <table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#FFFFFF;border:1px solid #D3DED5;border-radius:12px">
                      <tbody>
                        <tr>
                          <td style="padding:28px 24px">
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                              <tbody>
                                <tr>
                                  <td style="width:38px">
                                    <img alt="Logo Tina" height="32" width="30" src="cid:${LOGO_CID}" style="display:block;border:none;outline:none;text-decoration:none" />
                                  </td>
                                  <td style="font-size:23px;line-height:30px;font-weight:700;letter-spacing:-0.6px;color:#173B36">
                                    Tina
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                            <hr style="width:100%;border:none;border-top:1px solid #D3DED5;margin:22px 0 24px" />
                            <h1 style="margin:0 0 8px;font-size:26px;line-height:34px;letter-spacing:-0.5px;font-weight:600;color:#173B36">
                              ${escapeHtml(opts.heading)}
                            </h1>
                            <p style="font-size:16px;line-height:24px;margin:0 0 22px;color:#176B5B;overflow-wrap:anywhere">
                              ${escapeHtml(opts.subtitle)}
                            </p>
                            ${bodyBlocks}
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">
                              <tbody>
                                <tr>
                                  <td style="border-radius:8px;background-color:#176B5B">
                                    <a href="${safeUrl}" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px">
                                      ${escapeHtml(opts.ctaLabel)}
                                    </a>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                            <p style="font-size:12px;line-height:18px;margin:10px 0 0;color:#526860;word-break:break-all">
                              Hoặc mở trực tiếp: <a href="${safeUrl}" style="color:#176B5B;text-decoration:underline">${safeUrl}</a>
                            </p>
                            ${secondaryHtml}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p style="font-size:12px;line-height:20px;margin:18px 0 0;text-align:center;color:#526860">
                      Email thông báo từ Tina · meettina.site
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`;
}

export async function sendLoginEmail(opts: {
  email: string;
  name?: string | null;
  provider: LoginProvider;
  isNewUser: boolean;
  baseUrl?: string;
}): Promise<MailSendResult> {
  const to = opts.email.trim().toLowerCase();
  const dedupeKey = `${to}:${opts.provider}`;
  const now = Date.now();
  const lastSent = recentLoginMails.get(dedupeKey);
  if (lastSent && now - lastSent < LOGIN_DEDUPE_MS) {
    return { ok: false, skipped: true, reason: "deduplicated" };
  }
  recentLoginMails.set(dedupeKey, now);
  if (recentLoginMails.size > 500) {
    for (const [k, ts] of recentLoginMails) {
      if (now - ts >= LOGIN_DEDUPE_MS) recentLoginMails.delete(k);
    }
  }

  const baseUrl = resolveAppBaseUrl(opts.baseUrl);
  const displayName = (opts.name || to.split("@")[0] || "bạn").trim();
  const providerLabel = PROVIDER_LABELS[opts.provider];
  const when = formatVietnamTime(new Date(now));

  if (opts.isNewUser) {
    const subject = "Chào mừng bạn đến với Tina";
    const ctaUrl = baseUrl;
    const paragraphs = [
      `Xin chào ${displayName},`,
      `Tài khoản Tina của bạn (${to}) đã được tạo thành công qua ${providerLabel} vào lúc ${when}.`,
      "Bạn có thể bắt đầu ghi chép cuộc họp, nhận bản tóm tắt AI và cộng tác cùng đồng đội ngay bây giờ.",
    ];
    const text = `${paragraphs.join("\n\n")}\n\nMở Tina: ${ctaUrl}\n\nTrân trọng,\nTina\n`;
    const html = renderBrandedEmail({
      subject,
      preheader: "Tài khoản Tina của bạn đã sẵn sàng.",
      heading: "Chào mừng đến với Tina",
      subtitle: to,
      paragraphs,
      ctaLabel: "Mở Tina",
      ctaUrl,
    });
    return sendSesEmail({ to, subject, text, html });
  }

  const subject = "Thông báo đăng nhập mới vào Tina";
  const ctaUrl = `${baseUrl}/?nav=settings&settingsSection=account`;
  const paragraphs = [
    `Xin chào ${displayName},`,
    `Tài khoản Tina của bạn (${to}) vừa đăng nhập thành công qua ${providerLabel} vào lúc ${when}.`,
  ];
  const secondaryNote =
    "Nếu đây là bạn, bạn có thể bỏ qua email này. Nếu không nhận ra phiên đăng nhập này, hãy mở Cài đặt tài khoản để kiểm tra và đăng xuất.";
  const text = `${paragraphs.join("\n\n")}\n\nMở cài đặt tài khoản: ${ctaUrl}\n\n${secondaryNote}\n\nTrân trọng,\nTina\n`;
  const html = renderBrandedEmail({
    subject,
    preheader: `Phiên đăng nhập mới qua ${providerLabel} vào lúc ${when}.`,
    heading: "Đăng nhập mới vào Tina",
    subtitle: `${providerLabel} · ${when}`,
    paragraphs,
    ctaLabel: "Mở cài đặt tài khoản",
    ctaUrl,
    secondaryNote,
  });
  return sendSesEmail({ to, subject, text, html });
}

export interface WorkspaceInviteEmailReport {
  attempted: number;
  sent: string[];
  failed: string[];
  skipped: boolean;
}

const MAX_INVITE_EMAILS_PER_REQUEST = 20;

export async function sendWorkspaceInviteEmails(opts: {
  emails: string[];
  workspaceName: string;
  inviterLabel: string;
  role: string;
  inviteUrl: string;
  expiresAt?: string | null;
}): Promise<WorkspaceInviteEmailReport> {
  const unique: string[] = [];
  for (const raw of opts.emails) {
    const clean = raw.trim().toLowerCase();
    if (!isValidEmailAddress(clean) || unique.includes(clean)) continue;
    unique.push(clean);
    if (unique.length >= MAX_INVITE_EMAILS_PER_REQUEST) break;
  }

  if (unique.length === 0) {
    return { attempted: 0, sent: [], failed: [], skipped: true };
  }

  const workspaceName = opts.workspaceName.trim() || "Workspace chung";
  const inviter = opts.inviterLabel.trim() || "Đồng đội của bạn";
  const normalizedRole = opts.role.trim().toLowerCase();
  const roleLabel =
    normalizedRole === "owner"
      ? "Owner (Quản trị)"
      : normalizedRole === "viewer"
        ? "Viewer (Chỉ xem)"
        : "Contributor (Thành viên)";
  const subject = `Lời mời tham gia workspace “${workspaceName}” trên Tina`;

  const paragraphs = [
    "Xin chào,",
    `${inviter} đã mời bạn tham gia workspace “${workspaceName}” trên Tina với vai trò ${roleLabel}.`,
    "Bấm nút bên dưới để mở đường dẫn chia sẻ và tham gia cùng đội ngũ.",
  ];
  const secondaryNote =
    "Vui lòng đăng nhập Tina bằng đúng email nhận thư này nếu lời mời được giới hạn theo địa chỉ email.";
  const text = `${paragraphs.join("\n\n")}\n\nTham gia Workspace:\n${opts.inviteUrl}\n\n${secondaryNote}\n\nTrân trọng,\nTina\n`;
  const html = renderBrandedEmail({
    subject,
    preheader: `${inviter} đã mời bạn tham gia workspace ${workspaceName} trên Tina.`,
    heading: "Lời mời tham gia Workspace",
    subtitle: workspaceName,
    paragraphs,
    ctaLabel: "Tham gia Workspace",
    ctaUrl: opts.inviteUrl,
    secondaryNote,
  });

  // Bound concurrent TLS connections to Amazon SES to stay well within MaxSendRate.
  const CONCURRENCY = 4;
  const results: Array<{ to: string; res: MailSendResult }> = [];
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (to) => ({ to, res: await sendSesEmail({ to, subject, text, html }) })),
    );
    results.push(...batchResults);
  }

  const sent: string[] = [];
  const failed: string[] = [];
  let allSkipped = true;

  for (const item of results) {
    if (item.res.ok) {
      sent.push(item.to);
      allSkipped = false;
    } else if (!item.res.skipped) {
      failed.push(item.to);
      allSkipped = false;
    }
  }

  return {
    attempted: unique.length,
    sent,
    failed,
    skipped: allSkipped,
  };
}
