import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const ALLOWED_PATHS = [
  /^auth\/me$/,
  /^meetings(?:\/.+)?$/,
  /^bots(?:\/.+)?$/,
  /^transcripts\/.+$/,
  /^agent\/meeting-translations\/.+$/,
  /^agent\/workspace\/meeting-knowledge\/[1-9]\d*(?:\/ask|\/facts\/review|\/answers\/[a-f0-9]{32}\/apply)?$/,
];

const FORWARDED_REQUEST_HEADERS = [
  "origin",
  "access-control-request-method",
  "access-control-request-headers",
  "authorization",
  "x-api-key",
] as const;

const PASSTHROUGH_RESPONSE_HEADERS = [
  "content-type",
  "vary",
  "retry-after",
] as const;

function gatewayUrl(): string {
  return (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/$/, "");
}

function isAllowedExtensionPath(segments: string[]): string | null {
  if (!segments.length || segments.some((seg) => !seg || seg === "." || seg === ".." || /[/%\\?#\x00-\x1f\x7f]/.test(seg))) {
    return null;
  }
  const joined = segments.join("/");
  return ALLOWED_PATHS.some((pattern) => pattern.test(joined)) ? joined : null;
}

/** Proxy allowlisted `/extension-api/*` calls to the Gateway without leaking browser session cookies or server keys. */
async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const joined = isAllowedExtensionPath((await params).path);
  if (!joined) {
    return new Response(JSON.stringify({ detail: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers[name] = value;
  }

  const init: RequestInit = { method: req.method, headers, cache: "no-store" };
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && req.method !== "DELETE") {
    const body = await req.text();
    if (body) {
      init.body = body;
      headers["Content-Type"] = req.headers.get("content-type") || "application/json";
    }
  }

  try {
    const upstream = await fetch(`${gatewayUrl()}/${joined}${req.nextUrl.search}`, init);
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    upstream.headers.forEach((value, name) => {
      if (name.toLowerCase().startsWith("access-control-")) {
        responseHeaders.set(name, value);
      }
    });
    if (upstream.status === 204 || upstream.status === 205 || upstream.status === 304) {
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }
    return new Response(await upstream.text(), { status: upstream.status, headers: responseHeaders });
  } catch (err) {
    console.error(`[extension-api] upstream error for ${req.method} /${joined}`, err);
    return new Response(JSON.stringify({ error: "upstream_error" }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}

export { forward as GET, forward as POST, forward as DELETE, forward as OPTIONS };
