/** Settings → Models client edges. Per-user prefs ride the authenticated catch-all proxy to the
 *  gateway (`/api/user/models`, `/api/user/transcription` — admin-api behind it, secrets masked
 *  on every read-back). The GLOBAL defaults ride the admin-gated terminal route
 *  (`/api/admin/settings/{key}` — 404 for non-admins, indistinguishable from absent). */
import { ApiError } from "./apiClient";

export type ModelPrefs = {
  mode?: "subscription" | "custom" | "bedrock" | "openai-api" | "openai-subscription" | "antigravity" | "groq" | "deepseek" | "gemini" | null;
  model?: string | null;
  meeting_model?: string | null;
  translation_model?: string | null;
  effort?: string | null; // deprecated; ignored by runners, cleared on save (Auto)
  base_url?: string | null;
  region?: string | null;
  api_key_set?: boolean;
  api_key?: string | null; // masked on read (********abcd) — write-only in the clear
  antigravity_terms_acknowledged?: string | null;
};

const API_MODEL_PROVIDERS = {
  groq: { label: "Groq", model: "openai/gpt-oss-20b", keyUrl: "https://console.groq.com/keys" },
  deepseek: { label: "DeepSeek", model: "deepseek-flash", keyUrl: "https://platform.deepseek.com/api_keys" },
  gemini: { label: "Gemini", model: "gemini-3.5-flash", keyUrl: "https://aistudio.google.com/apikey" },
} as const;

export function apiModelProvider(mode: string | undefined) {
  return mode && Object.hasOwn(API_MODEL_PROVIDERS, mode)
    ? API_MODEL_PROVIDERS[mode as keyof typeof API_MODEL_PROVIDERS] : null;
}

export function canSaveModelPrefs(values: Record<string, string>): boolean {
  return values.mode !== "antigravity" || values.antigravity_terms_acknowledged === "true";
}

export type TranscriptionPrefs = {
  runtime_enabled?: boolean;
  revision?: number;
  effective?: { backend: string; label: string; model: string | null; source: "user" | "platform" | "environment" };
  backend?: "default" | "apple" | "nvidia" | "funasr" | "sherpa" | "gipformer" | "viegem" | "custom" | null;
  default_backend?: "deployment" | "apple" | "nvidia" | "funasr" | "sherpa" | "gipformer" | "viegem";
  available_backends?: Array<"default" | "apple" | "nvidia" | "funasr" | "sherpa" | "gipformer" | "viegem" | "custom">;
  url?: string | null;
  token_set?: boolean;
  token?: string | null; // masked on read — write-only in the clear
};

/** Admin-only global platform settings; secret fields are write-only in the per-user API. */
export type GlobalSetting = Record<string, string>;

async function jsonOrThrow(res: Response) {
  if (!res.ok) {
    // Structured failure (P18): carry status + detail so the presenter maps it to user truth.
    let detail = "";
    try { detail = ((await res.json()) as { detail?: string; error?: string }).detail || ""; } catch { /* body not json */ }
    throw new ApiError(res.status, detail, res.url);
  }
  return res.json();
}

export async function getModelPrefs(): Promise<ModelPrefs> {
  return jsonOrThrow(await fetch("/api/user/models", { cache: "no-store" }));
}

export async function setModelPrefs(update: Partial<Record<keyof ModelPrefs, string>>): Promise<ModelPrefs> {
  return jsonOrThrow(await fetch("/api/user/models", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...update, effort: "" }),
  }));
}

export async function getTranscriptionPrefs(): Promise<TranscriptionPrefs> {
  return jsonOrThrow(await fetch("/api/user/transcription", { cache: "no-store" }));
}

export async function setTranscriptionPrefs(update: { backend?: string; url?: string; token?: string }): Promise<TranscriptionPrefs> {
  return jsonOrThrow(await fetch("/api/user/transcription", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update),
  }));
}

export type AsrRuntime = {
  instance: string;
  account: { backend: "gipformer" | "viegem" | null; enabled: boolean; revision: number };
  counts: Record<"gipformer" | "viegem", number>;
  workers: Record<"gipformer" | "viegem", { running: boolean; ready: boolean; device: string; draining?: boolean }>;
  operation: { backend: string; phase: string } | null;
  last_error?: string | null;
};
export async function getAsrRuntime(): Promise<AsrRuntime> {
  return jsonOrThrow(await fetch("/api/transcription/runtime", { cache: "no-store" }));
}
export async function setAsrRuntime(backend: "gipformer" | "viegem", enabled: boolean, revision: number): Promise<AsrRuntime> {
  return jsonOrThrow(await fetch("/api/transcription/runtime", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend, enabled, revision }) }));
}

/** The admin-writable platform-settings keys: the two config domains + the first-run wizard's
 *  durable "setup" state. */
export type GlobalSettingKey = "models" | "transcription" | "setup";

/** null ⇒ caller is not an admin (the route 404s) — the global card simply doesn't render. */
export async function getGlobalSetting(key: GlobalSettingKey): Promise<GlobalSetting | null> {
  const res = await fetch(`/api/admin/settings/${key}`, { cache: "no-store" });
  if (res.status === 404) return null;
  const body = await jsonOrThrow(res) as { value?: GlobalSetting };
  return body.value ?? {};
}

export async function setGlobalSetting(key: GlobalSettingKey, update: GlobalSetting): Promise<GlobalSetting> {
  const res = await fetch(`/api/admin/settings/${key}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(key === "models" ? { ...update, effort: "" } : update),
  });
  const body = await jsonOrThrow(res) as { value?: GlobalSetting };
  return body.value ?? {};
}

/** On-demand credential tests (agent-api /api/{models,transcription}/test via the catch-all →
 *  gateway /agent/* edge). They test the EFFECTIVE config — the same user > global > env
 *  resolution a real turn / bot spawn applies — and fail LOUD with the remedy in `summary`. */
export type ConfigTestResult = {
  ok: boolean;
  summary: string;
  mode?: string;          // models: provider key
  source?: string;        // transcription: "settings" | "env"
  expires_in_hours?: number;
  account?: string;
  balance?: number | null;
};

export async function testModels(): Promise<ConfigTestResult> {
  return jsonOrThrow(await fetch("/api/models/test", { cache: "no-store" }));
}

export type ModelCatalogModel = { id: string; name?: string; supports_tools?: boolean };

/** The provider's live model list for the picker. `apiKey` may be a DRAFT the user is still typing
 *  (shown before Save); a masked read-back is not a credential and is omitted so the server uses
 *  the saved effective key for that provider. The key is used for this one request only. */
export async function fetchModelCatalog(
  mode: string, apiKey: string | undefined, signal?: AbortSignal, region?: string,
): Promise<ModelCatalogModel[]> {
  const draft = apiKey && !apiKey.startsWith("********") ? apiKey : undefined;
  const res = await fetch("/api/models/catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, ...(draft ? { api_key: draft } : {}), ...(mode === "bedrock" ? { region } : {}) }),
    cache: "no-store",
    signal,
  });
  const body = await res.json().catch(() => ({})) as { models?: ModelCatalogModel[]; error?: string; detail?: string };
  if (!res.ok) {
    throw new ApiError(res.status, body.error || body.detail || "Could not load models from the provider.", res.url);
  }
  return Array.isArray(body.models) ? body.models : [];
}

export async function testTranscription(): Promise<ConfigTestResult> {
  return jsonOrThrow(await fetch("/api/transcription/test", { cache: "no-store" }));
}
