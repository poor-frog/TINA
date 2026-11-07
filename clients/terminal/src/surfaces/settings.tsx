"use client";
/** Settings — the profile-menu modal (design-spec meeting-lifecycle-v2, W5): account-level
 *  configuration in one place — Calendar integration, API tokens, GitHub token, Account. The old
 *  "API Tokens" activity-bar item retired into here (its panels are imported, not duplicated);
 *  the Meetings sidebar keeps its own first-connect calendar card at the point of need — this is
 *  the durable home (multi-calendar management lives in `calendarConnections.tsx`). Sections are a left nav with local state. */
import { Fragment, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { registerTab } from "../contributions";
import { Icon } from "../ui-kit";
import { Modal } from "../ui-kit/Modal";
import { GitHubTokenCard, TokensPanel } from "./tokens";
import { presentError } from "./apiClient";
import { CalendarConnectionsPanel } from "./calendarConnections";
import { ChatGPTModelInput } from "./chatGPTModelInput";
import { ModelPicker } from "./modelPicker";
import { BEDROCK_REGIONS, fallbackChoicesForMode } from "./modelCatalog";
import { AsrStatusPanel } from "./asrStatus";
import { TranscriptionPicker } from "./transcriptionPicker";
import transcriptionStyles from "./transcriptionPicker.module.css";
import { apiModelProvider, canSaveModelPrefs, getModelPrefs, setModelPrefs, getTranscriptionPrefs, setTranscriptionPrefs, getGlobalSetting, setGlobalSetting, testModels, testTranscription, type ConfigTestResult } from "./settingsApi";
import { getAsrRuntime, setAsrRuntime, type AsrRuntime } from "./settingsApi";

type SectionId = "calendar" | "models" | "asr" | "tokens" | "github" | "account";
type ModelSettingsScope = "agent" | "transcription" | "global";
// shortcut: recognize legacy custom URLs; managed VieGem selections resolve their endpoint on the server.
const TRANSCRIPTION_PRESETS: Record<string, { url: string; label: string }> = {
  gipformer: { url: "http://host.docker.internal:18002", label: "Gipformer 1.5 · FSMN-VAD" },
  viegem: { url: "http://host.docker.internal:18005", label: "VieGem + LM" },
};

function transcriptionFormValues(value: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === "string" && item) out[key] = item;
  if (out.backend === "custom") {
    const preset = Object.entries(TRANSCRIPTION_PRESETS).find(([key, item]) => key !== "viegem" && item.url === out.url);
    if (preset) out.backend = preset[0];
  }
  return out;
}

function transcriptionDisplay(value: { backend?: string | null; url?: string | null; effective?: { label: string; source: string } | null }) {
  return value.effective ? {
    ...value.effective,
    label: value.backend === "custom"
      ? Object.values(TRANSCRIPTION_PRESETS).find((item) => item.url === value.url)?.label ?? value.effective.label
      : value.effective.label,
  } : null;
}

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: "calendar", label: "Calendar" },
  { id: "models", label: "Models" },
  { id: "asr", label: "ASR status" },
  { id: "tokens", label: "API tokens" },
  { id: "github", label: "GitHub" },
  { id: "account", label: "Account" },
];
const SECTION_GROUPS: Array<{ label: string; ids: SectionId[] }> = [
  { label: "Workspace", ids: ["calendar"] },
  { label: "AI & capture", ids: ["models", "asr"] },
  { label: "Connections", ids: ["tokens", "github"] },
  { label: "Profile", ids: ["account"] },
];
const SECTION_SEARCH_TERMS: Record<SectionId, string> = {
  calendar: "calendar meeting schedule",
  models: "models agent transcription speech to text backend provider stt",
  asr: "asr recognition speech health backend",
  tokens: "api tokens credentials key secret",
  github: "github repositories connection",
  account: "account profile identity",
};
const SECTION_DESCRIPTIONS: Record<SectionId, string> = {
  calendar: "Manage the calendars connected to TINA.",
  models: "Choose the services behind agent replies, meeting notes and speech-to-text.",
  asr: "View the speech recognition services available to this deployment.",
  tokens: "Manage API tokens used to connect clients and integrations.",
  github: "Manage the GitHub credential TINA uses for repository access.",
  account: "Review your TINA account details and preferences.",
};

const field: CSSProperties = { width: "100%", boxSizing: "border-box", fontSize: 14, padding: "8px 11px", borderRadius: 8, border: "1px solid var(--line2)", background: "var(--panel2)", color: "var(--t1)" };
const btn: CSSProperties = { fontSize: 13, padding: "6px 14px", borderRadius: 7, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)", cursor: "pointer" };

