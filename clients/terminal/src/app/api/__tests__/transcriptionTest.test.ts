import { afterEach, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { AUTH_COOKIE } from "../auth/adminApi";
import { GET } from "../transcription/test/route";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("requires the caller's session even when a deployment API key is set", async () => {
  vi.stubEnv("TINA_API_KEY", "deployment-key");
  vi.mocked(cookies).mockResolvedValue({ get: () => undefined } as never);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  expect((await GET()).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});

it("probes transcription through the Gateway in meetings mode with the session token", async () => {
  vi.stubEnv("NEXT_PUBLIC_TERMINAL_MODE", "meetings");
  vi.stubEnv("GATEWAY_URL", "http://gateway.test/");
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => name === AUTH_COOKIE ? { value: "session-token" } : undefined,
  } as never);
  const result = { ok: true, summary: "Audio probe passed" };
  const fetch = vi.fn().mockResolvedValue(Response.json(result));
  vi.stubGlobal("fetch", fetch);

  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  expect(fetch).toHaveBeenCalledWith("http://gateway.test/agent/transcription/test", expect.objectContaining({
    headers: { "X-API-Key": "session-token" },
    redirect: "error",
  }));
});
