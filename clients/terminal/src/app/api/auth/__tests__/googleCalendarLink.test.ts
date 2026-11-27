// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_WELCOME_COOKIE, createGoogleCalendarLinkIntent, listGoogleCalendars, GOOGLE_CALENDAR_LINK_COOKIE } from "../googleCalendarLink";
import { GOOGLE_CALENDAR_PROVIDER, GOOGLE_CALENDAR_SCOPES } from "../../../../lib/googleCalendar";

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(), set: vi.fn(), login: vi.fn(), save: vi.fn(), validate: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (name: string) => mocks.jar.has(name) ? { value: mocks.jar.get(name) } : undefined,
  set: mocks.set,
}) }));
vi.mock("../adminApi", () => ({
  AUTH_COOKIE: "tina-token", USER_INFO_COOKIE: "tina-user-info",
  findOrCreateUserToken: mocks.login, linkGoogleCalendarAccount: mocks.save, validateAuthToken: mocks.validate,
}));
import { authOptions } from "../[...nextauth]/authOptions";

const callback = authOptions.callbacks!.signIn!;
function signIn(provider = GOOGLE_CALENDAR_PROVIDER) {
  const profile = { sub: "google-id", email: "linked@example.test", email_verified: true };
  return callback({
    user: { id: "other-google-user", email: "linked@example.test" },
    profile,
    account: { provider, type: "oauth", providerAccountId: "google-id",
      scope: GOOGLE_CALENDAR_SCOPES.join(" "), access_token: "synthetic-access", refresh_token: "synthetic-refresh" },
  });
}
const response = (items: unknown[], nextPageToken?: string) => new Response(JSON.stringify({ items, nextPageToken }));

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "synthetic-calendar-signing-secret");
  mocks.jar.clear();
  vi.clearAllMocks();
  mocks.validate.mockResolvedValue({ ok: true, userId: 1 });
  mocks.save.mockResolvedValue({ ok: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Calendar callback never falls back to TINA login", () => {
  it("rejects missing link intent without minting or changing login cookies", async () => {
    expect(await signIn()).toBe(false);
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("rejects expired link intent and preserves the TINA account", async () => {
    vi.useFakeTimers();
    mocks.jar.set("tina-token", "existing-owner-token");
    mocks.jar.set(GOOGLE_CALENDAR_LINK_COOKIE, createGoogleCalendarLinkIntent(1)!);
    vi.advanceTimersByTime(601_000);
    expect(await signIn()).toBe(false);
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.set.mock.calls.every(([name]) => name === GOOGLE_CALENDAR_LINK_COOKIE)).toBe(true);
  });
  it("links a different Google account to the authenticated TINA owner", async () => {
    mocks.jar.set("tina-token", "existing-owner-token");
    mocks.jar.set(CALENDAR_WELCOME_COOKIE, "first-login");
    mocks.jar.set(GOOGLE_CALENDAR_LINK_COOKIE, createGoogleCalendarLinkIntent(1)!);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{ id: "calendar", summary: "Work" }])));
    expect(await signIn()).toBe(true);
    expect(mocks.save).toHaveBeenCalledWith("existing-owner-token", expect.objectContaining({ email: "linked@example.test" }));
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith(CALENDAR_WELCOME_COOKIE, "", expect.objectContaining({ maxAge: 0 }));
  });
  it("continues normal Google login even when a stale link cookie exists", async () => {
    mocks.jar.set(GOOGLE_CALENDAR_LINK_COOKIE, "stale-intent");
    mocks.login.mockResolvedValue({ ok: true, token: "new-login", user: { email: "linked@example.test" } });
    expect(await signIn("google")).toBe(true);
    expect(mocks.login).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.set.mock.calls.some(([name]) => name === CALENDAR_WELCOME_COOKIE)).toBe(false);
  });
  it("never saves a partial CalendarList during reauthorization", async () => {
    mocks.jar.set("tina-token", "existing-owner-token");
    mocks.jar.set(GOOGLE_CALENDAR_LINK_COOKIE, createGoogleCalendarLinkIntent(1)!);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(
      Array.from({ length: 250 }, (_, i) => ({ id: `calendar-${i}` })), "more",
    )));
    expect(await signIn()).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.login).not.toHaveBeenCalled();
  });
});

it("offers Calendar on a new account only and clears a stale offer on returning login", async () => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
  const login = { ok: true, token: "login-token", user: { email: "linked@example.test" } };
  mocks.login.mockResolvedValueOnce({ ...login, justCreated: true })
    .mockResolvedValueOnce({ ...login, justCreated: false });

  expect(await signIn("google")).toBe(true);
  expect(mocks.set).toHaveBeenCalledWith(CALENDAR_WELCOME_COOKIE, expect.stringMatching(/^[\da-f-]{36}$/),
    expect.objectContaining({ maxAge: 86_400, httpOnly: true }));

  mocks.jar.set(CALENDAR_WELCOME_COOKIE, "first-login");
  expect(await signIn("google")).toBe(true);
  expect(mocks.set).toHaveBeenCalledWith(CALENDAR_WELCOME_COOKIE, "", expect.objectContaining({ maxAge: 0 }));
});

it("reads every page before returning a complete CalendarList", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response([{ id: "first" }], "next"))
    .mockResolvedValueOnce(response([{ id: "second" }]));
  vi.stubGlobal("fetch", fetcher);
  expect((await listGoogleCalendars("synthetic-access")).map((c) => c.id)).toEqual(["first", "second"]);
  expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("pageToken")).toBe("next");
});
