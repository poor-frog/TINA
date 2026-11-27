import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { getCookie, validateAuthToken, internalRequest } = vi.hoisted(() => ({
  getCookie: vi.fn(),
  validateAuthToken: vi.fn(),
  internalRequest: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: getCookie }) }));
vi.mock("../auth/adminApi", () => ({
  AUTH_COOKIE: "tina-token",
  validateAuthToken,
  internalRequest,
}));

import { GET, PUT } from "../person-settings/route";

describe("/api/person-settings", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests with 401", async () => {
    getCookie.mockReturnValue(undefined);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(validateAuthToken).not.toHaveBeenCalled();
  });

  it("loads the verified user's settings from admin-api internal edge", async () => {
    getCookie.mockReturnValue({ value: "tok-123" });
    validateAuthToken.mockResolvedValue({ ok: true, userId: 42, email: "quang@gmail.com", isAdmin: false });
    internalRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { timezone: "", mail_minutes: true, mail_join: false, mail_rsvp: true, mail_prep: true },
    });

    const res = await GET();
    expect(res.status).toBe(200);
    expect(internalRequest).toHaveBeenCalledWith("/internal/users/42/settings", { method: "GET" });
    expect(await res.json()).toEqual({
      timezone: "",
      mail_minutes: true,
      mail_join: false,
      mail_rsvp: true,
      mail_prep: true,
    });
  });

  it("validates PUT updates and persists them for the verified user", async () => {
    getCookie.mockReturnValue({ value: "tok-123" });
    validateAuthToken.mockResolvedValue({ ok: true, userId: 42, email: "quang@gmail.com", isAdmin: false });
    internalRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { timezone: "", mail_minutes: false, mail_join: false, mail_rsvp: true, mail_prep: true },
    });

    const req = new NextRequest("https://meettina.site/api/person-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mail_minutes: false }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(internalRequest).toHaveBeenCalledWith("/internal/users/42/settings", {
      method: "PUT",
      body: JSON.stringify({ mail_minutes: false }),
    });
    expect(await res.json()).toMatchObject({ mail_minutes: false, mail_rsvp: true });
  });

  it("rejects unknown keys and non-boolean mail toggles with 400", async () => {
    getCookie.mockReturnValue({ value: "tok-123" });
    validateAuthToken.mockResolvedValue({ ok: true, userId: 42, email: "quang@gmail.com", isAdmin: false });

    const badKeyReq = new NextRequest("https://meettina.site/api/person-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_name: "Hacker" }),
    });
    expect((await PUT(badKeyReq)).status).toBe(400);

    const badTypeReq = new NextRequest("https://meettina.site/api/person-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mail_minutes: "yes" }),
    });
    expect((await PUT(badTypeReq)).status).toBe(400);
    expect(internalRequest).not.toHaveBeenCalled();
  });
});
