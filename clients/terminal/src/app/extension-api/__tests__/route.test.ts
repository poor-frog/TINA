// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { DELETE, GET, OPTIONS, POST } from "../[...path]/route";

function makeReq(
  method: string,
  headers: Record<string, string> = {},
  { search = "", body = "" } = {},
): NextRequest {
  return {
    method,
    headers: new Headers(headers),
    nextUrl: { search },
    text: async () => body,
  } as unknown as NextRequest;
}

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/extension-api proxy", () => {
  it("strips /extension-api, forwards extension auth & CORS headers, and never injects cookies or server keys", async () => {
    vi.stubEnv("GATEWAY_URL", "http://core.tina-staging.local:8000");
    vi.stubEnv("TINA_API_KEY", "server-secret-must-not-leak");
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ meetings: [] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        Vary: "Origin",
      },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const req = makeReq("GET", {
      Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      Authorization: "Bearer " + "x".repeat(43),
      Cookie: "tina-token=browser-cookie-must-not-forward",
    }, { search: "?limit=20" });

    const res = await GET(req, ctx("meetings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ meetings: [] });
    expect(res.headers.get("access-control-allow-origin")).toBe("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core.tina-staging.local:8000/meetings?limit=20");
    const sent = init.headers as Record<string, string>;
    expect(sent.authorization).toBe("Bearer " + "x".repeat(43));
    expect(sent.origin).toBe("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(sent["x-api-key"]).toBeUndefined();
    expect(sent.cookie).toBeUndefined();
  });

  it("forwards OPTIONS preflight and POST /agent/workspace/meeting-knowledge/:id/ask bodies cleanly", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { "Access-Control-Allow-Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Access-Control-Allow-Methods": "GET, POST, DELETE" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answer: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchSpy);

    const optRes = await OPTIONS(makeReq("OPTIONS", {
      Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    }), ctx("agent", "workspace", "meeting-knowledge", "42", "ask"));
    expect(optRes.status).toBe(200);
    expect(optRes.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE");

    const postRes = await POST(makeReq("POST", {
      Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      Authorization: "Bearer " + "y".repeat(43),
      "Content-Type": "application/json",
    }, { body: JSON.stringify({ question: "summary?" }) }), ctx("agent", "workspace", "meeting-knowledge", "42", "ask"));
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ answer: "ok" });
  });

  it("forwards DELETE 204 without crashing and blocks unallowlisted Gateway routes", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    const okDel = await DELETE(makeReq("DELETE"), ctx("bots", "google_meet", "abc-defg-hij"));
    expect(okDel.status).toBe(204);

    const blocked = await GET(makeReq("GET"), ctx("agent", "chat"));
    expect(blocked.status).toBe(404);
    const blockedKnowledge = await POST(makeReq("POST"), ctx("agent", "workspace", "meeting-knowledge", "42", "delete"));
    expect(blockedKnowledge.status).toBe(404);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
