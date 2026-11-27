/** Zero-dependency Amazon SES SMTPS client (RFC 5321 / TLS 465) for TINA Terminal transactional
 *  emails (sign-in alerts, welcome emails, workspace share-link invitations).
 *  Reuses the same `TINA_SES_SMTP_USER`, `TINA_SES_SMTP_PASSWORD`, `TINA_SES_FROM`, and
 *  `TINA_SES_REGION` environment contract as `core/flows`. Never logs credentials. */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import tls from "node:tls";

const EMAIL_RE = /^[^\s@<>;,:()[\]"\\]+@[^\s@<>;,:()[\]"\\]+\.[^\s@<>;,:()[\]"\\]+$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const RESERVED_TEST_TLDS = [".test", ".example", ".invalid", ".localhost"];

export const LOGO_CID = "tina-logo@tina";

export interface SesConfig {
  user: string;
  password: string;
  from: string;
  region: string;
}

export interface MailPayload {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailSendResult =
  | { ok: true; messageId: string; skipped?: false }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped?: false; error: string };

export type MailTransport = (
  cfg: SesConfig,
  payload: MailPayload,
  rawMime: string,
  messageId: string,
) => Promise<void>;

let cachedLogoBase64: string | null | undefined;
let testTransportOverride: MailTransport | null = null;

export function _setMailTransportForTests(transport: MailTransport | null): void {
  testTransportOverride = transport;
}

export function isValidEmailAddress(value: string): boolean {
  const addr = value.trim().toLowerCase();
  if (!addr || addr.length > 254) return false;
  if (/[\r\n]/.test(addr)) return false;
  return EMAIL_RE.test(addr);
}

export function isReservedTestEmail(address: string): boolean {
  const domain = address.trim().toLowerCase().split("@")[1] || "";
  if (!domain) return true;
  if (domain === "localhost" || domain === "example.com" || domain === "example.org" || domain === "example.net") {
    return true;
  }
  return RESERVED_TEST_TLDS.some((suffix) => domain.endsWith(suffix));
}

export function readSesConfig(): SesConfig | null {
  const user = (process.env.TINA_SES_SMTP_USER || "").trim();
  const password = (process.env.TINA_SES_SMTP_PASSWORD || "").trim();
  const from = (process.env.TINA_SES_FROM || "").trim().toLowerCase();
  const region = (process.env.TINA_SES_REGION || "us-east-1").trim().toLowerCase();
  if (!user || !password || !from) return null;
  if (!isValidEmailAddress(from) || !REGION_RE.test(region)) return null;
  return { user, password, from, region };
}

function loadLogoBase64(): string | null {
  if (cachedLogoBase64 !== undefined) return cachedLogoBase64;
  const candidates = [
    path.join(process.cwd(), "public", "tina-logo.png"),
    path.resolve(process.cwd(), "clients", "terminal", "public", "tina-logo.png"),
  ];
  for (const filePath of candidates) {
    try {
      const buf = readFileSync(filePath);
      if (buf.byteLength > 0) {
        cachedLogoBase64 = buf.toString("base64");
        return cachedLogoBase64;
      }
    } catch {
      /* Try next candidate */
    }
  }
  cachedLogoBase64 = null;
  return null;
}

function wrapBase64(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").replace(/\r\n$/, "");
}

function encodeHeaderUtf8(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  // RFC 2047 §2: each encoded-word must be <= 75 chars ("=?UTF-8?B?" + b64 + "?=" = 12 + b64).
  // 45 UTF-8 bytes base64-encode to 60 chars (72 chars total), splitting only on full codepoints.
  const MAX_CHUNK_BYTES = 45;
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of clean) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (currentBytes + chBytes > MAX_CHUNK_BYTES && current) {
      chunks.push(`=?UTF-8?B?${Buffer.from(current, "utf8").toString("base64")}?=`);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current) {
    chunks.push(`=?UTF-8?B?${Buffer.from(current, "utf8").toString("base64")}?=`);
  }
  return chunks.join("\r\n ");
}

function maskEmailForLog(address: string): string {
  const [local, domain] = address.split("@");
  if (!domain) return "***";
  const prefix = local ? `${local[0]}***` : "***";
  return `${prefix}@${domain}`;
}

