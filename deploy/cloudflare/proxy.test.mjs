import assert from "node:assert/strict";
import test from "node:test";
import proxy from "./public/_worker.js";

const env = {
  TINA_PUBLIC_ORIGIN: "https://meettina.pages.dev",
  TINA_AWS_ORIGIN: "https://d2eanx74y89uq2.cloudfront.net",
};

test("rejects a different public hostname before contacting CloudFront", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch");
  assert.equal((await proxy.fetch(new Request("https://other.pages.dev/"), env)).status, 421);
  assert.equal(fetch.mock.callCount(), 0);
});

test("streams the body to a fixed origin and rebuilds forwarding headers", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.href, `${env.TINA_AWS_ORIGIN}//example.test/api/chat?q=1`);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers.get("host"), null);
    assert.equal(options.headers.get("forwarded"), null);
    assert.equal(options.headers.get("x-forwarded-host"), "meettina.pages.dev");
    assert.equal(options.headers.get("x-forwarded-proto"), "https");
    assert.equal(options.headers.get("origin"), env.TINA_PUBLIC_ORIGIN);
    assert.equal(options.headers.get("cookie"), "tina-token=fixture");
    assert.equal(await new Response(options.body).text(), "synthetic prompt");
    return new Response("data: done\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  const response = await proxy.fetch(new Request(`${env.TINA_PUBLIC_ORIGIN}//example.test/api/chat?q=1`, {
    method: "POST",
    headers: {
      host: "forged.test",
      forwarded: "host=forged.test",
      "x-forwarded-host": "forged.test",
      origin: env.TINA_PUBLIC_ORIGIN,
      cookie: "tina-token=fixture",
    },
    body: "synthetic prompt",
  }), env);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(await response.text(), "data: done\n\n");
});

test("rewrites only TINA redirects and keeps individual cookies", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response(null, {
    status: 302,
    headers: [
      ["location", `${env.TINA_AWS_ORIGIN}/terminal?next=wiki`],
      ["set-cookie", "first=1; Path=/"],
      ["set-cookie", "second=2; Expires=Wed, 21 Oct 2099 07:28:00 GMT"],
    ],
  }));
  const request = new Request(`${env.TINA_PUBLIC_ORIGIN}/`);
  const response = await proxy.fetch(request, env);
  assert.equal(response.headers.get("location"), `${env.TINA_PUBLIC_ORIGIN}/terminal?next=wiki`);
  assert.equal(response.headers.getSetCookie().length, 2);
  const external = "https://accounts.google.com/o/oauth2/auth?state=fixture";
  upstream.mock.mockImplementationOnce(async () => Response.redirect(external));
  assert.equal((await proxy.fetch(request, env)).headers.get("location"), external);
});

test("passes range requests and WebSocket upgrades through", async (t) => {
  const upgrade = { status: 101 };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.headers.get("upgrade") === "websocket") return upgrade;
    assert.equal(options.headers.get("range"), "bytes=0-3");
    return new Response("test", { status: 206, headers: { "Content-Range": "bytes 0-3/7" } });
  });
  const range = await proxy.fetch(new Request(`${env.TINA_PUBLIC_ORIGIN}/recording`, { headers: { range: "bytes=0-3" } }), env);
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 0-3/7");
  assert.equal(await proxy.fetch(new Request(`${env.TINA_PUBLIC_ORIGIN}/ws`, { headers: { upgrade: "websocket" } }), env), upgrade);
});
