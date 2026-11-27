# Extension Gateway Proxy

Same-origin `/extension-api/*` entry point that mirrors `deploy/aws/Caddyfile` by stripping the
prefix and forwarding only extension-allowed Gateway routes (`Authorization: Bearer` / `X-API-Key`)
without injecting browser cookies or server keys.