export function ChatGPTPlanConnection() {
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signInUrl, setSignInUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const refresh = async (clearSignIn = false) => {
    try {
      const response = await fetch("/api/models/openai/status", { cache: "no-store" });
      const data = response.ok ? await response.json() as { connected?: boolean; email?: string } : {};
      setConnected(data.connected === true);
      setEmail(data.email || "");
      if (data.connected && clearSignIn) { setSignInUrl(""); setCopied(false); setCallbackUrl(""); }
    } catch { setConnected(false); setEmail(""); }
  };
  useEffect(() => {
    void refresh();
    const onMessage = (event: MessageEvent) => {
      let localAlias = false;
      try {
        const sender = new URL(event.origin), app = new URL(window.location.href);
        localAlias = sender.protocol === "http:" && app.protocol === "http:"
          && sender.hostname === "127.0.0.1" && app.hostname === "localhost" && sender.port === app.port;
      } catch { /* invalid origin */ }
      if ((event.origin === window.location.origin || localAlias)
          && event.data?.type === "tina-chatgpt-connected") { void refresh(true); window.dispatchEvent(new Event("tina-models-changed")); }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    if (!signInUrl) return;
    const onFocus = () => { void refresh(!connected).then(() => window.dispatchEvent(new Event("tina-models-changed"))); };
    window.addEventListener("focus", onFocus);
    const timeout = window.setTimeout(() => { setSignInUrl(""); setCopied(false); }, 10 * 60 * 1000);
    return () => { window.removeEventListener("focus", onFocus); window.clearTimeout(timeout); };
  }, [signInUrl, connected]);
  const connect = async () => {
    let popup: Window | null = null;
    try { popup = window.open("about:blank", "tina-chatgpt-signin", "popup,width=520,height=720"); }
    catch { /* The generated link remains available when popups are blocked. */ }
    setBusy(true); setErr(null); setSignInUrl(""); setCopied(false); setCallbackUrl("");
    try {
      const response = await fetch("/api/models/openai/start", { method: "POST", cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { authorization_url?: string; error?: string };
      if (!response.ok || !body.authorization_url) throw new Error(body.error || `Sign-in failed (${response.status})`);
      setSignInUrl(body.authorization_url);
      if (popup) popup.location.href = body.authorization_url;
    } catch (e: unknown) {
      popup?.close();
      setErr(presentError(e).headline);
    } finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true); setErr(null); setSignInUrl(""); setCopied(false); setCallbackUrl("");
    try {
      const response = await fetch("/api/models/openai/logout", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error("Could not disconnect ChatGPT. Retry shortly.");
      setConnected(false); setEmail("");
      window.dispatchEvent(new Event("tina-models-changed"));
    } catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(signInUrl); setCopied(true); setErr(null); }
    catch { setErr("Could not copy. Select the sign-in link below and copy it manually."); }
  };
  const finishConnection = async () => {
    setBusy(true); setErr(null);
    try {
      const response = await fetch("/api/models/openai/complete", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_url: callbackUrl.trim() }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not finish ChatGPT sign-in.");
      setSignInUrl(""); setCallbackUrl(""); setCopied(false);
      await refresh(); window.dispatchEvent(new Event("tina-models-changed"));
    } catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, maxWidth: 460, margin: "0 0 4px" }}>
      <div style={{ fontSize: 12, color: "var(--t2)" }}>
        ChatGPT plan {connected ? `connected · ${email}` : "not connected"}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <button disabled={busy} onClick={() => void connect()} style={{ ...btn, opacity: busy ? 0.5 : 1 }}>
          {busy ? "Please wait…" : connected ? "Reconnect with ChatGPT" : "Continue with ChatGPT"}
        </button>
        {connected && <button disabled={busy} onClick={() => void disconnect()} style={btn}>Disconnect ChatGPT</button>}
        {err && <span role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>{err}</span>}
      </div>
      {signInUrl && <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <a href={signInUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--t1)", fontSize: 12 }}>Open ChatGPT sign-in link</a>
          <button onClick={() => void copyLink()} style={btn}>Copy sign-in link</button>
          {copied && <span role="status" style={{ fontSize: 11.5, color: "var(--t2)" }}>Copied</span>}
        </div>
        <input aria-label="ChatGPT sign-in URL" readOnly value={signInUrl} onFocus={(event) => event.currentTarget.select()} style={field} />
        <p style={{ fontSize: 11.5, color: "var(--t3)", margin: 0 }}>If the popup did not open, use this link. In another browser/profile, copy the callback URL shown after sign-in and paste it below. The request expires after 10 minutes; create a new link if needed.</p>
        <label style={{ fontSize: 12, color: "var(--t2)" }}>
          Callback URL from the other browser
          <input type="text" autoComplete="off" spellCheck={false} value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} style={field} />
        </label>
        <button disabled={busy || !callbackUrl.trim()} onClick={() => void finishConnection()} style={{ ...btn, alignSelf: "flex-start" }}>Finish connection</button>
      </div>}
      <p style={{ fontSize: 11.5, color: "var(--t3)", margin: 0 }}>Disconnect removes this TINA account’s saved ChatGPT connection. Then connect the new account. It does not sign you out of TINA or ChatGPT in your browser; already running tasks may retain their current token.</p>
    </div>
  );
}

/** Shared models/transcription form. Callers provide scope-specific fields for per-user or admin
 *  global settings. Secrets arrive MASKED (********abcd): an untouched masked value is never sent
 *  back, typing replaces it, and emptying a previously-set field clears it. */