export function buildMimeMessage(
  from: string,
  payload: MailPayload,
  messageId: string,
): string {
  const altBoundary = `tina_alt_${crypto.randomBytes(12).toString("hex")}`;
  const relBoundary = `tina_rel_${crypto.randomBytes(12).toString("hex")}`;
  const logoB64 = loadLogoBase64();

  const textPart = [
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrapBase64(Buffer.from(payload.text, "utf8").toString("base64")),
  ].join("\r\n");

  const htmlPart = [
    `Content-Type: text/html; charset="utf-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrapBase64(Buffer.from(payload.html, "utf8").toString("base64")),
  ].join("\r\n");

  const alternativeBody = [
    `--${altBoundary}`,
    textPart,
    `--${altBoundary}`,
    htmlPart,
    `--${altBoundary}--`,
  ].join("\r\n");

  const headers = [
    `From: Tina <${from}>`,
    `To: ${payload.to}`,
    `Subject: ${encodeHeaderUtf8(payload.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Auto-Submitted: auto-generated`,
  ];

  if (logoB64) {
    return [
      ...headers,
      `Content-Type: multipart/related; boundary="${relBoundary}"`,
      ``,
      `--${relBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      ``,
      alternativeBody,
      `--${relBoundary}`,
      `Content-Type: image/png; name="tina-logo.png"`,
      `Content-Transfer-Encoding: base64`,
      `Content-ID: <${LOGO_CID}>`,
      `Content-Disposition: inline; filename="tina-logo.png"`,
      ``,
      wrapBase64(logoB64),
      `--${relBoundary}--`,
      ``,
    ].join("\r\n");
  }

  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    ``,
    alternativeBody,
    ``,
  ].join("\r\n");
}

function dotStuff(data: string): string {
  const crlf = data.replace(/\r?\n/g, "\r\n");
  return crlf.replace(/(^|\r\n)\./g, "$1..");
}

async function sendViaSesSmtps(
  cfg: SesConfig,
  payload: MailPayload,
  rawMime: string,
): Promise<void> {
  const host = `email-smtp.${cfg.region}.amazonaws.com`;
  const ehloDomain = cfg.from.split("@")[1] || "meettina.site";

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let pendingReply: { resolve: (reply: { code: number; text: string }) => void; reject: (err: Error) => void } | null = null;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (pendingReply) {
        const p = pendingReply;
        pendingReply = null;
        p.reject(err);
      }
      socket.destroy();
      reject(err);
    };

    const socket = tls.connect({
      host,
      port: 465,
      servername: host,
      rejectUnauthorized: true,
    });

    socket.setTimeout(12000, () => fail(new Error("SES SMTP connection timed out")));
    socket.on("error", (err) => fail(err));
    socket.on("close", () => {
      if (!settled) fail(new Error("SES SMTP connection closed unexpectedly"));
    });

    const tryConsumeReply = () => {
      if (!pendingReply) return;
      const lines = buffer.split("\r\n");
      // Keep incomplete trailing fragment in buffer
      const completeLines = lines.slice(0, -1);
      for (let i = 0; i < completeLines.length; i++) {
        const line = completeLines[i];
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!match) continue;
        if (match[2] === " ") {
          const consumed = completeLines.slice(0, i + 1).join("\r\n") + "\r\n";
          buffer = buffer.slice(consumed.length);
          const p = pendingReply;
          pendingReply = null;
          p.resolve({ code: Number(match[1]), text: completeLines.slice(0, i + 1).join("\n") });
          return;
        }
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      tryConsumeReply();
    });

    const readReply = (): Promise<{ code: number; text: string }> =>
      new Promise((res, rej) => {
        pendingReply = { resolve: res, reject: rej };
        tryConsumeReply();
      });

    const sendCommand = async (cmd: string, expectedCodes: number[], label: string): Promise<void> => {
      socket.write(`${cmd}\r\n`);
      const reply = await readReply();
      if (!expectedCodes.includes(reply.code)) {
        throw new Error(`SES SMTP ${label} rejected (${reply.code})`);
      }
    };

    void (async () => {
      try {
        const banner = await readReply();
        if (banner.code !== 220) throw new Error(`SES SMTP banner rejected (${banner.code})`);
        await sendCommand(`EHLO ${ehloDomain}`, [250], "EHLO");
        await sendCommand("AUTH LOGIN", [334], "AUTH LOGIN");
        await sendCommand(Buffer.from(cfg.user, "utf8").toString("base64"), [334], "AUTH username");
        await sendCommand(Buffer.from(cfg.password, "utf8").toString("base64"), [235], "AUTH password");
        await sendCommand(`MAIL FROM:<${cfg.from}>`, [250], "MAIL FROM");
        await sendCommand(`RCPT TO:<${payload.to}>`, [250, 251], "RCPT TO");
        await sendCommand("DATA", [354], "DATA");
        socket.write(`${dotStuff(rawMime)}\r\n.\r\n`);
        const dataReply = await readReply();
        if (dataReply.code !== 250) throw new Error(`SES SMTP message rejected (${dataReply.code})`);
        settled = true;
        socket.end("QUIT\r\n");
        resolve();
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

/** Send one transactional email via Amazon SES SMTPS. Never throws; returns structured status. */
export async function sendSesEmail(payload: MailPayload): Promise<MailSendResult> {
  const to = payload.to.trim().toLowerCase();
  if (!isValidEmailAddress(to)) {
    return { ok: false, skipped: true, reason: "invalid_recipient" };
  }

  const cfg = readSesConfig();
  if (!cfg) {
    return { ok: false, skipped: true, reason: "ses_not_configured" };
  }

  if (!testTransportOverride && isReservedTestEmail(to)) {
    return { ok: false, skipped: true, reason: "reserved_test_domain" };
  }

  const domain = cfg.from.split("@")[1] || "meettina.site";
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const normalizedPayload: MailPayload = { ...payload, to };
  const rawMime = buildMimeMessage(cfg.from, normalizedPayload, messageId);

  try {
    if (testTransportOverride) {
      await testTransportOverride(cfg, normalizedPayload, rawMime, messageId);
    } else {
      await sendViaSesSmtps(cfg, normalizedPayload, rawMime);
    }
    return { ok: true, messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "SES delivery failed";
    // eslint-disable-next-line no-console
    console.warn(`[terminal-mail] SES send to ${maskEmailForLog(to)} failed: ${message}`);
    return { ok: false, error: message };
  }
}
