/** NextAuth config for the terminal's OAuth broker (Google + Microsoft). Kept in its own module because
 *  an App Router `route.ts` may only export HTTP handlers — re-exporting `authOptions` from there fails
 *  Next's route-type check. NextAuth owns ONLY the OAuth dance; the terminal's auth contract is the
 *  httpOnly `tina-token` + `tina-user-info` cookies (read by server.mjs's WS proxy, api/proxyAuth.ts,
 *  and api/auth/me). So `signIn` ends by setting those exact cookies, via the SAME find-or-create+mint
 *  path the direct email login uses (findOrCreateUserToken in ../adminApi.ts). Mirrors the production
 *  webapp route, trimmed and reusing our admin client.
 *
 *  Providers self-gate on env presence, so a deploy with no OAuth creds simply exposes no providers
 *  (the email debug login still works). Credentials come from tina-secrets (see .env.local).
 */
import { type AuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import AzureADProvider from "next-auth/providers/azure-ad";
import { cookies } from "next/headers";
import { AUTH_COOKIE, USER_INFO_COOKIE, findOrCreateUserToken, linkGoogleCalendarAccount, validateAuthToken } from "../adminApi";
import { sendLoginEmail } from "../../mail/templates";
import { googleAvatarUrl } from "../googleAvatar";
import { GOOGLE_CALENDAR_LINK_COOKIE, listGoogleCalendars, verifyGoogleCalendarLinkIntent } from "../googleCalendarLink";
import { GOOGLE_CALENDAR_PROVIDER, GOOGLE_CALENDAR_AUTHORIZATION_PARAMS, GOOGLE_CALENDAR_SCOPES } from "../../../../lib/googleCalendar";

const isGoogleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const isMicrosoftEnabled = () =>
  !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);

/** Secure cookies behind HTTPS, mirroring the login route's isSecureRequest(). */
export function isSecureRequest(): boolean {
  return (
    (process.env.NEXTAUTH_URL || "").startsWith("https://") ||
    (process.env.TERMINAL_URL || "").startsWith("https://") ||
    process.env.NODE_ENV === "production"
  );
}

