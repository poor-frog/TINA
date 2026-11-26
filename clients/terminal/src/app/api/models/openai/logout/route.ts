import { NextRequest, NextResponse } from "next/server";
import { currentTinaSubject, chatGPTConnection, cancelPendingChatGPTAuth } from "../../../../../lib/chatgptPlanAuth";
import { workspacePilotMode } from "../../../../mode";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest) {
  if (workspacePilotMode()) {
    return NextResponse.json({ error: "Contact your staging operator to manage Workspace ChatGPT." }, { status: 403, headers });
  }
  const origin = req.headers.get("origin");
  let refused = req.headers.get("sec-fetch-site") === "cross-site";
  try { if (origin) refused ||= new URL(origin).host !== (req.headers.get("host") || req.nextUrl.host); }
  catch { refused = true; }
  if (refused) {
    return NextResponse.json({ error: "Origin refused" }, { status: 403, headers });
  }
  const subject = await currentTinaSubject();
  if (!subject) return NextResponse.json({ error: "Sign in to TINA first." }, { status: 401, headers });
  try {
    cancelPendingChatGPTAuth(subject);
    await chatGPTConnection(subject, "DELETE");
    return NextResponse.json({ connected: false }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not disconnect ChatGPT. Retry shortly." }, { status: 503, headers });
  }
}
