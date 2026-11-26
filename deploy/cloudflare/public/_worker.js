export default {
  async fetch(request, env) {
    const publicUrl = new URL(request.url);
    if (publicUrl.origin !== env.TINA_PUBLIC_ORIGIN) {
      return new Response("Unknown TINA hostname", { status: 421 });
    }

    const upstreamUrl = new URL(env.TINA_AWS_ORIGIN);
    upstreamUrl.pathname = publicUrl.pathname;
    upstreamUrl.search = publicUrl.search;
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("forwarded");
    headers.delete("x-forwarded-for");
    headers.set("x-forwarded-host", publicUrl.host);
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-port", "443");

    let response;
    try {
      // Keep redirect destinations in the browser, including OAuth and signed S3 URLs.
      response = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.body,
        duplex: "half",
        redirect: "manual",
        cache: "no-store",
      });
    } catch {
      return new Response("TINA staging is temporarily unavailable", {
        status: 502,
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (response.status === 101) return response;

    const output = new Headers(response.headers);
    const location = output.get("location");
    if (location && URL.canParse(location, upstreamUrl)) {
      const redirect = new URL(location, upstreamUrl);
      if (redirect.origin === upstreamUrl.origin) {
        redirect.host = publicUrl.host;
        output.set("location", redirect.href);
      }
    }
    output.set("cache-control", "private, no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: output,
    });
  },
};
