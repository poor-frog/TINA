import { cookies } from "next/headers";
import { AUTH_COOKIE, validateAuthToken } from "./adminApi";
import { workspacePilotMode } from "../../mode";

const RESERVED_WORKSPACE_SLUGS = new Set([
  "tree", "file", "search", "document", "git", "git-token", "git-remote-status",
  "init", "active", "attached", "shared", "purpose", "new", "upload",
  "activate", "deactivate", "rename", "swap", "publish", "push", "pull",
  "members", "invites", "meeting-knowledge",
]);

/** Each stage includes the routes verified in the preceding stage. */
export function pilotRouteEnabled(path: string, method?: string): boolean {
  const stage = process.env.TINA_WORKSPACE_PILOT_STAGE;
  if (stage !== "chat" && stage !== "wiki" && stage !== "routines") return false;
  if (path.split("/").some(seg => !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(seg))) return false;
  if (/^(chat(?:\/(?:reset|stop|approval))?|sessions(?:\/[^/]+\/history)?|models(?:\/(?:test|catalog|openai\/catalog))?|dictation\/(?:polish|translate)|meeting\/(?:process|jitsi-hosts|relay-health)|meeting-translations\/[^/]+|discussion-reviews\/[^/]+|workspace\/meeting-knowledge\/[^/]+(?:\/(?:ask|apply|facts\/review|answers\/[^/]+|source-profiles(?:\/remove)?|voice-drafts(?:\/[^/]+\/review)?))?)$/.test(path)) return true;
  if (stage === "chat") return false;
  if (/^workspace\/(tree|file|search|document(?:\/(?:move(?:\/preview)?|delete))?|git(?:\/show)?|init|active|attached|shared|purpose|new|upload|activate|deactivate|swap|rename|members(?:\/[^/]+(?:\/role)?)?|invites(?:\/[^/]+)?|shared\/(?:new|[^/]+\/active)|[^/]+\/(?:share-enable|leave|unshare|archive))$/.test(path)) return true;
  if (method?.toUpperCase() === "DELETE" && /^workspace\/[^/]+$/.test(path)) {
    const slug = path.slice("workspace/".length);
    if (!RESERVED_WORKSPACE_SLUGS.has(slug)) return true;
  }
  return stage === "routines" && /^routines(?:\/[^/]+(?:\/enabled)?)?$/.test(path);
}

export async function canUseWorkspacePilot(path = "chat", method?: string) {
  if (!workspacePilotMode()) return true;
  if (!pilotRouteEnabled(path, method)) return false;
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!token) return false;
  const user = await validateAuthToken(token);
  const allowed = (process.env.TINA_WORKSPACE_PILOT_USER_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return user.ok && (allowed.includes("*") || allowed.includes(String(user.userId)));
}
