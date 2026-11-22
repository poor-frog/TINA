import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { isSecureRequest } from "../../[...nextauth]/authOptions";
import { AUTH_COOKIE, internalRequest, validateAuthToken } from "../../adminApi";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EXTENSION = /^chrome-extension:\/\/([a-p]{32})$/;
const noStore = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ action: string }> };

function extensionId(origin: string) {
  const allowed = (process.env.TINA_GATEWAY_EXTENSION_ORIGINS || "").split(",").map(value => value.trim());
  return allowed.includes(origin) ? EXTENSION.exec(origin)?.[1] : undefined;
}

function cors(origin: string) {
  return { ...noStore, Vary: "Origin", "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true" };
}

function serverOrigin() {
  const url = process.env.NEXTAUTH_URL || process.env.TERMINAL_URL;
  return url ? new URL(url).origin : null;
}

export async function OPTIONS(request: NextRequest, context: Context) {
  const { action } = await context.params;
  const origin = request.headers.get("origin") || "";
  if (!["exchange", "refresh", "logout"].includes(action) || !extensionId(origin)) {
    return new NextResponse(null, { status: 403, headers: noStore });
  }
  return new NextResponse(null, { status: 204, headers: cors(origin) });
}

export async function POST(request: NextRequest, context: Context) {
  const { action } = await context.params;
  const origin = request.headers.get("origin") || "";
  const extension = extensionId(origin);
  const headers = extension ? cors(origin) : noStore;
  const error = (message: string, status: number) => NextResponse.json({ error: message }, { status, headers });

  if (action === "authorize" ? !origin || origin !== serverOrigin() : !extension) {
    return error("This origin is not authorized", 403);
  }

  if (!request.headers.get("content-type")?.startsWith("application/json")) return error("Expected JSON", 415);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return error("Invalid request", 400);

  let result;
  if (action === "authorize") {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret || secret === "dev-nextauth-secret" || secret.length < 32) {
      return error("Configure a unique NEXTAUTH_SECRET to connect the extension", 503);
    }
    const id = typeof body.extension_id === "string" && extensionId(`chrome-extension://${body.extension_id}`);
    if (!id || typeof body.challenge !== "string" || !TOKEN.test(body.challenge)) {
      return error("The extension is not configured on this TINA instance", 400);
    }
    const session = await getToken({ req: request, secureCookie: isSecureRequest() });
    const auth = request.cookies.get(AUTH_COOKIE)?.value;
    if (typeof session?.tinaGoogleSubject !== "string" || !auth) {
      return error("Sign in with Google before connecting", 401);
    }
    const user = await validateAuthToken(auth);
    if (!user.ok) return error(user.status === 401 ? "Sign in with Google before connecting" : "Identity service unavailable", user.status);
    result = await internalRequest("/internal/extension/code", {
      method: "POST", body: JSON.stringify({ subject: session.tinaGoogleSubject, user_id: Number(user.userId),
        extension_id: id, challenge: body.challenge }),
    });
  } else if (["exchange", "refresh", "logout"].includes(action)) {
    if (typeof body.credential !== "string" || !TOKEN.test(body.credential)
        || (action === "exchange" && (typeof body.verifier !== "string" || !TOKEN.test(body.verifier)))) {
      return error("Invalid request", 400);
    }
    result = await internalRequest("/internal/extension/session", {
      method: "POST", body: JSON.stringify({ action, extension_id: extension, credential: body.credential,
        ...(action === "exchange" && { verifier: body.verifier }) }),
    });
  } else return error("Not found", 404);

  if (!result.ok) {
    const status = result.status || 503;
    return error(status === 401 || status === 403 ? "Sign in again to connect TINA" : "Unable to connect TINA", status);
  }
  return NextResponse.json(result.data, { headers });
}
