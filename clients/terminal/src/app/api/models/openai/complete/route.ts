import { NextRequest, NextResponse } from "next/server";
import { callbackUri, completeChatGPTSignIn, currentTinaSubject } from "../../../../../lib/chatgptPlanAuth";
import { workspacePilotMode } from "../../../../mode";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest) {
  if (workspacePilotMode()) {
    return NextResponse.json({ error: "Contact your staging operator to manage Workspace ChatGPT." }, { status: 403, headers });
  }
  const origin = req.headers.get("origin");
  try {
    if (req.headers.get("sec-fetch-site") === "cross-site"
        || (origin && new URL(origin).host !== (req.headers.get("host") || req.nextUrl.host))) {
      return NextResponse.json({ error: "Origin refused" }, { status: 403, headers });
    }
  } catch { return NextResponse.json({ error: "Origin refused" }, { status: 403, headers }); }
  const subject = await currentTinaSubject();
  if (!subject) return NextResponse.json({ error: "Sign in to TINA first." }, { status: 401, headers });
  try {
    const raw = await req.text();
    if (raw.length > 16384) return NextResponse.json({ error: "Callback URL too long" }, { status: 413, headers });
    const body = JSON.parse(raw) as { callback_url?: unknown };
    if (typeof body?.callback_url !== "string") throw new Error();
    const url = new URL(body.callback_url.trim()), expected = new URL(callbackUri());
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) throw new Error();
    try {
      await completeChatGPTSignIn(subject, url);
      return NextResponse.json({ connected: true }, { headers });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 200) : "ChatGPT sign-in failed." }, { status: 400, headers });
    }
  } catch {
    return NextResponse.json({ error: "Paste the complete callback URL shown after ChatGPT sign-in." }, { status: 400, headers });
  }
}
