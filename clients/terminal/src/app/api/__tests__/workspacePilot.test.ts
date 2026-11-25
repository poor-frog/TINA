import { afterEach, describe, expect, it, vi } from "vitest";

const { get, validateAuthToken } = vi.hoisted(() => ({ get: vi.fn(), validateAuthToken: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get }) }));
vi.mock("../auth/adminApi", () => ({ AUTH_COOKIE: "tina-token", validateAuthToken }));

import { canUseWorkspacePilot, pilotRouteEnabled } from "../auth/workspacePilot";

describe("workspace pilot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("opens only the released routes", () => {
    for (const stage of ["closed", "chat", "wiki", "routines"]) {
      vi.stubEnv("TINA_WORKSPACE_PILOT_STAGE", stage);
      expect(pilotRouteEnabled("sessions/thread-1/history")).toBe(stage !== "closed");
      expect(pilotRouteEnabled("models")).toBe(stage !== "closed");
      expect(pilotRouteEnabled("models/test")).toBe(stage !== "closed");
      expect(pilotRouteEnabled("models/catalog")).toBe(stage !== "closed");
      expect(pilotRouteEnabled("models/openai/catalog")).toBe(stage !== "closed");
      expect(pilotRouteEnabled("workspace/meeting-knowledge/14")).toBe(stage !== "closed");
      expect(pilotRouteEnabled("workspace/meeting-knowledge/14/source-profiles")).toBe(stage !== "closed");
      expect(pilotRouteEnabled("workspace/meeting-knowledge/14/source-profiles/remove")).toBe(stage !== "closed");
      expect(pilotRouteEnabled("workspace/meeting-knowledge/14/voice-drafts")).toBe(stage !== "closed");
      expect(pilotRouteEnabled("workspace/meeting-knowledge/14/voice-drafts/d1/review")).toBe(stage !== "closed");
      expect(pilotRouteEnabled("workspace/members")).toBe(["wiki", "routines"].includes(stage));
      expect(pilotRouteEnabled("workspace/search")).toBe(["wiki", "routines"].includes(stage));
      expect(pilotRouteEnabled("workspace/document")).toBe(["wiki", "routines"].includes(stage));
      expect(pilotRouteEnabled("workspace/document/move/preview")).toBe(["wiki", "routines"].includes(stage));
      expect(pilotRouteEnabled("workspace/document/delete")).toBe(["wiki", "routines"].includes(stage));
      expect(pilotRouteEnabled("routines/daily/enabled")).toBe(stage === "routines");
      for (const path of ["internal/openai-auth", "workspace/git-token", "workspace/meeting-knowledge/14/ask", "workspace/../events"]) {
        expect(pilotRouteEnabled(path)).toBe(false);
      }
    }
  });

  it("uses verified account IDs, supports wildcard allowlist, and ignores display cookies", async () => {
    vi.stubEnv("NEXT_PUBLIC_TERMINAL_MODE", "workspace-pilot");
    vi.stubEnv("TINA_WORKSPACE_PILOT_USER_IDS", "11,12");
    vi.stubEnv("TINA_WORKSPACE_PILOT_STAGE", "chat");
    get.mockReturnValue({ value: "session" });
    validateAuthToken.mockResolvedValueOnce({ ok: true, userId: 11 });
    expect(await canUseWorkspacePilot()).toBe(true);
    validateAuthToken.mockResolvedValueOnce({ ok: true, userId: 3, isAdmin: true });
    expect(await canUseWorkspacePilot()).toBe(false);
    vi.stubEnv("TINA_WORKSPACE_PILOT_USER_IDS", "*");
    validateAuthToken.mockResolvedValueOnce({ ok: true, userId: 99 });
    expect(await canUseWorkspacePilot("models/test")).toBe(true);
    get.mockReturnValue(undefined);
    expect(await canUseWorkspacePilot()).toBe(false);
    expect(get).toHaveBeenLastCalledWith("tina-token");
  });
});
