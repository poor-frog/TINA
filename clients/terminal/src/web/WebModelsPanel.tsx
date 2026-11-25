"use client";
/** WebModelsPanel — Production UI for Agent Model Provider, Auth/OAuth Connections,
 *  Model Selection, Credential Verification, Speech-to-Text, and Admin Global Defaults.
 *  100% wired to TINA's real settingsApi, OpenAI/ChatGPT OAuth endpoints, ModelPicker,
 *  ChatGPTModelInput, and TranscriptionPicker. */
import { useCallback, useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { WebIcon } from "./Icons";
import { presentError } from "../surfaces/apiClient";
import { ChatGPTModelInput } from "../surfaces/chatGPTModelInput";
import { ModelPicker } from "../surfaces/modelPicker";
import { BEDROCK_REGIONS, fallbackChoicesForMode } from "../surfaces/modelCatalog";
import { TranscriptionPicker } from "../surfaces/transcriptionPicker";
import { workspacePilotMode } from "../app/mode";
import { WorkspaceChatGPTConnection } from "../surfaces/WorkspaceChatGPTConnection";
import {
  apiModelProvider,
  canSaveModelPrefs,
  getAsrRuntime,
  getGlobalSetting,
  getModelPrefs,
  getTranscriptionPrefs,
  setAsrRuntime,
  setGlobalSetting,
  setModelPrefs,
  setTranscriptionPrefs,
  testModels,
  type AsrRuntime,
  type ConfigTestResult,
} from "../surfaces/settingsApi";
import styles from "./webModelsPanel.module.css";

type ProviderGroup = "managed" | "api" | "advanced";

interface ProviderMeta {
  id: string;
  name: string;
  logo: string;
  logoStyle?: "invertLight" | "awsLight" | "rounded" | "color";
  group: ProviderGroup;
  summary: string;
  keyUrl?: string;
  defaultModelHint?: string;
}

const PROVIDERS: readonly ProviderMeta[] = [
  {
    id: "",
    name: "Deployment Default",
    logo: "tina-mark-inverse.svg",
    logoStyle: "color",
    group: "managed",
    summary: "Workspace and admin default",
  },
  {
    id: "openai-subscription",
    name: "ChatGPT Plan",
    logo: "openai.svg",
    logoStyle: "invertLight",
    group: "managed",
    summary: "Sign in with OpenAI OAuth",
  },
  {
    id: "subscription",
    name: "Claude Subscription",
    logo: "claude.svg",
    logoStyle: "color",
    group: "managed",
    summary: "Deployment Claude credentials",
  },
  {
    id: "openai-api",
    name: "OpenAI API",
    logo: "openai.svg",
    logoStyle: "invertLight",
    group: "api",
    summary: "GPT-5, GPT-4.1, and o3 models",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModelHint: "gpt-5",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    logo: "gemini.svg",
    logoStyle: "color",
    group: "api",
    summary: "Gemini 3.5, 3.8, and Pro models",
    keyUrl: "https://aistudio.google.com/apikey",
    defaultModelHint: "gemini-3.5-flash",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    logo: "deepseek.svg",
    logoStyle: "color",
    group: "api",
    summary: "Flash, Chat, and Reasoner",
    keyUrl: "https://platform.deepseek.com/api_keys",
    defaultModelHint: "deepseek-flash",
  },
  {
    id: "groq",
    name: "Groq",
    logo: "groq.svg",
    logoStyle: "rounded",
    group: "api",
    summary: "Low-latency Llama, Qwen, and OSS",
    keyUrl: "https://console.groq.com/keys",
    defaultModelHint: "openai/gpt-oss-20b",
  },
  {
    id: "bedrock",
    name: "AWS Bedrock",
    logo: "aws.svg",
    logoStyle: "awsLight",
    group: "advanced",
    summary: "Regional enterprise Claude",
  },
  {
    id: "custom",
    name: "Custom Endpoint",
    logo: "openrouter.svg",
    logoStyle: "invertLight",
    group: "advanced",
    summary: "OpenAI or Anthropic gateway URL",
  },
  {
    id: "antigravity",
    name: "Antigravity CLI",
    logo: "antigravity.svg",
    logoStyle: "color",
    group: "advanced",
    summary: "Unsupported consumer CLI",
  },
];

const PROVIDER_GROUPS: Array<{ id: ProviderGroup; label: string; cols: 2 | 3 }> = [
  { id: "managed", label: "Sign-in and managed", cols: 3 },
  { id: "api", label: "Direct API keys", cols: 2 },
  { id: "advanced", label: "Cloud and custom", cols: 3 },
];

const API_KEY_MODES = new Set([
  "openai-api",
  "groq",
  "deepseek",
  "gemini",
  "bedrock",
  "custom",
  "antigravity",
]);

const TRANSCRIPTION_PRESETS: Record<string, { url: string; label: string }> = {
  viegem: { url: "http://host.docker.internal:18005", label: "VieGem + LM" },
};

function ProviderLogo({
  provider,
  large = false,
}: {
  provider: ProviderMeta;
  large?: boolean;
}) {
  const variantClass =
    provider.logoStyle === "invertLight"
      ? styles.logoInvertLight
      : provider.logoStyle === "awsLight"
        ? styles.logoAwsLight
        : provider.logoStyle === "rounded"
          ? styles.logoRounded
          : "";
  return (
    <img
      src={`/provider-logos/${provider.logo}`}
      alt=""
      aria-hidden="true"
      className={`${styles.logo} ${large ? styles.logoLarge : ""} ${variantClass} tina-web-provider-logo`}
    />
  );
}

function asStrings(v: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v) return out;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" && val) out[k] = val;
  }
  return out;
}

function providerById(id: string | undefined): ProviderMeta {
  return PROVIDERS.find((p) => p.id === (id ?? "")) ?? PROVIDERS[0];
}

