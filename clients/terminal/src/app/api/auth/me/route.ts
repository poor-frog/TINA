/** Who-am-I — reads the httpOnly `tina-user-info` cookie (set at login). The login gate calls this to
 *  decide whether to show the email-entry form. No backend round-trip: presence of the auth + user-info
 *  cookies means authenticated. */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { AUTH_COOKIE, USER_INFO_COOKIE } from "../adminApi";
import { googleAvatarUrl } from "../googleAvatar";
import { authOptions } from "../[...nextauth]/authOptions";
import { canUseWorkspacePilot } from "../workspacePilot";
import { hideModelSettings, workspacePilotMode } from "../../../mode";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  const info = cookieStore.get(USER_INFO_COOKIE)?.value;

  if (!token) {
    return NextResponse.json({ authenticated: false }, { status: 401, headers: NO_STORE });
  }

  let email: string | undefined;
  let name: string | undefined;
  let image: string | null = null;
  if (info) {
    try {
      const profile = JSON.parse(info) as { email?: string; name?: string; image?: string };
      ({ email, name } = profile);
      image = googleAvatarUrl(profile.image);
    } catch {
      /* malformed cookie — still authenticated by the token, just no email to show */
    }
  }
  if (!image) {
    try {
      const session = await getServerSession(authOptions);
      image = googleAvatarUrl(session?.user?.image);
    } catch {
      /* Existing TINA auth remains valid even if an older OAuth session has expired. */
    }
  }

  return NextResponse.json(
    { authenticated: true, user: { email: email ?? null, name: name ?? null, image },
      ...(workspacePilotMode() ? { workspacePilot: await canUseWorkspacePilot() } : {}),
      ...(process.env.NEXT_PUBLIC_HIDE_MODEL_SETTINGS !== undefined
        ? { hideModelSettings: hideModelSettings() }
        : {}) },
    { headers: NO_STORE },
  );
}
