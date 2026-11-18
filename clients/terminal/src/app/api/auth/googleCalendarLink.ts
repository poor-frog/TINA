import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const GOOGLE_CALENDAR_LINK_COOKIE = "tina-google-calendar-link";
const LINK_INTENT_TTL_MS = 10 * 60 * 1000;
const MAX_CALENDAR_LIST_BYTES = 1_000_000;

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function createGoogleCalendarLinkIntent(userId: string | number): string | null {
  const secret = process.env.NEXTAUTH_SECRET || "";
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({
    userId: String(userId),
    expiresAt: Date.now() + LINK_INTENT_TTL_MS,
    nonce: randomBytes(24).toString("base64url"),
  })).toString("base64url");
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function verifyGoogleCalendarLinkIntent(value: string, userId: string | number): boolean {
  const secret = process.env.NEXTAUTH_SECRET || "";
  if (!secret) return false;
  const [payload, supplied, extra] = value.split(".");
  if (!payload || !supplied || extra !== undefined) return false;
  try {
    const expected = signature(payload, secret);
    const actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId?: unknown; expiresAt?: unknown; nonce?: unknown;
    };
    return body.userId === String(userId)
      && typeof body.expiresAt === "number"
      && body.expiresAt >= Date.now()
      && body.expiresAt <= Date.now() + LINK_INTENT_TTL_MS
      && typeof body.nonce === "string"
      && body.nonce.length >= 32;
  } catch {
    return false;
  }
}

export async function listGoogleCalendars(accessToken: string): Promise<Array<{
  id: string; summary: string; primary: boolean; time_zone?: string;
}>> {
  const calendars: Array<{ id: string; summary: string; primary: boolean; time_zone?: string }> = [];
  let pageToken: string | undefined;
  let totalBytes = 0;
  for (let page = 0; page < 5; page++) {
    const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    url.searchParams.set("minAccessRole", "reader");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("fields", "items(id,summary,primary,timeZone),nextPageToken");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("Google Calendar list request failed");
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_CALENDAR_LIST_BYTES) throw new Error("Google Calendar list is too large");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Google Calendar list response is empty");
    const chunks: Uint8Array[] = [];
    let pageBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pageBytes += value.byteLength;
      totalBytes += value.byteLength;
      if (pageBytes > MAX_CALENDAR_LIST_BYTES || totalBytes > MAX_CALENDAR_LIST_BYTES) {
        await reader.cancel();
        throw new Error("Google Calendar list is too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(pageBytes);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(bytes)) as {
      items?: Array<{ id?: unknown; summary?: unknown; primary?: unknown; timeZone?: unknown }>;
      nextPageToken?: unknown;
    };
    if (!Array.isArray(body.items) && body.items !== undefined) throw new Error("Invalid Google Calendar list");
    for (const item of body.items ?? []) {
      if (typeof item.id !== "string" || !item.id || item.id.length > 512) continue;
      calendars.push({
        id: item.id,
        summary: typeof item.summary === "string" ? item.summary.slice(0, 300) : item.id,
        primary: item.primary === true,
        ...(typeof item.timeZone === "string" ? { time_zone: item.timeZone.slice(0, 128) } : {}),
      });
      if (calendars.length > 250) throw new Error("Google account has too many calendars to link");
    }
    if (typeof body.nextPageToken !== "string" || !body.nextPageToken) return calendars;
    if (calendars.length >= 250) throw new Error("Google account has too many calendars to link");
    pageToken = body.nextPageToken;
  }
  throw new Error("Google Calendar list is incomplete");
}