function isMaskedSecret(val: string | undefined): boolean {
  return !!val && val.startsWith("********");
}

function transcriptionFormValues(value: object): Record<string, string> {
  const out = asStrings(value as Record<string, unknown>);
  if (out.backend === "custom") {
    const preset = Object.entries(TRANSCRIPTION_PRESETS).find(
      ([key, item]) => key !== "viegem" && item.url === out.url,
    );
    if (preset) out.backend = preset[0];
  }
  return out;
}

function transcriptionDisplay(value: {
  backend?: string | null;
  url?: string | null;
  effective?: { label: string; source: string } | null;
}) {
  return value.effective
    ? {
        ...value.effective,
        label:
          value.backend === "custom"
            ? Object.values(TRANSCRIPTION_PRESETS).find((item) => item.url === value.url)?.label ??
              value.effective.label
            : value.effective.label,
      }
    : null;
}

export function WebModelsPanel({
  scopeMode = "personal",
}: {
  scopeMode?: "personal" | "global";
}) {
  const [subTab, setSubTab] = useState<"agent" | "transcription">("agent");
  const [chatGptStatus, setChatGptStatus] = useState<{ connected: boolean; email: string }>({
    connected: false,
    email: "",
  });
  const [agentSummary, setAgentSummary] = useState<Record<string, string>>({});
  const [effectiveTranscription, setEffectiveTranscription] = useState<{ label: string; source: string } | null>(null);
  const [availableBackends, setAvailableBackends] = useState<string[]>(["default", "custom"]);

  const refreshTranscriptionMeta = useCallback(() => {
    void getTranscriptionPrefs()
      .then((prefs) => {
        setAvailableBackends(prefs.available_backends ?? ["default", "custom"]);
        setEffectiveTranscription(transcriptionDisplay(prefs));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshTranscriptionMeta();
  }, [refreshTranscriptionMeta]);

  const activeProvider = providerById(agentSummary.mode);
  const activeModelText = agentSummary.model || activeProvider.defaultModelHint || activeProvider.name;

  return (
    <div className={styles.root}>
      {scopeMode === "personal" && (
        <div className={styles.topBar}>
          <div className={styles.tabs} role="tablist" aria-label="Model configuration tab">
            <button
              type="button"
              role="tab"
              aria-selected={subTab === "agent"}
              className={styles.tabBtn}
              onClick={() => setSubTab("agent")}
            >
              Agent model
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={subTab === "transcription"}
              className={styles.tabBtn}
              onClick={() => setSubTab("transcription")}
            >
              Speech to text
            </button>
          </div>

          <div className={styles.ledger} aria-label="Active configuration summary">
            <div className={styles.ledgerItem}>
              <span className={styles.ledgerLabel}>Model</span>
              <span className={styles.ledgerValue}>{activeModelText}</span>
            </div>
            <div className={styles.ledgerItem}>
              <span className={styles.ledgerLabel}>Transcription</span>
              <span className={styles.ledgerValue}>
                {effectiveTranscription?.label || "Platform default"}
              </span>
            </div>
          </div>
        </div>
      )}

      {scopeMode === "personal" && subTab === "agent" && (
        <AgentProviderForm
          scope="personal"
          load={async () => asStrings(await getModelPrefs())}
          save={async (update) => {
            const saved = await setModelPrefs(update);
            window.dispatchEvent(new Event("tina-models-changed"));
            return asStrings(saved);
          }}
          chatGptStatus={chatGptStatus}
          onChatGptStatus={setChatGptStatus}
          onValues={setAgentSummary}
        />
      )}

      {scopeMode === "personal" && subTab === "transcription" && (
        <PersonalTranscriptionSection
          availableBackends={availableBackends}
          onUpdated={refreshTranscriptionMeta}
        />
      )}

      {scopeMode === "global" && (
        <div className={styles.flow}>
          <div className={styles.globalNotice}>
            <WebIcon name="globe" size={15} />
            <span>
              <strong>Deployment-wide defaults:</strong> Applies to every user who has not set personal model overrides.
            </span>
          </div>

          <div className={styles.section}>
            <AgentProviderForm
              scope="global"
              load={async () => asStrings(await getGlobalSetting("models"))}
              save={async (update) => asStrings(await setGlobalSetting("models", update))}
              chatGptStatus={chatGptStatus}
              onChatGptStatus={setChatGptStatus}
            />
          </div>

          <GlobalTranscriptionForm onSaved={refreshTranscriptionMeta} />
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Agent Provider Matrix + Flat Auth Band + Model Pickers + Action Footer
   -------------------------------------------------------------------------- */

function AgentProviderForm({
  scope,
  load,
  save,
  chatGptStatus,
  onChatGptStatus,
  onValues,
}: {
  scope: "personal" | "global";
  load: () => Promise<Record<string, string>>;
  save: (update: Record<string, string>) => Promise<Record<string, string>>;
  chatGptStatus: { connected: boolean; email: string };
  onChatGptStatus: (status: { connected: boolean; email: string }) => void;
  onValues?: (values: Record<string, string>) => void;
}) {
  const regionListId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load()
      .then((loaded) => {
        if (!active) return;
        setValues(loaded);
        setInitial(loaded);
        onValues?.(loaded);
        setError(null);
      })
      .catch((err) => {
        if (active) setError(presentError(err).headline);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const mode = values.mode ?? "";

  useEffect(() => {
    // The mounted connection band handles this provider's status and refreshes.
    if (scope !== "personal" || loading || mode === "openai-subscription") return;
    let active = true;
    fetch("/api/models/openai/status", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("Could not check ChatGPT status.");
        return r.json();
      })
      .then((data: { available?: boolean; connected?: boolean; email?: string }) => {
        const connected = data.connected === true && (!workspacePilotMode() || data.available === true);
        if (active) onChatGptStatus({ connected, email: connected ? data.email || "" : "" });
      })
      .catch(() => {
        if (active) onChatGptStatus({ connected: false, email: "" });
      });
    return () => {
      active = false;
    };
  }, [scope, loading, mode, onChatGptStatus]);

  const TRACKED_KEYS = useMemo(
    () => ["mode", "base_url", "region", "api_key", "antigravity_terms_acknowledged", "model", "meeting_model"],
    [],
  );

  const dirty = TRACKED_KEYS.some((k) => (values[k] ?? "") !== (initial[k] ?? ""));
  const activeMeta = providerById(mode);
  const apiProviderInfo = apiModelProvider(mode);
  const canSave = !saving && dirty && canSaveModelPrefs(values);

  const updateField = (key: string, value: string) => {
    const next = { ...values, [key]: value };
    if (key === "mode" && value !== values.mode) {
      if (apiModelProvider(value) || apiModelProvider(values.mode)) {
        for (const pf of ["api_key", "base_url", "model", "meeting_model"]) next[pf] = "";
      }
      setShowKey(false);
    }
    setSaved(false);
    setTestResult(null);
    setTestError(null);
    setValues(next);
    onValues?.(next);
  };

  const handleDiscard = () => {
    setValues(initial);
    onValues?.(initial);
    setSaved(false);
    setError(null);
    setShowKey(false);
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const update: Record<string, string> = {};
    for (const key of TRACKED_KEYS) {
      if ((values[key] ?? "") !== (initial[key] ?? "")) {
        update[key] = values[key] ?? "";
      }
    }
    try {
      const next = await save(update);
      setValues(next);
      setInitial(next);
      onValues?.(next);
      setSaved(true);
      setShowKey(false);
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      setTestResult(await testModels());
    } catch (err) {
      setTestError(presentError(err).headline);
    } finally {
      setTesting(false);
    }
  };

  const useModelPicker = fallbackChoicesForMode(mode) !== null;
  const chatModelEmptyLabel = apiProviderInfo
    ? `Provider default (${apiProviderInfo.model})`
    : mode === "subscription"
      ? "Deployment default (e.g. sonnet)"
      : mode === "antigravity"
        ? "CLI default"
        : mode === "bedrock"
          ? "Choose a regional model (required)"
          : "Provider default";

  const pickerFieldStyle: CSSProperties = {
    width: "100%",
    minHeight: 40,
    boxSizing: "border-box",
    fontSize: 13.5,
    padding: "0 12px",
    borderRadius: "var(--radius-control)",
    border: "1px solid var(--tw-line-strong)",
    background: "var(--tw-card)",
    color: "var(--tw-text)",
  };

  const authSubtitle =
    mode === "openai-subscription"
      ? "Authorize TINA with your ChatGPT subscription via OAuth. No API key required."
      : mode === "" || mode === "subscription"
        ? "Uses credentials managed by this TINA deployment."
        : mode === "bedrock"
          ? "Enter the AWS region and Bedrock API credential issued for that region."
          : mode === "custom"
            ? "Connect an OpenAI or Anthropic-compatible gateway endpoint."
            : mode === "antigravity"
              ? "Acknowledge Google Terms of Service restrictions before saving."
              : `Enter your ${activeMeta.name} key. Stored encrypted and masked on read-back.`;

  return (
    <div className={styles.flow}>
      {error && (
        <div role="alert" className={styles.alertDanger}>
          {error}
        </div>
      )}

      {/* Provider Matrix */}
      <section className={`${styles.section} ${styles.sectionFirst}`} aria-label="Choose AI model provider">
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitleGroup}>
            <h2 className={styles.sectionTitle}>Provider</h2>
            <p className={styles.sectionLead}>
              Choose how TINA authenticates and routes agent replies and meeting summaries.
            </p>
          </div>
          {loading && <span className={styles.loadingNote}>Loading…</span>}
        </div>

        <div className={styles.groups}>
          {PROVIDER_GROUPS.map((group) => {
            const items = PROVIDERS.filter((p) => p.group === group.id);
            return (
              <div key={group.id} className={styles.group}>
                <div className={styles.groupLabel}>{group.label}</div>
                <div
                  className={group.cols === 2 ? styles.matrixTwo : styles.matrixThree}
                  role="radiogroup"
                  aria-label={`${group.label} providers`}
                >
                  {items.map((provider) => {
                    const selected = mode === provider.id;
                    const isChatGptConnected =
                      provider.id === "openai-subscription" && scope === "personal" && chatGptStatus.connected;
                    return (
                      <button
                        key={provider.id || "default"}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`${styles.providerCell} ${selected ? styles.providerCellSelected : ""}`}
                        onClick={() => updateField("mode", provider.id)}
                      >
                        <span className={styles.providerIconSlot}>
                          <ProviderLogo provider={provider} />
                        </span>
                        <span className={styles.providerCopy}>
                          <span className={styles.providerNameRow}>
                            <span className={styles.providerName}>{provider.name}</span>
                            <span
                              className={`${styles.providerMeta} ${isChatGptConnected ? styles.providerMetaConnected : ""}`}
                            >
                              {isChatGptConnected && <span>Connected</span>}
                              {selected && (
                                <span className={styles.providerCheck} aria-hidden="true">
                                  <WebIcon name="check" size={14} />
                                </span>
                              )}
                            </span>
                          </span>
                          <span className={styles.providerDesc}>{provider.summary}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Authentication */}
      <section className={styles.section} aria-label="Provider authentication">
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitleGroup}>
            <h2 className={styles.sectionTitle}>Authentication ({activeMeta.name})</h2>
            <p className={styles.sectionLead}>{authSubtitle}</p>
          </div>
          {activeMeta.keyUrl && (
            <a
              href={activeMeta.keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.inlineLink}
            >
              <span>Get API key</span>
              <WebIcon name="externalLink" size={13} />
            </a>
          )}
        </div>

        {mode === "openai-subscription" && scope === "personal" && (
          <WebChatGPTAuthBand status={chatGptStatus} onStatusChange={onChatGptStatus} />
        )}

        {mode === "openai-subscription" && scope === "global" && (
          <div className={styles.managedNote}>
            <WebIcon name="info" size={15} />
            <span>
              ChatGPT OAuth connections are linked per user account. Users who inherit this global provider sign in from Personal Settings.
            </span>
          </div>
        )}

        {(mode === "" || mode === "subscription") && (
          <div className={styles.managedNote}>
            <WebIcon name="shield" size={15} />
            <span>
              {mode === ""
                ? "No personal credential required. TINA uses the workspace deployment default model and credential."
                : "Uses the deployment Claude subscription credentials. Pick a preferred Claude tier below if needed."}
            </span>
          </div>
        )}

        {mode === "antigravity" && (
          <div className={styles.warningBox} role="alert">
            <div className={styles.warningHead}>
              <WebIcon name="alertTriangle" size={16} />
              <span>Account suspension risk (unsupported consumer CLI)</span>
            </div>
            <p>
              Google says third-party access to Antigravity violates its Terms of Service; wrapping{" "}
              <code>agy</code> in TINA with a consumer-plan login is unsupported and may lead to account
              suspension or termination. Use a Gemini API key or Gemini Enterprise credential instead.
              This choice affects agent turns only; meeting summaries continue using the deployment
              completion provider.
            </p>
            <label className={styles.warningCheck}>
              <input
                type="checkbox"
                checked={values.antigravity_terms_acknowledged === "true"}
                onChange={(e) =>
                  updateField("antigravity_terms_acknowledged", e.target.checked ? "true" : "")
                }
              />
              <span>I have read this warning and acknowledge the account risk.</span>
            </label>
          </div>
        )}

        {(mode === "custom" || mode === "bedrock" || API_KEY_MODES.has(mode)) && (
          <div className={styles.fieldGrid}>
            {mode === "custom" && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor={`tina-base-url-${scope}`}>
                  Base URL
                </label>
                <input
                  id={`tina-base-url-${scope}`}
                  type="url"
                  aria-label="Base URL"
                  placeholder="https://gateway.example.com/v1"
                  className={styles.input}
                  value={values.base_url ?? ""}
                  onChange={(e) => updateField("base_url", e.target.value)}
                />
                <p className={styles.fieldHint}>OpenAI or Anthropic-compatible root URL.</p>
              </div>
            )}

            {mode === "bedrock" && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor={`tina-region-${scope}`}>
                  AWS Region
                </label>
                <input
                  id={`tina-region-${scope}`}
                  type="text"
                  aria-label="AWS Region"
                  list={regionListId}
                  placeholder="us-east-1"
                  className={styles.input}
                  value={values.region ?? ""}
                  onChange={(e) => updateField("region", e.target.value)}
                />
                <datalist id={regionListId}>
                  {BEDROCK_REGIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </datalist>
                <p className={styles.fieldHint}>
                  Use the region where your Bedrock credential was generated.
                </p>
              </div>
            )}

            {API_KEY_MODES.has(mode) && (
              <div
                className={`${styles.field} ${mode !== "custom" && mode !== "bedrock" ? styles.fieldFull : ""}`}
              >
                <div className={styles.fieldLabelRow}>
                  <label className={styles.fieldLabel} htmlFor={`tina-key-${scope}`}>
                    {mode === "antigravity" ? "CLI credential (optional)" : "API key"}
                  </label>
                  {isMaskedSecret(values.api_key) && (
                    <span className={styles.savedMask}>Saved ({values.api_key})</span>
                  )}
                </div>
                <div className={styles.secretWrap}>
                  <input
                    id={`tina-key-${scope}`}
                    aria-label="Credential"
                    type={showKey ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    className={`${styles.input} ${styles.secretInput}`}
                    value={values.api_key ?? ""}
                    placeholder={
                      apiProviderInfo
                        ? `${apiProviderInfo.label} API key (unchanged unless typed)`
                        : "Enter API key (unchanged unless typed)"
                    }
                    onChange={(e) => updateField("api_key", e.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.secretToggle}
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    onClick={() => setShowKey((v) => !v)}
                  >
                    <WebIcon name={showKey ? "eyeOff" : "eye"} size={15} />
                  </button>
                </div>
                <p className={styles.fieldHint}>
                  {apiProviderInfo ? (
                    <>
                      Leave Chat model blank to use <code>{apiProviderInfo.model}</code>. Save, then test credentials below.
                    </>
                  ) : (
                    "Leave blank to keep the existing credential unchanged."
                  )}
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Model Selection */}
      <section className={styles.section} aria-label="Model selection">
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitleGroup}>
            <h2 className={styles.sectionTitle}>Models</h2>
            <p className={styles.sectionLead}>
              Pick the default chat model and an optional model for meeting summaries.
            </p>
          </div>
        </div>

        <div className={styles.fieldGrid}>
          <div className={`${styles.field} ${mode === "antigravity" ? styles.fieldFull : ""}`}>
            <span className={styles.fieldLabel}>Chat model</span>
            {scope === "personal" && mode === "openai-subscription" ? (
              <ChatGPTModelInput
                value={values.model ?? ""}
                onChange={(val) => updateField("model", val)}
                style={pickerFieldStyle}
              />
            ) : useModelPicker ? (
              <ModelPicker
                key={`chat-${mode}`}
                ariaLabel="Chat model"
                value={values.model ?? ""}
                onChange={(val) => updateField("model", val)}
                mode={mode}
                apiKey={values.api_key}
                region={values.region}
                requiresTools
                suggestDefault={mode === "bedrock"}
                emptyLabel={chatModelEmptyLabel}
                style={pickerFieldStyle}
              />
            ) : (
              <input
                type="text"
                aria-label="Chat model"
                className={styles.input}
                value={values.model ?? ""}
                placeholder={
                  apiProviderInfo
                    ? `${apiProviderInfo.model} (default)`
                    : "Deployment default (e.g. sonnet)"
                }
                onChange={(e) => updateField("model", e.target.value)}
              />
            )}
          </div>

          {mode !== "antigravity" && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Meeting summary model</span>
              {useModelPicker ? (
                <ModelPicker
                  key={`meeting-${mode}`}
                  ariaLabel="Meeting model"
                  value={values.meeting_model ?? ""}
                  onChange={(val) => updateField("meeting_model", val)}
                  mode={mode}
                  apiKey={values.api_key}
                  region={values.region}
                  requiresTools={false}
                  emptyLabel="Same as chat model"
                  style={pickerFieldStyle}
                />
              ) : (
                <input
                  type="text"
                  aria-label="Meeting model"
                  className={styles.input}
                  value={values.meeting_model ?? ""}
                  placeholder="Same as chat model"
                  onChange={(e) => updateField("meeting_model", e.target.value)}
                />
              )}
            </div>
          )}
        </div>
      </section>

      {/* Action Footer */}
      <div className={styles.footer}>
        <div className={styles.footerGroup}>
          <button
            type="button"
            className={styles.btnPrimary}
            disabled={!canSave}
            aria-busy={saving}
            onClick={() => void handleSave()}
          >
            <span>{saving ? "Saving…" : "Save changes"}</span>
          </button>

          {dirty && (
            <button
              type="button"
              className={styles.btnSecondary}
              disabled={saving}
              onClick={handleDiscard}
            >
              Discard
            </button>
          )}

          {dirty && <span className={styles.statusDirty}>Unsaved changes</span>}
          {saved && (
            <span role="status" className={styles.statusSaved}>
              Saved. Applies on next agent turn.
            </span>
          )}
        </div>

        {scope === "personal" && mode !== "antigravity" && (
          <div className={styles.footerGroup}>
            <button
              type="button"
              className={styles.btnSecondary}
              disabled={testing || dirty}
              aria-busy={testing}
              title={dirty ? "Save your changes before testing credentials" : "Verify saved provider credentials"}
              onClick={() => void handleTest()}
            >
              <span>{testing ? "Testing…" : "Test connection"}</span>
            </button>
          </div>
        )}
      </div>

      {scope === "personal" && mode === "antigravity" && (
        <p role="status" className={styles.footnote}>
          Antigravity CLI authentication and model availability are validated on the first agent turn.
        </p>
      )}

      {dirty && scope === "personal" && mode !== "antigravity" && (
        <p className={styles.footnote}>
          Save changes first to run a live credential test against your updated configuration.
        </p>
      )}

      {testResult && (
        <div
          role="status"
          className={`${styles.verdict} ${testResult.ok ? styles.verdictOk : styles.verdictFail}`}
        >
          <WebIcon name={testResult.ok ? "check" : "alertTriangle"} size={15} />
          <div className={styles.verdictBody}>
            <div className={styles.verdictHead}>
              <strong>{testResult.ok ? "Connection verified" : "Verification failed"}</strong>
              {testResult.mode && <span className={styles.verdictTag}>{testResult.mode}</span>}
              {testResult.source && <span className={styles.verdictTag}>via {testResult.source}</span>}
            </div>
            <p className={styles.verdictSummary}>{testResult.summary}</p>
          </div>
        </div>
      )}

      {testError && (
        <div role="alert" className={styles.alertDanger}>
          Test failed: {testError}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   ChatGPT Plan OAuth Connection Band
   -------------------------------------------------------------------------- */

function WebChatGPTAuthBand({
  status,
  onStatusChange,
}: {
  status: { connected: boolean; email: string };
  onStatusChange: (next: { connected: boolean; email: string }) => void;
}) {
  const onConnected = useCallback((connected: boolean) => onStatusChange({ connected, email: "" }), [onStatusChange]);
  return workspacePilotMode()
    ? <WorkspaceChatGPTConnection onConnected={onConnected} />
    : <LocalWebChatGPTAuthBand status={status} onStatusChange={onStatusChange} />;
}

function LocalWebChatGPTAuthBand({
  status,
  onStatusChange,
}: {
  status: { connected: boolean; email: string };
  onStatusChange: (next: { connected: boolean; email: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signInUrl, setSignInUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");

  const refresh = useCallback(
    async (clearSignIn = false) => {
      try {
        const res = await fetch("/api/models/openai/status", { cache: "no-store" });
        const data = res.ok ? ((await res.json()) as { connected?: boolean; email?: string }) : {};
        const nextConnected = data.connected === true;
        onStatusChange({ connected: nextConnected, email: data.email || "" });
        if (nextConnected && clearSignIn) {
          setSignInUrl("");
          setCopied(false);
          setCallbackUrl("");
        }
      } catch {
        onStatusChange({ connected: false, email: "" });
      }
    },
    [onStatusChange],
  );

  useEffect(() => {
    void refresh();
    const onMessage = (event: MessageEvent) => {
      let localAlias = false;
      try {
        const sender = new URL(event.origin);
        const app = new URL(window.location.href);
        localAlias =
          sender.protocol === "http:" &&
          app.protocol === "http:" &&
          sender.hostname === "127.0.0.1" &&
          app.hostname === "localhost" &&
          sender.port === app.port;
      } catch {
        /* ignore invalid origin */
      }
      if (
        (event.origin === window.location.origin || localAlias) &&
        event.data?.type === "tina-chatgpt-connected"
      ) {
        void refresh(true);
        window.dispatchEvent(new Event("tina-models-changed"));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh]);

  useEffect(() => {
    if (!signInUrl) return;
    const onFocus = () => {
      void refresh(!status.connected).then(() => window.dispatchEvent(new Event("tina-models-changed")));
    };
    window.addEventListener("focus", onFocus);
    const timer = window.setTimeout(() => {
      setSignInUrl("");
      setCopied(false);
    }, 10 * 60 * 1000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearTimeout(timer);
    };
  }, [signInUrl, status.connected, refresh]);

  const connect = async () => {
    let popup: Window | null = null;
    try {
      popup = window.open("about:blank", "tina-chatgpt-signin", "popup,width=520,height=720");
    } catch {
      /* fallback link remains available */
    }
    setBusy(true);
    setErr(null);
    setSignInUrl("");
    setCopied(false);
    setCallbackUrl("");
    try {
      const response = await fetch("/api/models/openai/start", { method: "POST", cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { authorization_url?: string; error?: string };
      if (!response.ok || !body.authorization_url) {
        throw new Error(body.error || `Sign-in failed (${response.status})`);
      }
      setSignInUrl(body.authorization_url);
      if (popup) popup.location.href = body.authorization_url;
    } catch (e: unknown) {
      popup?.close();
      setErr(presentError(e).headline);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setErr(null);
    setSignInUrl("");
    setCopied(false);
    setCallbackUrl("");
    try {
      const response = await fetch("/api/models/openai/logout", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error("Could not disconnect ChatGPT. Retry shortly.");
      onStatusChange({ connected: false, email: "" });
      window.dispatchEvent(new Event("tina-models-changed"));
    } catch (e: unknown) {
      setErr(presentError(e).headline);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(signInUrl);
      setCopied(true);
      setErr(null);
    } catch {
      setErr("Could not copy. Select the sign-in link below and copy it manually.");
    }
  };

  const finishConnection = async () => {
    setBusy(true);
    setErr(null);
    try {
      const response = await fetch("/api/models/openai/complete", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_url: callbackUrl.trim() }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not finish ChatGPT sign-in.");
      setSignInUrl("");
      setCallbackUrl("");
      setCopied(false);
      await refresh();
      window.dispatchEvent(new Event("tina-models-changed"));
    } catch (e: unknown) {
      setErr(presentError(e).headline);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${styles.authPanel} ${status.connected ? styles.authPanelConnected : ""}`}>
      <div className={styles.authRow}>
        <div className={styles.authIdentity}>
          <span className={styles.authMark} aria-hidden="true">
            <img
              src="/provider-logos/openai.svg"
              alt=""
              className={`${styles.logo} ${styles.logoLarge} ${styles.logoInvertLight} tina-web-provider-logo`}
            />
          </span>
          <div className={styles.authText}>
            <div className={styles.authTitleRow}>
              <strong className={styles.authTitle}>
                {status.connected ? "ChatGPT Plan Connected" : "Connect your ChatGPT Plan"}
              </strong>
              <span className={status.connected ? styles.authStateOk : styles.authStateIdle}>
                {status.connected ? "Active" : "Not linked"}
              </span>
            </div>
            <span className={styles.authDetail}>
              {status.connected
                ? status.email || "Linked via OpenAI OAuth"
                : "Sign in with OpenAI to use your ChatGPT subscription models directly in TINA."}
            </span>
          </div>
        </div>

        <div className={styles.authActions}>
          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            className={status.connected ? styles.btnSecondary : styles.btnInk}
            onClick={() => void connect()}
          >
            <span>
              {busy ? "Please wait…" : status.connected ? "Reconnect" : "Continue with ChatGPT"}
            </span>
          </button>
          {status.connected && (
            <button
              type="button"
              disabled={busy}
              className={styles.btnDangerText}
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {err && (
        <div role="alert" className={styles.alertDanger}>
          {err}
        </div>
      )}

      {signInUrl && (
        <div className={styles.oauthFallback}>
          <div className={styles.oauthFallbackHead}>
            <span>Waiting for ChatGPT sign-in window…</span>
            <div className={styles.oauthFallbackBtns}>
              <a
                href={signInUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.btnSecondary}
              >
                <span>Open link</span>
                <WebIcon name="externalLink" size={13} />
              </a>
              <button type="button" className={styles.btnSecondary} onClick={() => void copyLink()}>
                <span>{copied ? "Copied" : "Copy link"}</span>
              </button>
            </div>
          </div>

          <input
            aria-label="ChatGPT sign-in URL"
            readOnly
            value={signInUrl}
            onFocus={(e) => e.currentTarget.select()}
            className={styles.input}
          />

          <p className={styles.fieldHint}>
            If sign-in opened in another browser profile, copy the final callback URL after login and paste it below (expires in 10 minutes).
          </p>

          <div className={styles.inlineRow}>
            <input
              type="text"
              aria-label="Callback URL from the other browser"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://localhost:.../callback?code=..."
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              className={styles.input}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={busy || !callbackUrl.trim()}
              onClick={() => void finishConnection()}
            >
              Finish connection
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Personal Speech-to-Text Section (Managed ASR + Other Providers)
   -------------------------------------------------------------------------- */

function PersonalTranscriptionSection({
  availableBackends,
  onUpdated,
}: {
  availableBackends: string[];
  onUpdated: () => void;
}) {
  const [runtime, setRuntime] = useState<AsrRuntime | null>(null);
  const [runtimeError, setRuntimeError] = useState("");
  const [runtimeFetchError, setRuntimeFetchError] = useState("");
  const [runtimeTarget, setRuntimeTarget] = useState<"viegem" | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advValues, setAdvValues] = useState<Record<string, string>>({});
  const [advInitial, setAdvInitial] = useState<Record<string, string>>({});
  const [advBusy, setAdvBusy] = useState(false);
  const [advSaved, setAdvSaved] = useState(false);
  const [advError, setAdvError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () =>
      getAsrRuntime()
        .then((val) => {
          if (active) {
            setRuntime(val);
            setRuntimeFetchError("");
          }
        })
        .catch(() => {
          if (active) setRuntimeFetchError("ASR control is unavailable. Retry shortly.");
        });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const loadAdvanced = useCallback(async () => {
    try {
      const prefs = await getTranscriptionPrefs();
      const mapped = transcriptionFormValues(prefs);
      if (mapped.backend in TRANSCRIPTION_PRESETS) mapped.backend = "managed";
      setAdvValues(mapped);
      setAdvInitial(mapped);
      setAdvError(null);
    } catch (err) {
      setAdvError(presentError(err).headline);
    }
  }, []);

  useEffect(() => {
    if (advancedOpen) void loadAdvanced();
  }, [advancedOpen, loadAdvanced]);

  const changeRuntime = async (backend: "viegem", enabled: boolean) => {
    setRuntimeBusy(true);
    setRuntimeTarget(backend);
    setRuntimeError("");
    try {
      const current = await getAsrRuntime();
      const saved = await setAsrRuntime(backend, enabled, current.account.revision);
      setRuntime(saved);
      onUpdated();
      if (advancedOpen) void loadAdvanced();
    } catch (err) {
      setRuntimeError(presentError(err).headline);
    } finally {
      setRuntimeBusy(false);
      setRuntimeTarget(null);
    }
  };

  const advDirty = ["backend", "url", "token"].some((k) => (advValues[k] ?? "") !== (advInitial[k] ?? ""));

  const saveAdvanced = async () => {
    setAdvBusy(true);
    setAdvError(null);
    setAdvSaved(false);
    const update: Record<string, string> = {};
    for (const key of ["backend", "url", "token"]) {
      if ((advValues[key] ?? "") !== (advInitial[key] ?? "")) update[key] = advValues[key] ?? "";
    }
    try {
      const saved = await setTranscriptionPrefs(update);
      const mapped = transcriptionFormValues(saved);
      setAdvValues(mapped);
      setAdvInitial(mapped);
      setAdvSaved(true);
      onUpdated();
      void getAsrRuntime().then(setRuntime).catch(() => undefined);
    } catch (err) {
      setAdvError(presentError(err).headline);
    } finally {
      setAdvBusy(false);
    }
  };

  return (
    <div className={styles.flow}>
      <div className={`${styles.section} ${styles.sectionFirst}`}>
        <TranscriptionPicker
          runtime={runtime}
          available={availableBackends}
          busy={runtimeBusy}
          target={runtimeTarget}
          error={runtimeError || runtimeFetchError}
          unavailable={!!runtimeFetchError}
          onChange={(backend, enabled) => void changeRuntime(backend, enabled)}
        />
      </div>

      <details
        className={styles.disclosure}
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
      >
        <summary>
          <WebIcon name={advancedOpen ? "chevronDown" : "chevronRight"} size={15} />
          <span>Other transcription providers (GPU or custom endpoint)</span>
        </summary>
        {advancedOpen && (
          <div className={styles.disclosureBody}>
            {advError && (
              <div role="alert" className={styles.alertDanger}>
                {advError}
              </div>
            )}
            <div className={styles.fieldGrid}>
              <div className={`${styles.field} ${styles.fieldFull}`}>
                <label className={styles.fieldLabel} htmlFor="tina-adv-stt-backend">
                  Backend
                </label>
                <select
                  id="tina-adv-stt-backend"
                  className={styles.select}
                  value={advValues.backend ?? "default"}
                  onChange={(e) => {
                    setAdvValues((c) => ({ ...c, backend: e.target.value }));
                    setAdvSaved(false);
                  }}
                >
                  <option value="managed" disabled>
                    Model selected above
                  </option>
                  <option value="default">Follow platform default</option>
                  <option value="apple" disabled={!availableBackends.includes("apple")}>
                    Apple GPU (MLX/Metal){availableBackends.includes("apple") ? "" : " (not configured)"}
                  </option>
                  <option value="nvidia" disabled={!availableBackends.includes("nvidia")}>
                    Nvidia GPU (CUDA){availableBackends.includes("nvidia") ? "" : " (not configured)"}
                  </option>
                  <option value="funasr" disabled={!availableBackends.includes("funasr")}>
                    FunASR (Qwen + FSMN-VAD){availableBackends.includes("funasr") ? "" : " (not configured)"}
                  </option>
                  <option value="sherpa" disabled={!availableBackends.includes("sherpa")}>
                    Sherpa (Qwen INT8 + Silero){availableBackends.includes("sherpa") ? "" : " (not configured)"}
                  </option>
                  <option value="custom">Custom endpoint</option>
                </select>
              </div>

              {advValues.backend === "custom" && (
                <>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor="tina-adv-stt-url">
                      Service URL
                    </label>
                    <input
                      id="tina-adv-stt-url"
                      type="url"
                      className={styles.input}
                      placeholder="https://asr.example.com"
                      value={advValues.url ?? ""}
                      onChange={(e) => {
                        setAdvValues((c) => ({ ...c, url: e.target.value }));
                        setAdvSaved(false);
                      }}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor="tina-adv-stt-token">
                      Token
                    </label>
                    <input
                      id="tina-adv-stt-token"
                      type="password"
                      className={styles.input}
                      placeholder="Unchanged unless typed"
                      value={advValues.token ?? ""}
                      onChange={(e) => {
                        setAdvValues((c) => ({ ...c, token: e.target.value }));
                        setAdvSaved(false);
                      }}
                    />
                  </div>
                </>
              )}
            </div>

            <div className={styles.footerGroup}>
              <button
                type="button"
                className={styles.btnPrimary}
                disabled={advBusy || !advDirty}
                aria-busy={advBusy}
                onClick={() => void saveAdvanced()}
              >
                {advBusy ? "Saving…" : "Save backend"}
              </button>
              {advSaved && (
                <span role="status" className={styles.statusSaved}>
                  Saved. Applies to new sessions.
                </span>
              )}
            </div>
          </div>
        )}
      </details>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Admin Global Transcription Defaults Section
   -------------------------------------------------------------------------- */

function GlobalTranscriptionForm({ onSaved }: { onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({ default_backend: "deployment" });
  const [initial, setInitial] = useState<Record<string, string>>({ default_backend: "deployment" });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const KEYS = [
    "default_backend",
    "url",
    "token",
    "funasr_url",
    "sherpa_url",
    "viegem_url",
    "viegem_token",
    "apple_url",
    "apple_token",
    "nvidia_url",
    "nvidia_token",
  ];

  useEffect(() => {
    let active = true;
    getGlobalSetting("transcription")
      .then((val) => {
        if (!active) return;
        const next = { ...asStrings(val), default_backend: val?.default_backend || "deployment" };
        setValues(next);
        setInitial(next);
      })
      .catch((err) => {
        if (active) setError(presentError(err).headline);
      });
    return () => {
      active = false;
    };
  }, []);

  const dirty = KEYS.some((k) => (values[k] ?? "") !== (initial[k] ?? ""));

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const update: Record<string, string> = {};
    for (const key of KEYS) {
      if ((values[key] ?? "") !== (initial[key] ?? "")) update[key] = values[key] ?? "";
    }
    try {
      const next = await setGlobalSetting("transcription", update);
      const normalized = { ...asStrings(next), default_backend: next?.default_backend || "deployment" };
      setValues(normalized);
      setInitial(normalized);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const setField = (key: string, val: string) => {
    setValues((c) => ({ ...c, [key]: val }));
    setSaved(false);
  };

  return (
    <section className={styles.globalDivider} aria-label="Global transcription defaults">
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitleGroup}>
          <h2 className={styles.sectionTitle}>Global Transcription Backend</h2>
          <p className={styles.sectionLead}>
            Shared default for meeting bots, Desktop extension capture, and TINA Capture. Personal preferences take priority.
          </p>
        </div>
      </div>

      {error && (
        <div role="alert" className={styles.alertDanger}>
          {error}
        </div>
      )}

      <div className={styles.fieldGrid}>
        <div className={`${styles.field} ${styles.fieldFull}`}>
          <label className={styles.fieldLabel} htmlFor="tina-global-stt-default">
            Default backend
          </label>
          <select
            id="tina-global-stt-default"
            className={styles.select}
            value={values.default_backend ?? "deployment"}
            onChange={(e) => setField("default_backend", e.target.value)}
          >
            <option value="deployment">Deployment endpoint</option>
            <option value="funasr">FunASR (Qwen + FSMN-VAD)</option>
            <option value="sherpa">Sherpa (Qwen INT8 + Silero)</option>
            <option value="viegem">VieGem + LM</option>
            <option value="apple">Apple GPU (MLX/Metal)</option>
            <option value="nvidia">Nvidia GPU (CUDA)</option>
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="tina-global-stt-url">
            Deployment URL
          </label>
          <input
            id="tina-global-stt-url"
            className={styles.input}
            value={values.url ?? ""}
            placeholder="Existing TRANSCRIPTION_SERVICE_URL"
            onChange={(e) => setField("url", e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="tina-global-stt-token">
            Deployment token
          </label>
          <input
            id="tina-global-stt-token"
            type="password"
            className={styles.input}
            value={values.token ?? ""}
            placeholder="Unchanged unless typed"
            onChange={(e) => setField("token", e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="tina-global-viegem-url">
            VieGem + LM endpoint
          </label>
          <input
            id="tina-global-viegem-url"
            className={styles.input}
            value={values.viegem_url ?? ""}
            placeholder="http://host.docker.internal:18005"
            onChange={(e) => setField("viegem_url", e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="tina-global-viegem-token">
            VieGem worker token
          </label>
          <input
            id="tina-global-viegem-token"
            type="password"
            className={styles.input}
            value={values.viegem_token ?? ""}
            placeholder="Unchanged unless typed"
            onChange={(e) => setField("viegem_token", e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="tina-global-funasr-url">
            FunASR endpoint
          </label>
          <input
            id="tina-global-funasr-url"
            className={styles.input}
            value={values.funasr_url ?? ""}
            placeholder="http://host.docker.internal:18000"
            onChange={(e) => setField("funasr_url", e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="tina-global-sherpa-url">
            Sherpa native endpoint
          </label>
          <input
            id="tina-global-sherpa-url"
            className={styles.input}
            value={values.sherpa_url ?? ""}
            placeholder="http://host.docker.internal:18001"
            onChange={(e) => setField("sherpa_url", e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="tina-global-apple-url">
            Apple GPU (MLX/Metal) endpoint
          </label>
          <input
            id="tina-global-apple-url"
            className={styles.input}
            value={values.apple_url ?? ""}
            placeholder="http://host.docker.internal:8084"
            onChange={(e) => setField("apple_url", e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="tina-global-apple-token">
            Apple GPU token
          </label>
          <input
            id="tina-global-apple-token"
            type="password"
            className={styles.input}
            value={values.apple_token ?? ""}
            placeholder="Unchanged unless typed"
            onChange={(e) => setField("apple_token", e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="tina-global-nvidia-url">
            Nvidia GPU endpoint
          </label>
          <input
            id="tina-global-nvidia-url"
            className={styles.input}
            value={values.nvidia_url ?? ""}
            placeholder="CUDA transcription worker URL"
            onChange={(e) => setField("nvidia_url", e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="tina-global-nvidia-token">
            Nvidia GPU token
          </label>
          <input
            id="tina-global-nvidia-token"
            type="password"
            className={styles.input}
            value={values.nvidia_token ?? ""}
            placeholder="Unchanged unless typed"
            onChange={(e) => setField("nvidia_token", e.target.value)}
          />
        </div>
      </div>

      <div className={styles.footerGroup}>
        <button
          type="button"
          className={styles.btnPrimary}
          disabled={busy || !dirty}
          aria-busy={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save global transcription"}
        </button>
        {saved && (
          <span role="status" className={styles.statusSaved}>
            Saved. Applies to new sessions.
          </span>
        )}
      </div>
    </section>
  );
}