function ConfigForm({ fields, load, save, note, savedNote = "Saved — next agent turn uses it", chatGPTModelCatalog = false, chatGPTConnection = false, onValues, renderWarning, saveGuard, footer }: {
  fields: Array<{ key: string; label: string; placeholder?: string | ((v: Record<string, string>) => string); secret?: boolean; checkbox?: boolean; options?: Array<{ value: string; label: string; disabled?: boolean }> | ((v: Record<string, string>) => Array<{ value: string; label: string; disabled?: boolean }>); hint?: (v: Record<string, string>) => string; showIf?: (v: Record<string, string>) => boolean; modelPicker?: (v: Record<string, string>) => boolean; modelEmptyLabel?: (v: Record<string, string>) => string }>;
  load: () => Promise<Record<string, string>>;
  save: (update: Record<string, string>) => Promise<Record<string, string>>;
  note?: string;
  savedNote?: string;
  chatGPTModelCatalog?: boolean;
  chatGPTConnection?: boolean;
  onValues?: (values: Record<string, string>) => void;
  renderWarning?: (values: Record<string, string>) => ReactNode;
  saveGuard?: (values: Record<string, string>) => boolean;
  footer?: (state: { dirty: boolean; values: Record<string, string> }) => ReactNode;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const regionSuggestionsId = useId();
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let on = true;
    load().then((v) => { if (on) { setValues(v); setInitial(v); onValues?.(v); } })
      .catch((e: unknown) => on && setErr(presentError(e).headline));
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = fields.some((f) => (values[f.key] ?? "") !== (initial[f.key] ?? ""));
  const updateField = (key: string, value: string) => {
    const next = { ...values, [key]: value };
    if (key === "mode" && value !== values.mode) {
      // An API provider is a different endpoint + credential + model namespace, so switching into or
      // out of one must not carry the previous provider's values across.
      if (apiModelProvider(value) || apiModelProvider(values.mode)) {
        for (const providerField of ["api_key", "base_url", "model", "meeting_model", "translation_model"]) next[providerField] = "";
      }
    }
    setSaved(false);
    setValues(next);
    onValues?.(next);
  };
  const doSave = async () => {
    setBusy(true); setErr(null); setSaved(false);
    // Send only what changed; an untouched masked secret stays server-side.
    const update: Record<string, string> = {};
    for (const f of fields) {
      if ((values[f.key] ?? "") !== (initial[f.key] ?? "")) update[f.key] = values[f.key] ?? "";
    }
    try { const v = await save(update); setValues(v); setInitial(v); setSaved(true); onValues?.(v); }
    catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 560 }}>
      {note && <div style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.55 }}>{note}</div>}
      {err && <div role="alert" style={{ fontSize: 13, color: "var(--danger)" }}>⚠ {err}</div>}
      {renderWarning?.(values)}
      {fields.map((f) => {
        if (f.showIf && !f.showIf(values)) return null;
        if (f.checkbox) {
          return (
            <label key={f.key} style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 12.5, color: "var(--t2)", lineHeight: 1.5 }}>
              <input type="checkbox" checked={values[f.key] === "true"}
                onChange={(e) => updateField(f.key, e.target.checked ? "true" : "")} />
              <span>{f.label}</span>
            </label>
          );
        }
        const useModelPicker = f.modelPicker?.(values) ?? false;
        const options = typeof f.options === "function" ? f.options(values) : f.options;
        const hint = f.hint?.(values);
        return (
          <Fragment key={f.key}>
            <label style={{ display: "flex", alignItems: useModelPicker ? "flex-start" : "center", gap: 12, fontSize: 13.5, color: "var(--t2)" }}>
              <span style={{ width: 128, flex: "none", color: "var(--t3)", ...(useModelPicker ? { paddingTop: 9 } : {}) }}>{f.label}</span>
              {options ? (
                <select value={values[f.key] ?? ""}
                  onChange={(e) => updateField(f.key, e.target.value)}
                  style={{ ...field, width: "auto", flex: 1 }}>
                  {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
                </select>
              ) : chatGPTModelCatalog && f.key === "model" && values.mode === "openai-subscription" ? (
                <ChatGPTModelInput
                  value={values[f.key] ?? ""}
                  onChange={(value) => updateField(f.key, value)}
                  style={field}
                />
              ) : useModelPicker ? (
                <ModelPicker
                  key={values.mode}
                  ariaLabel={f.label}
                  value={values[f.key] ?? ""}
                  onChange={(value) => updateField(f.key, value)}
                  mode={values.mode ?? ""}
                  apiKey={values.api_key}
                  region={values.region}
                  requiresTools={f.key === "model"}
                  suggestDefault={values.mode === "bedrock" && f.key === "model"}
                  emptyLabel={f.modelEmptyLabel?.(values) ?? "Provider default"}
                  style={field}
                />
              ) : (
                <><input value={values[f.key] ?? ""} aria-label={f.label} placeholder={typeof f.placeholder === "function" ? f.placeholder(values) : f.placeholder}
                  type={f.secret ? "password" : "text"}
                  list={f.key === "region" ? regionSuggestionsId : undefined}
                  onChange={(e) => updateField(f.key, e.target.value)}
                  style={field} />
                  {f.key === "region" && <datalist id={regionSuggestionsId}>
                    {BEDROCK_REGIONS.map((region) => <option key={region.value} value={region.value}>{region.label}</option>)}
                  </datalist>}</>
              )}
            </label>
            {hint && (
              <p style={{ margin: "0 0 0 140px", fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5 }}>{hint}</p>
            )}
            {chatGPTConnection && f.key === "mode" && values.mode === "openai-subscription" && <ChatGPTPlanConnection />}
          </Fragment>
        );
      })}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button disabled={busy || !dirty || (saveGuard !== undefined && !saveGuard(values))} onClick={() => void doSave()}
          style={{ ...btn, background: dirty ? "var(--accent)" : "var(--panel2)", color: dirty ? "var(--on-accent)" : "var(--t3)", border: dirty ? "none" : btn.border, opacity: busy ? 0.5 : 1 }}>
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && <span style={{ fontSize: 11.5, color: "var(--green)" }}>{savedNote}</span>}
      </div>
      {footer?.({ dirty, values })}
    </div>
  );
}