export const authOptions: AuthOptions = {
  providers: [
    // prompt=select_account forces the provider's account chooser EVERY time, so after logout a user can
    // pick a different account instead of being silently re-authenticated into the last one (the provider
    // keeps its own session — without this it auto-returns the previous identity and logout looks broken).
    ...(isGoogleEnabled()
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            authorization: { params: { prompt: "select_account" } },
          }),
          GoogleProvider({
            id: GOOGLE_CALENDAR_PROVIDER,
            name: "Google Calendar",
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            authorization: { params: GOOGLE_CALENDAR_AUTHORIZATION_PARAMS },
          }),
        ]
      : []),
    ...(isMicrosoftEnabled()
      ? [
          AzureADProvider({
            id: "microsoft",
            name: "Microsoft",
            clientId: process.env.MICROSOFT_CLIENT_ID!,
            clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
            tenantId: process.env.MICROSOFT_TENANT_ID || "common",
            authorization: { params: { prompt: "select_account" } },
          }),
        ]
      : []),
  ],
  session: { strategy: "jwt" },
  secret: process.env.NEXTAUTH_SECRET,
  // Behind an HTTPS reverse proxy, NextAuth infers secure cookies from the URL; match that.
  useSecureCookies: isSecureRequest(),
  pages: { signIn: "/", error: "/" },
  callbacks: {
    /** The load-bearing step: turn a verified OAuth identity into the terminal's `tina-token` +
     *  `tina-user-info` cookies, reusing the admin-api find-or-create+mint flow. Deny on any failure. */
    async signIn({ user, account, profile }) {
      const provider = account?.provider;
      if (provider === GOOGLE_CALENDAR_PROVIDER && account) {
        const cookieStore = await cookies();
        const intent = cookieStore.get(GOOGLE_CALENDAR_LINK_COOKIE)?.value;
        // Linking has its own provider/callback so an expired intent can never become a login.
        if (!intent) return false;
        const clearIntent = () => cookieStore.set(GOOGLE_CALENDAR_LINK_COOKIE, "", {
          httpOnly: true, secure: isSecureRequest(), sameSite: "lax", maxAge: 0, path: "/api/auth",
        });
        try {
          const tinaToken = cookieStore.get(AUTH_COOKIE)?.value;
          const identity = tinaToken ? await validateAuthToken(tinaToken) : { ok: false as const };
          if (!tinaToken || !identity.ok || !verifyGoogleCalendarLinkIntent(intent, identity.userId)) {
            clearIntent();
            return false;
          }
          const granted = new Set((account.scope || "").split(/\s+/).filter(Boolean));
          if (!GOOGLE_CALENDAR_SCOPES.every((scope) => granted.has(scope))
              || !account.access_token || !account.providerAccountId || !user.email) {
            clearIntent();
            return false;
          }
          const calendars = await listGoogleCalendars(account.access_token);
          if (!calendars.length) {
            clearIntent();
            return false;
          }
          const saved = await linkGoogleCalendarAccount(tinaToken, {
            provider_account_id: account.providerAccountId,
            email: user.email,
            refresh_token: account.refresh_token,
            calendars,
          });
          clearIntent();
          return saved.ok;
        } catch {
          clearIntent();
          return false;
        }
      }
      if ((provider !== "google" && provider !== "microsoft") || !user.email) return false;

      const google = profile as { sub?: string; email_verified?: boolean } | undefined;
      if (provider === "google" && (!google?.sub || google.sub !== account?.providerAccountId || google.email_verified !== true)) return false;
      const email = user.email.toLowerCase();
      // Existing non-Gmail web sign-in keeps its legacy path. Extension pairing requires a Gmail binding.
      const googleSubject = provider === "google" && email.endsWith("@gmail.com") ? google!.sub : undefined;
      const result = await findOrCreateUserToken(email, googleSubject);
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error(`[terminal-auth] ${provider} sign-in failed for ${user.email}: ${result.error}`);
        return false;
      }

      const opts = {
        httpOnly: true,
        secure: isSecureRequest(),
        sameSite: "lax" as const,
        maxAge: 60 * 60 * 24 * 30,
        path: "/",
      };
      const cookieStore = await cookies();
      cookieStore.set(AUTH_COOKIE, result.token, opts);
      const displayName = user.name || result.user.name || result.user.email.split("@")[0];
      const image = provider === "google" ? googleAvatarUrl(user.image) : null;
      cookieStore.set(USER_INFO_COOKIE, JSON.stringify({ email: result.user.email, name: displayName, image }), opts);
      // Best-effort login / welcome notification via Amazon SES — never blocks sign-in.
      void sendLoginEmail({
        email: result.user.email,
        name: displayName,
        provider,
        isNewUser: result.justCreated,
      }).catch(() => undefined);
      return true;
    },
    async jwt({ token, account, profile }) {
      if (account) {
        const google = profile as { sub?: string; email?: string; email_verified?: boolean } | undefined;
        delete token.tinaGoogleSubject;
        if (account.provider === "google" && google?.email_verified === true && google.sub === account.providerAccountId
            && google.email?.toLowerCase().endsWith("@gmail.com")) token.tinaGoogleSubject = google.sub;
      }
      return token;
    },
    // Land back on the workbench, HONORING a same-origin callbackUrl so an invite link's ?invite=<token>
    // survives the OAuth round-trip (InviteRedeemer then redeems it post-auth). Off-origin URLs → baseUrl.
    async redirect({ url, baseUrl }) {
      try {
        const target = new URL(url, baseUrl);
        if (target.origin === new URL(baseUrl).origin) return target.href;
      } catch { /* malformed callback returns to Terminal */ }
      return baseUrl;
    },
  },
};
