/** routinesApi — the Routines surface's data-access (its clean SoC boundary), isolation-testable.
 *
 *  Every call goes to the ONE gateway edge under /api/routines* and carries NO `subject`: the gateway
 *  injects X-User-Id and agent-api derives the user's scope from it (P20). FAIL-LOUD (P18): a backend
 *  error or network failure THROWS (via apiClient) instead of being swallowed into an empty list — the
 *  surface catches it and shows the error, so a failure is never hidden as "no routines". */
import { getJson } from "./apiClient";

export interface Routine {
  id: string; name: string; cron: string; plan_summary?: string; enabled: boolean;
  timezone?: string; prompt?: string; expected_sha256?: string; editable?: boolean;
  workspace_label?: string; routine_name?: string; next_run?: number; status?: string;
}

export async function listRoutines(): Promise<Routine[]> {
  const data = await getJson<{ routines?: Routine[] }>(`/api/routines`);
  return (data.routines ?? []).map((r) => ({ ...r, name: r.name, enabled: r.enabled }));
}

export function createWorkspaceRoutine(routine: { name: string; cron: string; timezone: string; prompt: string }) {
  return getJson<{ id: string; path: string; scheduled?: boolean }>("/api/routines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...routine, workspace_file: true, run_now: false }),
  });
}

export async function deleteRoutine(id: string, expectedSha256?: string): Promise<void> {
  await getJson(`/api/routines/${encodeURIComponent(id)}${expectedSha256 ? `?expected_sha256=${encodeURIComponent(expectedSha256)}` : ''}`, { method: "DELETE" });
}

export async function setRoutineEnabled(name: string, enabled: boolean, expectedSha256?: string): Promise<void> {
  await getJson(`/api/routines/${encodeURIComponent(name)}/enabled`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, ...(expectedSha256 ? { expected_sha256: expectedSha256 } : {}) }),
  });
}

export async function saveRoutine(routine: Pick<Routine, 'id' | 'name' | 'cron' | 'timezone' | 'prompt' | 'expected_sha256'>): Promise<void> {
  const { id, name, cron, timezone, prompt, expected_sha256 } = routine;
  await getJson(`/api/routines/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, cron, timezone, prompt, expected_sha256 }),
  });
}