/** On-demand credential test row (fail-loud surface): runs the EFFECTIVE config — the same
 *  user > global > env resolution a chat turn / bot spawn applies — against the real backend
 *  and prints the verdict inline, remedy included. What Save can't tell you, Test does. */
function TestRow({ label, run, disabled = false, hint }: {
  label: string;
  run: () => Promise<ConfigTestResult>;
  /** The probe uses the SAVED config; while the form is dirty it would report the previous
   *  provider/key — the exact mismatch that reads as "the key worked elsewhere". */
  disabled?: boolean;
  hint?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ConfigTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const doTest = async () => {
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await run()); }
    catch (e: unknown) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };
  const provenance = res ? [res.mode, res.source && `via ${res.source}`].filter(Boolean).join(" · ") : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 460, marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button disabled={busy || disabled} onClick={() => void doTest()}
          style={{ ...btn, opacity: busy || disabled ? 0.5 : 1 }}>
          {busy ? "Testing…" : label}
        </button>
        {disabled && hint && (
          <span role="status" style={{ fontSize: 11.5, color: "var(--t3)" }}>{hint}</span>
        )}
        {res && (
          <span style={{ fontSize: 11.5, color: res.ok ? "var(--green)" : "var(--danger)" }}>
            {res.ok ? "✓" : "✗"} {provenance && <span style={{ color: "var(--t3)" }}>[{provenance}] </span>}
            {res.summary}
          </span>
        )}
        {err && <span role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>⚠ test failed: {err}</span>}
      </div>
    </div>
  );
}

/** Models — which LLM the agent runs on and which STT backend the bot transcribes with; your own
 *  settings first, the deployment-wide defaults below for admins. Empty fields = the level below
 *  decides (global settings, then the deployment env). */
