// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ jwt: vi.fn(), validate: vi.fn(), internal: vi.fn() }));
vi.mock("next-auth/jwt", () => ({ getToken: mocks.jwt }));
vi.mock("../[...nextauth]/authOptions", () => ({ isSecureRequest: () => true }));
vi.mock("../adminApi", () => ({ AUTH_COOKIE: "tina-token", validateAuthToken: mocks.validate, internalRequest: mocks.internal }));

import { OPTIONS, POST } from "../extension/[action]/route";

const site = "https://tina.example.test", id = "a".repeat(32);
const origin = `chrome-extension://${id}`;
const code = "z".repeat(43), challenge = "c".repeat(43);

const params = (action: string) => ({ params: Promise.resolve({ action }) });
const request = (action: string, from: string, body: Record<string, unknown>, cookie = "tina-token=fixture") =>
  new NextRequest(`${site}/api/auth/extension/${action}`, {
    method: "POST", headers: { Origin: from, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_URL", site);
  vi.stubEnv("NEXTAUTH_SECRET", "test-oauth-secret-for-extension-fixture");
  vi.stubEnv("TINA_GATEWAY_EXTENSION_ORIGINS", origin);
  vi.resetAllMocks();
});
afterEach(() => { vi.unstubAllEnvs(); });

it("binds the verified Google session to the validated Terminal account, not body claims", async () => {
  const payload = { extension_id: id, challenge, user_id: 52, subject: "forged" };
  mocks.jwt.mockResolvedValue({ tinaGoogleSubject: "verified-google-subject" });
  mocks.validate.mockResolvedValue({ ok: true, userId: 51 });
  mocks.internal.mockResolvedValue({ ok: true, data: { code } });

  expect((await POST(request("authorize", origin, payload), params("authorize"))).status).toBe(403);
  expect((await POST(request("authorize", site, payload, ""), params("authorize"))).status).toBe(401);
  expect(mocks.internal).not.toHaveBeenCalled();

  const response = await POST(request("authorize", site, payload), params("authorize"));
  expect(await response.json()).toEqual({ code });
  const [path, config] = mocks.internal.mock.calls[0];
  expect(path).toBe("/internal/extension/code");
  expect(JSON.parse(config.body)).toEqual({
    extension_id: id, challenge, user_id: 51, subject: "verified-google-subject",
  });
});

it("limits exchanges and CORS to configured extension origins", async () => {
  const payload = { credential: code, verifier: "v".repeat(43) };
  const wrong = "chrome-extension://" + "b".repeat(32);
  expect((await POST(request("exchange", wrong, payload), params("exchange"))).status).toBe(403);
  expect(mocks.internal).not.toHaveBeenCalled();
  mocks.internal.mockResolvedValue({ ok: true, data: { ok: true } });
  const response = await POST(request("exchange", origin, payload, ""), params("exchange"));
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.validate).not.toHaveBeenCalled();
  expect((await OPTIONS(request("exchange", origin, payload), params("exchange"))).status).toBe(204);
  expect((await OPTIONS(request("exchange", wrong, payload), params("exchange"))).status).toBe(403);
});
