# Cloudflare Pages staging entry point

`meettina.pages.dev` forwards Terminal traffic to the existing staging CloudFront
distribution. Set the Terminal stack's `StageUrl` and register the Google OAuth
callback on this hostname before using it for sign-in. The CloudFront hostname
is the upstream and the previous `StageUrl` can be restored during rollback.

Use `https://meettina.pages.dev` as the authorized Google origin and register
`/api/auth/callback/google` and `/api/auth/callback/google-calendar` on it.
Smoke-test `/edge-health`, `/terminal`, and the OAuth provider's generated
`redirect_uri` after the Terminal task rolls. Keep the existing CloudFront
redirect URI available for rollback.

From this directory, test and deploy the Pages advanced-mode worker with the
Pages project associated with `feat/staging-unified`.

```bash
node --test proxy.test.mjs
npx wrangler pages deploy --branch feat/staging-unified
```