export function ModelsSection() {
  const [globalAdmin, setGlobalAdmin] = useState(false);
  const [scope, setScope] = useState<ModelSettingsScope>("agent");
  const [modelSummary, setModelSummary] = useState<Record<string, string>>({});
  const [transcriptionSummary, setTranscriptionSummary] = useState<Record<string, string>>({});
  const [effectiveTranscription, setEffectiveTranscription] = useState<{ label: string; source: string } | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [availableTranscriptionBackends, setAvailableTranscriptionBackends] = useState<string[]>(["default", "custom"]);
  const [runtime, setRuntime] = useState<AsrRuntime | null>(null);
  const [runtimeError, setRuntimeError] = useState("");
  const [runtimeFetchError, setRuntimeFetchError] = useState("");
  const [runtimeTarget, setRuntimeTarget] = useState<"gipformer" | "viegem" | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const [otherProvidersOpen, setOtherProvidersOpen] = useState(false);
  useEffect(() => {
    if (scope !== "transcription") return;
    let active = true;
    const refresh = () => getAsrRuntime().then(value => { if (active) { setRuntime(value); setRuntimeFetchError(""); } })
      .catch(() => { if (active) setRuntimeFetchError("ASR control is unavailable. Retry shortly."); });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [scope]);
  const changeRuntime = async (backend: "gipformer" | "viegem", enabled: boolean) => {
    setRuntimeBusy(true); setRuntimeTarget(backend); setRuntimeError("");
    try {
      const current = await getAsrRuntime();
      const saved = await setAsrRuntime(backend, enabled, current.account.revision);
      setRuntime(saved);
      const prefs = await getTranscriptionPrefs();
      setEffectiveTranscription(transcriptionDisplay(prefs));
      return prefs;
    } catch (error) { setRuntimeError(presentError(error).headline); throw error; }
    finally { setRuntimeBusy(false); setRuntimeTarget(null); }
  };
  useEffect(() => {
    let on = true;
    // Admin probe: the global card renders only when /api/admin/settings answers (404 = not admin).
    getGlobalSetting("models").then((v) => on && setGlobalAdmin(v !== null)).catch(() => undefined);
    getTranscriptionPrefs().then((v) => { if (on) { setAvailableTranscriptionBackends(v.available_backends ?? ["default", "custom"]); setEffectiveTranscription(transcriptionDisplay(v)); } })
      .catch(() => undefined);
    return () => { on = false; };
  }, []);

  const modelFields = [
    { key: "mode", label: "Provider", options: [
      { value: "", label: "Deployment default" },
      { value: "subscription", label: "Claude subscription (deployment credentials)" },
      { value: "openai-subscription", label: "ChatGPT plan (Sign in with ChatGPT)" },
      { value: "openai-api", label: "OpenAI API key" },
      { value: "groq", label: "Groq API key" },
      { value: "deepseek", label: "DeepSeek API key" },
      { value: "gemini", label: "Gemini API key" },
      { value: "antigravity", label: "Google Antigravity CLI (agy)" },
      { value: "bedrock", label: "AWS Bedrock" },
      { value: "custom", label: "Custom endpoint (open-source / gateway)" },
    ] },
    { key: "base_url", label: "Base URL", placeholder: "https://… (Anthropic/OpenAI-compatible gateway)", showIf: (v: Record<string, string>) => v.mode === "custom" },
    { key: "region", label: "AWS Region", placeholder: "Choose or enter a region", showIf: (v: Record<string, string>) => v.mode === "bedrock",
      hint: () => "Use the region where your Bedrock key was generated. Model suggestions refresh for this region; you can also enter another AWS region." },
    { key: "api_key", label: "Credential", placeholder: (v: Record<string, string>) => apiModelProvider(v.mode) ? `${apiModelProvider(v.mode)!.label} API key — unchanged unless typed` : "unchanged unless typed", secret: true, showIf: (v: Record<string, string>) => ["antigravity", "custom", "bedrock", "openai-api", "groq", "deepseek", "gemini"].includes(v.mode) },
    { key: "antigravity_terms_acknowledged", label: "I have read this warning and acknowledge the account risk.", checkbox: true, showIf: (v: Record<string, string>) => v.mode === "antigravity" },
    { key: "model", label: "Chat model", placeholder: (v: Record<string, string>) => apiModelProvider(v.mode) ? `${apiModelProvider(v.mode)!.model} (default)` : "deployment default (e.g. sonnet)",
      modelPicker: (v: Record<string, string>) => fallbackChoicesForMode(v.mode) !== null,
      modelEmptyLabel: (v: Record<string, string>) => {
        const provider = apiModelProvider(v.mode);
        if (provider) return `Provider default — ${provider.model}`;
        if (v.mode === "subscription") return "Deployment default (e.g. sonnet)";
        if (v.mode === "antigravity") return "CLI default";
        if (v.mode === "bedrock") return "Choose a regional model (required)";
        return "Provider default";
      } },
    { key: "meeting_model", label: "Meeting model", placeholder: "defaults to chat model", showIf: (v: Record<string, string>) => v.mode !== "antigravity",
      modelPicker: (v: Record<string, string>) => fallbackChoicesForMode(v.mode) !== null,
      modelEmptyLabel: () => "Same as chat model" },
    { key: "translation_model", label: "Translation model", placeholder: "defaults to meeting model", showIf: (v: Record<string, string>) => v.mode !== "antigravity",
      modelPicker: (v: Record<string, string>) => fallbackChoicesForMode(v.mode) !== null,
      modelEmptyLabel: () => "Same as meeting model" },
  ];
  const renderModelWarning = (values: Record<string, string>) => values.mode === "antigravity" ? (
    <div role="alert" style={{ border: "1px solid var(--danger)", borderRadius: 8, padding: "10px 12px", background: "color-mix(in srgb, var(--danger) 8%, transparent)", color: "var(--t2)", fontSize: 12.5, lineHeight: 1.55 }}>
      Google says third-party access to Antigravity violates its Terms of Service; wrapping <code>agy</code> in TINA with a consumer-plan login is unsupported and may lead to account suspension or termination. Acknowledging this warning does not make that use permitted. Use a Gemini API key or Gemini Enterprise credential for TINA. This choice affects agent turns only; meeting summaries continue using the deployment completion provider. CLI authentication and model access are checked on the first agent turn.
    </div>
  ) : apiModelProvider(values.mode) ? (
    <div role="status" style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.55 }}>
      Use your <a href={apiModelProvider(values.mode)!.keyUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--t1)" }}>{apiModelProvider(values.mode)!.label} API key</a> for chat and meeting notes.
      {" "}Leave Chat model blank to use <code>{apiModelProvider(values.mode)!.model}</code>; Meeting model follows Chat model unless specified. Translation model follows Meeting model unless specified.
      {" "}Save, then test model credentials. Speech-to-text is configured separately in Transcription.
    </div>
  ) : null;
  const modelSaveGuard = canSaveModelPrefs;
  const transcriptionFields = [
    { key: "backend", label: "Backend", options: [
      { value: "managed", label: "Model selected above", disabled: true },
      { value: "default", label: "Follow platform default" },
      { value: "apple", label: availableTranscriptionBackends.includes("apple") ? "Apple GPU (MLX/Metal)" : "Apple GPU (MLX/Metal) — not configured", disabled: !availableTranscriptionBackends.includes("apple") },
      { value: "nvidia", label: availableTranscriptionBackends.includes("nvidia") ? "NVIDIA GPU (CUDA)" : "NVIDIA GPU (CUDA) — not configured", disabled: !availableTranscriptionBackends.includes("nvidia") },
      { value: "funasr", label: availableTranscriptionBackends.includes("funasr") ? "FunASR · Qwen + FSMN-VAD" : "FunASR · Qwen + FSMN-VAD — not configured", disabled: !availableTranscriptionBackends.includes("funasr") },
      { value: "sherpa", label: availableTranscriptionBackends.includes("sherpa") ? "Sherpa · Qwen INT8 + Silero" : "Sherpa · Qwen INT8 + Silero — not configured", disabled: !availableTranscriptionBackends.includes("sherpa") },
      { value: "custom", label: "Custom endpoint" },
    ] },
    { key: "url", label: "Service URL", placeholder: "https://…", showIf: (v: Record<string, string>) => v.backend === "custom" },
    { key: "token", label: "Token", placeholder: "unchanged unless typed", secret: true, showIf: (v: Record<string, string>) => v.backend === "custom" },
  ];
  const globalTranscriptionFields = [
    { key: "default_backend", label: "Default backend", options: [
      { value: "deployment", label: "Deployment endpoint" },
      { value: "funasr", label: "FunASR · Qwen + FSMN-VAD" },
      { value: "sherpa", label: "Sherpa · Qwen INT8 + Silero" },
      { value: "viegem", label: "VieGem + LM" },
      { value: "apple", label: "Apple GPU (MLX/Metal)" },
      { value: "nvidia", label: "NVIDIA GPU (CUDA)" },
    ] },
    { key: "url", label: "Deployment URL", placeholder: "existing TRANSCRIPTION_SERVICE_URL" },
    { key: "token", label: "Deployment token", placeholder: "unchanged unless typed", secret: true },
    { key: "funasr_url", label: "FunASR URL", placeholder: "http://host.docker.internal:18000" },
    { key: "sherpa_url", label: "Sherpa native URL", placeholder: "http://host.docker.internal:18001" },
    { key: "viegem_url", label: "VieGem + LM URL", placeholder: "http://host.docker.internal:18005" },
    { key: "viegem_token", label: "VieGem worker token", placeholder: "unchanged unless typed", secret: true },
    { key: "apple_url", label: "Apple GPU (MLX/Metal) URL", placeholder: "http://host.docker.internal:8084" },
    { key: "apple_token", label: "Apple GPU token", placeholder: "unchanged unless typed", secret: true },
    { key: "nvidia_url", label: "NVIDIA GPU URL", placeholder: "CUDA transcription worker URL" },
    { key: "nvidia_token", label: "NVIDIA GPU token", placeholder: "unchanged unless typed", secret: true },
  ];
  const asStrings = (v: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === "string" && val) out[k] = val;
    return out;
  };
  const head: CSSProperties = { fontSize: 14.5, fontWeight: 650, color: "var(--t1)", margin: "18px 0 8px" };
  const scopeTabs: Array<{ id: ModelSettingsScope; label: string }> = [
    { id: "agent", label: "Agent model" },
    { id: "transcription", label: "Transcription" },
    ...(globalAdmin ? [{ id: "global" as const, label: "Global defaults" }] : []),
  ];
  const providerLabels: Record<string, string> = {
    "": "Deployment default", subscription: "Claude subscription", "openai-subscription": "ChatGPT plan",
    "openai-api": "OpenAI API", groq: "Groq", deepseek: "DeepSeek", gemini: "Gemini", bedrock: "AWS Bedrock", custom: "Custom endpoint",
  };
  const transcriptionLabels: Record<string, string> = {
    "": "Deployment default", default: "Follow platform default", deployment: "Deployment endpoint", apple: "Apple GPU (MLX/Metal)",
    nvidia: "NVIDIA GPU (CUDA)", funasr: "FunASR · Qwen + FSMN-VAD", sherpa: "Sherpa · Qwen INT8 + Silero", ...Object.fromEntries(Object.entries(TRANSCRIPTION_PRESETS).map(([key, item]) => [key, item.label])), custom: "Custom endpoint",
  };
  const activeTranscriptionBackend = transcriptionSummary.backend === "default"
    ? transcriptionSummary.default_backend || "deployment"
    : transcriptionSummary.backend || "deployment";
  const summaryTile: CSSProperties = {
    flex: 1, minWidth: 0, padding: "12px 14px", border: "1px solid var(--line)",
    borderRadius: 10, background: "var(--panel)", display: "flex", flexDirection: "column", gap: 4,
  };

  return (
    <div style={{ maxWidth: 720 }}>
      {scope !== "transcription" && <div aria-label="Current model settings" style={{ display: "flex", gap: 12, marginBottom: 22 }}>
        <div style={summaryTile}>
          <span style={{ fontSize: 11.5, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".07em" }}>Agent model</span>
          <strong style={{ fontSize: 14.5, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{modelSummary.model || "Deployment default"}</strong>
          <span style={{ fontSize: 12, color: "var(--t3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{providerLabels[modelSummary.mode ?? ""] ?? "Deployment default"}</span>
        </div>
        <div style={summaryTile}>
          <span style={{ fontSize: 11.5, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".07em" }}>Speech to text</span>
          <strong style={{ fontSize: 14.5, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{effectiveTranscription?.label ?? transcriptionLabels[activeTranscriptionBackend] ?? "Deployment default"}</strong>
          <span style={{ fontSize: 12, color: "var(--t3)" }}>{effectiveTranscription ? { user: "Personal preference", platform: "Platform default", environment: "Deployment environment" }[effectiveTranscription.source] : "Choose and save a backend"} · next session</span>
        </div>
      </div>}
      <div role="tablist" aria-label="Model settings scope" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--line)", marginBottom: 16 }}>
        {scopeTabs.map((tab, index) => {
          const selected = scope === tab.id;
          return <button key={tab.id} ref={(element) => { tabRefs.current[index] = element; }}
            type="button" role="tab" id={`models-tab-${tab.id}`} aria-controls={`models-panel-${tab.id}`}
            aria-selected={selected} tabIndex={selected ? 0 : -1} onClick={() => setScope(tab.id)}
            onKeyDown={(event) => {
              const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % scopeTabs.length
                : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + scopeTabs.length - 1) % scopeTabs.length
                  : event.key === "Home" ? 0 : event.key === "End" ? scopeTabs.length - 1 : -1;
              if (nextIndex >= 0) { event.preventDefault(); setScope(scopeTabs[nextIndex].id); tabRefs.current[nextIndex]?.focus(); }
            }}
            style={{ ...btn, fontSize: 13.5, border: "none", borderBottom: selected ? "2px solid var(--accent)" : "2px solid transparent", borderRadius: "7px 7px 0 0", background: selected ? "var(--panel2)" : "transparent", color: selected ? "var(--t1)" : "var(--t2)", padding: "8px 14px" }}>
            {tab.label}
          </button>;
        })}
      </div>
      <div id="models-panel-agent" role="tabpanel" aria-labelledby="models-tab-agent" hidden={scope !== "agent"}>
        <div style={head}>Your models</div>
        <ConfigForm fields={modelFields} load={async () => asStrings(await getModelPrefs())}
          save={async (u) => { const saved = await setModelPrefs(u); window.dispatchEvent(new Event("tina-models-changed")); return asStrings(saved); }} chatGPTModelCatalog chatGPTConnection onValues={setModelSummary}
          renderWarning={renderModelWarning} saveGuard={modelSaveGuard}
          footer={({ dirty }) => modelSummary.mode === "antigravity"
            ? <div role="status" style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5 }}>Antigravity CLI authentication and model availability are validated on the first agent turn.</div>
            : <TestRow label="Test model credentials" run={testModels} disabled={dirty}
                hint="Save first — Test checks the saved configuration." />} />
      </div>
      <div id="models-panel-transcription" role="tabpanel" aria-labelledby="models-tab-transcription" hidden={scope !== "transcription"}>
        <TranscriptionPicker runtime={runtime} available={availableTranscriptionBackends} busy={runtimeBusy}
          target={runtimeTarget} error={runtimeError || runtimeFetchError} unavailable={!!runtimeFetchError}
          onChange={(backend, enabled) => void changeRuntime(backend, enabled)
            .then(() => setRuntimeVersion(value => value + 1)).catch(() => undefined)} />
        <details className={transcriptionStyles.advanced} onToggle={event => setOtherProvidersOpen(event.currentTarget.open)}>
          <summary><Icon name="chevR" size={13} />Other providers</summary>
          {otherProvidersOpen && <ConfigForm key={runtimeVersion} fields={transcriptionFields} load={async () => {
            const values = transcriptionFormValues(await getTranscriptionPrefs());
            if (values.backend in TRANSCRIPTION_PRESETS) values.backend = "managed";
            return values;
          }} save={async (update) => {
            const value = await setTranscriptionPrefs(update);
            setEffectiveTranscription(transcriptionDisplay(value));
            void getAsrRuntime().then(setRuntime).catch(() => undefined);
            return transcriptionFormValues(value);
          }} onValues={setTranscriptionSummary} savedNote="Saved — applies to new sessions" />}
        </details>
      </div>
      {globalAdmin && <div id="models-panel-global" role="tabpanel" aria-labelledby="models-tab-global" hidden={scope !== "global"}>
        <div style={{ ...head, marginTop: 10, color: "var(--accent)" }}>Global defaults (admin — every user without own settings)</div>
        <ConfigForm fields={modelFields} load={async () => (await getGlobalSetting("models")) ?? {}}
          save={(u) => setGlobalSetting("models", u)}
          renderWarning={renderModelWarning} saveGuard={modelSaveGuard} />
        <div style={head}>Global transcription backend</div>
        <ConfigForm fields={globalTranscriptionFields} load={async () => {
          const value: Record<string, string> = await getGlobalSetting("transcription") ?? {};
          return { ...value, default_backend: value.default_backend || "deployment" };
        }}
          save={async (u) => {
            const saved = await setGlobalSetting("transcription", u);
            const prefs = await getTranscriptionPrefs();
            setAvailableTranscriptionBackends(prefs.available_backends ?? ["default", "custom"]);
            setEffectiveTranscription(prefs.effective ?? null);
            return saved;
          }} savedNote="Saved — applies to new sessions following platform defaults"
          note="Shared default for meeting bots, Desktop extension capture and TINA Capture. Personal preferences take priority. Running sessions keep their backend. Saving selects an endpoint; it does not start its ASR service." />
      </div>}
    </div>
  );
}

function AccountSection() {
  const [user, setUser] = useState<{ email?: string | null; name?: string | null } | null>(null);
  useEffect(() => {
    let on = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => on && setUser((d?.user as { email?: string; name?: string } | undefined) ?? null))
      .catch(() => undefined);
    return () => { on = false; };
  }, []);
  return (
    <div style={{ fontSize: 12.5, color: "var(--t2)", lineHeight: 1.9 }}>
      <div><span style={{ color: "var(--t3)" }}>Signed in as</span> <span style={{ color: "var(--t1)" }}>{user?.name || user?.email || "…"}</span></div>
      {user?.email && <div><span style={{ color: "var(--t3)" }}>Email</span> <span style={{ fontFamily: "var(--mono)" }}>{user.email}</span></div>}
      <div style={{ color: "var(--t3)", marginTop: 6 }}>Theme and sign-out live next to your name in the footer.</div>
    </div>
  );
}

function SettingsBody({ hideHeading = false }: { hideHeading?: boolean } = {}) {
  const [section, setSection] = useState<SectionId>("calendar");
  const [isAdmin, setIsAdmin] = useState(false);
  const [search, setSearch] = useState("");
  useEffect(() => {
    let alive = true;
    void fetch("/api/admin/me", { cache: "no-store" }).then((response) => {
      if (alive) setIsAdmin(response.ok);
    }).catch(() => { if (alive) setIsAdmin(false); });
    return () => { alive = false; };
  }, []);
  const bodies: Record<SectionId, ReactNode> = {
    calendar: <CalendarConnectionsPanel />,
    models: <ModelsSection />,
    asr: <AsrStatusPanel />,
    tokens: <TokensPanel />,
    github: <GitHubTokenCard />,
    account: <AccountSection />,
  };
  const availableSections = SECTIONS.filter((item) => item.id !== "asr" || isAdmin);
  const query = search.trim().toLowerCase();
  const visibleSections = availableSections.filter((item) => {
    const group = SECTION_GROUPS.find((candidate) => candidate.ids.includes(item.id))?.label ?? "";
    return !query || `${item.label} ${group} ${SECTION_SEARCH_TERMS[item.id]}`.toLowerCase().includes(query);
  });
  const selected = SECTIONS.find((item) => item.id === section)!;
  const selectedGroup = SECTION_GROUPS.find((group) => group.ids.includes(section))?.label ?? "Settings";
  const selectSection = (next: SectionId) => { setSection(next); setSearch(""); };
  const updateSearch = (value: string) => {
    setSearch(value);
    const next = value.trim().toLowerCase();
    if (!next) return;
    const match = availableSections.find((item) => {
      const group = SECTION_GROUPS.find((candidate) => candidate.ids.includes(item.id))?.label ?? "";
      return `${item.label} ${group} ${SECTION_SEARCH_TERMS[item.id]}`.toLowerCase().includes(next);
    });
    if (match) setSection(match.id);
  };
  return (
    <div style={{ height: "100%", display: "flex", minHeight: 0 }}>
      <aside style={{ width: "clamp(180px, 22vw, 228px)", flex: "none", borderRight: "1px solid var(--line)", padding: "20px 14px", background: "var(--sidebar)", overflowY: "auto" }}>
        {!hideHeading && <div style={{ fontSize: 16, fontWeight: 700, color: "var(--t1)", padding: "0 9px 16px" }}>Settings</div>}
        <label style={{ height: 38, display: "flex", alignItems: "center", gap: 9, border: "1px solid var(--line2)", borderRadius: 8, background: "var(--canvas)", padding: "0 10px", margin: "0 2px 22px" }}>
          <Icon name="search" size={14} style={{ color: "var(--t3)", flex: "none" }} />
          <input aria-label="Search settings" type="search" placeholder="Search settings" value={search}
            onChange={(event) => updateSearch(event.target.value)}
            style={{ width: "100%", minWidth: 0, border: 0, background: "transparent", color: "var(--t1)", font: "13px var(--sans)" }} />
        </label>
        <nav aria-label="Settings sections">
          {SECTION_GROUPS.map((group) => {
            const items = visibleSections.filter((item) => group.ids.includes(item.id));
            if (!items.length) return null;
            return <section key={group.label} style={{ marginBottom: 15, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
              <div role="heading" aria-level={2} style={{ display: "flex", alignItems: "center", gap: 8, font: "10.5px var(--mono)", color: "var(--t3)", letterSpacing: ".12em", textTransform: "uppercase", padding: "0 10px 8px", cursor: "default", pointerEvents: "none", userSelect: "none" }}>
                <span>{group.label}</span><span aria-hidden="true" style={{ flex: 1, height: 1, background: "var(--line)" }} />
              </div>
              {items.map((item) => <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined}
                onClick={() => selectSection(item.id)}
                onMouseEnter={(event) => { if (section !== item.id) event.currentTarget.style.background = "var(--panel)"; }}
                onMouseLeave={(event) => { if (section !== item.id) event.currentTarget.style.background = "transparent"; }}
                style={{ display: "flex", alignItems: "center", width: "100%", minHeight: 38, textAlign: "left", fontSize: 13.5, fontWeight: section === item.id ? 600 : 400,
                  padding: "8px 10px", borderRadius: 7, border: "none", cursor: "pointer",
                  color: section === item.id ? "var(--t1)" : "var(--t2)", background: section === item.id ? "var(--panel2)" : "transparent",
                  boxShadow: section === item.id ? "inset 2px 0 var(--accent)" : "none" }}>
                {item.label}
              </button>)}
            </section>;
          })}
          {!visibleSections.length && <div role="status" style={{ padding: "8px 10px", color: "var(--t3)", fontSize: 13 }}>No matching settings</div>}
        </nav>
      </aside>
      <main style={{ flex: 1, overflowY: "auto", padding: "clamp(20px, 3vw, 32px) clamp(20px, 3vw, 38px)", minWidth: 0 }}>
        <div style={{ margin: "8px 0 24px" }}>
          <div style={{ font: "11px var(--mono)", color: "var(--accent)", letterSpacing: ".09em", textTransform: "uppercase", marginBottom: 8 }}>{selectedGroup}</div>
          <h1 style={{ font: "26px var(--display)", fontWeight: 400, letterSpacing: "-.02em", color: "var(--t1)", margin: "0 0 7px" }}>{selected.label}</h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: "var(--t2)", margin: 0 }}>{SECTION_DESCRIPTIONS[section]}</p>
        </div>
        {bodies[section]}
      </main>
    </div>
  );
}

function SettingsView() {
  return <SettingsBody />;
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Settings" onClose={onClose} width={1040}>
      <div style={{ height: "min(680px, calc(100vh - 136px))", minHeight: 0, overflow: "hidden" }}>
        <SettingsBody hideHeading />
      </div>
    </Modal>
  );
}

registerTab("settings", SettingsView);
