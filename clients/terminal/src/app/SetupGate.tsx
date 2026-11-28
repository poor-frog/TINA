"use client";
/** SetupGate — the ADMIN first-run wizard (first-run onboarding design, 2026-07-09). Sits inside
 *  AuthGate: once the bootstrap-claimed admin signs in, this walks the two things a meeting needs
 *  — the agent model and the transcription backend — each SMOKE-TESTED inline against the real
 *  backend (the same /api/{models,transcription}/test edges Settings → Models ships), writing the
 *  GLOBAL platform settings (this is the instance-wide admin flow; per-user overrides stay in
 *  Settings). Durable state lives in the platform-settings "setup" key, so the wizard shows once
 *  per INSTANCE, never per browser. Non-admins (the setup probe 404s → null) fall straight
 *  through — they can never see or affect instance setup.
 *
 *  Every step is skippable (the terminal must never hold the UI hostage); skipped steps are
 *  recorded so Settings can nudge later. */
import { useEffect, useState, type CSSProperties } from "react";
import styles from "./SetupGate.module.css";
import {
  apiModelProvider, getGlobalSetting, setGlobalSetting, testModels, testTranscription,
  type ConfigTestResult, type GlobalSetting,
} from "../surfaces/settingsApi";
import { ChatGPTModelInput } from "../surfaces/chatGPTModelInput";

/** Show the wizard? null = not an admin (probe 404s); completed set = already ran. */
export function shouldShowSetup(setup: GlobalSetting | null): boolean {
  if (setup === null) return false;
  return setup.completed !== "true";
}

type Phase = "checking" | "hidden" | "wizard";
type StepState = "done" | "skipped";

/** Visually hidden but still focusable — the real radio behind each provider card. */
const srOnly: CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};
const field: CSSProperties = {
  width: "100%", boxSizing: "border-box", fontSize: 14, padding: "10px 12px", borderRadius: 8,
  border: "1px solid var(--line2)", background: "var(--panel2)", color: "var(--t1)",
};
const primaryBtn: CSSProperties = {
  background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: 8,
  padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer",
};
const quietBtn: CSSProperties = {
  background: "transparent", color: "var(--t2)", border: "1px solid var(--line2)", borderRadius: 8,
  padding: "8px 14px", fontSize: 13.5, cursor: "pointer",
};

function TestLine({ res, err, busy }: { res: ConfigTestResult | null; err: string | null; busy: boolean }) {
  if (busy) return <span className={styles.testStatus}>Testing…</span>;
  if (err) return <span role="alert" className={styles.testError}>⚠ {err}</span>;
  if (!res) return null;
  return (
    <span role="status" className={res.ok ? styles.testOk : styles.testError}>
      {res.ok ? "✓" : "✗"} {res.summary}
    </span>
  );
}

/** Step 1 — agent model: Claude subscription on this machine (detect via the real test edge) or a
 *  custom OpenRouter/OpenAI-compatible endpoint. */
function ModelsStep({ onNext }: { onNext: (state: StepState) => void }) {
  type Choice = "subscription" | "openai-subscription" | "openai-api" | "antigravity" | "bedrock" | "custom" | "groq" | "deepseek" | "gemini";
  const providers: Array<{ value: Choice; label: string; description: string; logo?: string }> = [
    { value: "subscription", label: "Claude subscription on this machine", description: "Uses the Claude Code credentials already on this computer. No API key needed.", logo: "anthropic.svg" },
    { value: "openai-subscription", label: "ChatGPT plan (Codex app-server)", description: "Connect your ChatGPT account and allow TINA to use eligible plan usage. Requests count toward that account’s usage.", logo: "openai.svg" },
    { value: "openai-api", label: "OpenAI API key", description: "API usage is billed through your OpenAI API account, separately from your ChatGPT plan.", logo: "openai.svg" },
    { value: "groq", label: "Groq API key", description: "Use a Groq-hosted model for chat and meeting notes. Bring your Groq API key; speech-to-text is configured separately.", logo: "groq.svg" },
    { value: "deepseek", label: "DeepSeek API key", description: "Use DeepSeek for chat and meeting notes with your DeepSeek API key.", logo: "deepseek.svg" },
    { value: "gemini", label: "Gemini API key", description: "Use Google's Gemini API for chat and meeting notes with a key from Google AI Studio.", logo: "gemini.svg" },
    { value: "antigravity", label: "Google Antigravity CLI (agy)", description: "Use a Gemini API key or Gemini Enterprise credential. This choice affects agent turns; meeting summaries keep using the deployment completion provider. Access is checked on the first agent turn.", logo: "antigravity.svg" },
    { value: "bedrock", label: "AWS Bedrock", description: "Use a Bedrock API key with a Claude model enabled in your AWS account. Short-term keys expire and may need renewal.", logo: "aws.svg" },
    { value: "custom", label: "OpenRouter or custom endpoint", description: "Any Anthropic/OpenAI-compatible endpoint. Bring your own key.", logo: "openrouter.svg" },
  ];
  const [choice, setChoice] = useState<Choice>("subscription");
  const [detect, setDetect] = useState<ConfigTestResult | null>(null);
  const [detecting, setDetecting] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [model, setModel] = useState("");
  const [res, setRes] = useState<ConfigTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chatgptConnected, setChatgptConnected] = useState(false);
  const [antigravityAcknowledged, setAntigravityAcknowledged] = useState(false);
  const [antigravitySaved, setAntigravitySaved] = useState(false);

  const recheck = () => {
    setDetecting(true);
    testModels().then((r) => { setDetect(r); setDetecting(false); })
      .catch((e: unknown) => { setDetect({ ok: false, summary: e instanceof Error ? e.message : String(e) }); setDetecting(false); });
  };
  useEffect(recheck, []);
  useEffect(() => {
    let on = true;
    fetch("/api/models/openai/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { connected: false }))
      .then((d: { connected?: boolean }) => on && setChatgptConnected(d.connected === true))
      .catch(() => undefined);
    return () => { on = false; };
  }, []);

  const detected = !detecting && detect?.ok === true;

  const saveAndTest = async (selected: Choice = choice) => {
    setBusy(true); setErr(null); setRes(null);
    try {
      if (selected === "custom") {
        await setGlobalSetting("models", {
          mode: "custom", base_url: baseUrl.trim(), api_key: apiKey.trim(), model: model.trim(),
        });
      } else if (selected === "openai-api") {
        await setGlobalSetting("models", {
          mode: "openai-api", base_url: "https://api.openai.com/v1", api_key: apiKey.trim(), model: model.trim(),
        });
      } else if (apiModelProvider(selected)) {
        await setGlobalSetting("models", {
          mode: selected, api_key: apiKey.trim(), model: model.trim(),
        });
      } else if (selected === "bedrock") {
        await setGlobalSetting("models", {
          mode: "bedrock", region: region.trim(), api_key: apiKey.trim(), model: model.trim(),
        });
      } else if (selected === "antigravity") {
        if (!antigravityAcknowledged) throw new Error("Acknowledge the Antigravity Terms warning before continuing.");
        await setGlobalSetting("models", {
          mode: "antigravity", api_key: apiKey.trim(), model: model.trim(),
          antigravity_terms_acknowledged: "true",
        });
        setAntigravitySaved(true);
        return;
      } else if (selected === "openai-subscription") {
        await setGlobalSetting("models", { mode: "openai-subscription", model: model.trim() });
      } else {
        await setGlobalSetting("models", { mode: "subscription" });
      }
      setRes(await testModels());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connectChatGPT = async () => {
    const popup = window.open("about:blank", "tina-chatgpt-signin", "popup,width=520,height=720");
    setBusy(true); setErr(null); setRes(null);
    try {
      await setGlobalSetting("models", { mode: "openai-subscription", model: model.trim() });
      const response = await fetch("/api/models/openai/start", { method: "POST", cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { authorization_url?: string; error?: string };
      if (!response.ok || !body.authorization_url) throw new Error(body.error || `Sign-in failed (${response.status})`);
      if (popup) popup.location.href = body.authorization_url;
      else window.location.href = body.authorization_url;
    } catch (e: unknown) {
      popup?.close();
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      let localAlias = false;
      try {
        const sender = new URL(event.origin), app = new URL(window.location.href);
        localAlias = sender.protocol === "http:" && app.protocol === "http:"
          && sender.hostname === "127.0.0.1" && app.hostname === "localhost" && sender.port === app.port;
      } catch { /* invalid origin */ }
      if ((event.origin !== window.location.origin && !localAlias)
          || event.data?.type !== "tina-chatgpt-connected") return;
      setChatgptConnected(true);
      setErr(null); setRes(null);
      if (model.trim()) void saveAndTest("openai-subscription");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // The popup completion should use the latest model value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const canContinue = (choice === "subscription" && detected) || res?.ok === true
    || (choice === "antigravity" && antigravityAcknowledged && antigravitySaved);
  const selectedProvider = providers.find((provider) => provider.value === choice)!;
  const selectedApiProvider = choice === "openai-api" ? null : apiModelProvider(choice);

  return (
    <>
      <div className={styles.stepContent}>
        <div className={styles.stepIntro}>
          <span className={styles.stepIndex}>01 / AGENT MODEL</span>
          <h1 className={styles.stepTitle}>How should the agent think?</h1>
          <p className={styles.stepDescription}>Pick the model provider for chat, briefs, and meeting notes. You can change this anytime in Settings → Models.</p>
        </div>

        <div className={styles.providerGallery} role="radiogroup" aria-label="Agent model provider">
          {providers.map((provider) => (
            <label key={provider.value} className={`${styles.providerChoice} ${choice === provider.value ? styles.providerChoiceSelected : ""}`}>
              <input type="radio" name="model-provider" id={`mp-${provider.value}`} style={srOnly}
                checked={choice === provider.value} onChange={() => {
                  if (provider.value !== choice && (apiModelProvider(provider.value) || apiModelProvider(choice))) {
                    setApiKey(""); setModel(""); setRes(null); setErr(null);
                  }
                  setChoice(provider.value);
                }} />
              {provider.logo
                ? <img className={styles.providerLogo} src={`/provider-logos/${provider.logo}`} alt="" aria-hidden="true" />
                : <span className={styles.providerLogo} aria-hidden="true" style={{ fontSize: 14, fontWeight: 700 }}>{provider.label[0]}</span>}
              <span className={styles.providerOptionName}>{provider.label}</span>
              {provider.value === "subscription" && (
                <Badge tone={detecting ? "muted" : detected ? "ok" : "warn"}>
                  {detecting ? "checking…" : detected ? "detected" : "not detected"}
                </Badge>
              )}
              {provider.value === "openai-subscription" && chatgptConnected && <Badge tone="ok">connected</Badge>}
            </label>
          ))}
        </div>

        <section className={styles.selectedProvider} aria-live="polite">
          <div className={styles.selectedHeader}>
            <div>
              <div className={styles.selectedEyebrow}>Selected provider</div>
              <h2>{selectedProvider.label}</h2>
            </div>
          </div>
          <p className={styles.selectedDescription}>{selectedProvider.description}</p>

          {choice === "subscription" && !detecting && !detected && (
            <div className={styles.helperBox}>
              <p>No Claude credentials detected in the deployment environment. Set up a model provider via <code>HOST_CLAUDE_CREDENTIALS</code> in deployment settings or select the “OpenRouter or custom endpoint” option above. You can change this later in Settings → Models.</p>
              {detect && !detect.ok && <TestLine res={detect} err={null} busy={false} />}
              <button style={quietBtn} onClick={recheck}>Re-check</button>
            </div>
          )}
          {choice === "subscription" && detecting && <div className={styles.detailStatus}><TestLine res={null} err={null} busy /></div>}
          {choice === "subscription" && detected && <div className={styles.detailStatus}><TestLine res={detect} err={null} busy={false} /></div>}

          {choice === "openai-subscription" && (
            <div className={styles.formFields}>
              <ChatGPTModelInput value={model} onChange={setModel} style={field} />
              <div className={styles.actions}>
                <button style={{ ...quietBtn, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => void connectChatGPT()}>
                  {busy ? "Connecting…" : chatgptConnected ? "Reconnect with ChatGPT" : "Continue with ChatGPT"}
                </button>
                {chatgptConnected && <button style={{ ...quietBtn, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => void saveAndTest("openai-subscription")}>
                  {busy ? "Testing…" : "Save & test"}
                </button>}
              </div>
              <TestLine res={res} err={err} busy={false} />
            </div>
          )}

          {choice === "openai-api" && (
            <div className={styles.formFields}>
              <input style={field} placeholder="OpenAI API key" value={apiKey} type="password" onChange={(e) => setApiKey(e.target.value)} />
              <input style={field} placeholder="OpenAI API model ID" value={model} onChange={(e) => setModel(e.target.value)} />
              <div className={styles.actions}>
                <button style={{ ...quietBtn, opacity: busy || !apiKey.trim() || !model.trim() ? 0.5 : 1 }} disabled={busy || !apiKey.trim() || !model.trim()}
                  onClick={() => void saveAndTest("openai-api")}>{busy ? "Testing…" : "Save & test"}</button>
                <TestLine res={res} err={err} busy={false} />
              </div>
            </div>
          )}

          {selectedApiProvider && (
            <div className={styles.formFields}>
              <a href={selectedApiProvider.keyUrl} target="_blank" rel="noopener noreferrer">Get a {selectedApiProvider.label} API key</a>
              <input style={field} aria-label={`${selectedApiProvider.label} API key`} placeholder={`${selectedApiProvider.label} API key`} value={apiKey} type="password" autoComplete="off" onChange={(e) => setApiKey(e.target.value)} />
              <input style={field} aria-label={`${selectedApiProvider.label} model`} placeholder={`${selectedApiProvider.model} (default)`} value={model} onChange={(e) => setModel(e.target.value)} />
              <div className={styles.actions}>
                <button style={{ ...quietBtn, opacity: busy || !apiKey.trim() ? 0.5 : 1 }} disabled={busy || !apiKey.trim()}
                  onClick={() => void saveAndTest(choice)}>{busy ? "Testing…" : "Save & test"}</button>
                <TestLine res={res} err={err} busy={false} />
              </div>
            </div>
          )}

          {choice === "antigravity" && (
            <div className={styles.formFields}>
              <div role="alert" className={styles.warningBox}>
                Google says third-party access to Antigravity violates its Terms of Service. Using a consumer-plan login with <code>agy</code> inside TINA is unsupported and may lead to account suspension or termination. Acknowledgment does not make it permitted. Use a Gemini API key or Gemini Enterprise for TINA.
              </div>
              <input style={field} placeholder="Gemini API key (optional)" value={apiKey} type="password" onChange={(e) => { setApiKey(e.target.value); setAntigravitySaved(false); }} />
              <input style={field} placeholder="Antigravity model ID (optional)" value={model} onChange={(e) => { setModel(e.target.value); setAntigravitySaved(false); }} />
              <label className={styles.checkRow}>
                <input type="checkbox" checked={antigravityAcknowledged} onChange={(e) => { setAntigravityAcknowledged(e.target.checked); setAntigravitySaved(false); }} />
                I have read this warning and acknowledge the account risk.
              </label>
              <div className={styles.actions}>
                <button style={{ ...quietBtn, opacity: busy || !antigravityAcknowledged ? 0.5 : 1 }} disabled={busy || !antigravityAcknowledged}
                  onClick={() => void saveAndTest("antigravity")}>
                  {busy ? "Saving…" : antigravitySaved ? "Saved" : "Save provider"}
                </button>
                {antigravitySaved && <span className={styles.detailStatus} role="status">Authentication and model access will be checked on the first agent turn.</span>}
              </div>
            </div>
          )}

          {choice === "bedrock" && (
            <div className={styles.formFields}>
              <input style={field} placeholder="AWS region (e.g. us-east-1)" value={region} onChange={(e) => setRegion(e.target.value)} />
              <input style={field} placeholder="Bedrock API key" value={apiKey} type="password" onChange={(e) => setApiKey(e.target.value)} />
              <input style={field} placeholder="Claude model ID enabled in your AWS region" value={model} onChange={(e) => setModel(e.target.value)} />
              <div className={styles.actions}>
                <button style={{ ...quietBtn, opacity: busy || !apiKey.trim() || !region.trim() || !model.trim() ? 0.5 : 1 }} disabled={busy || !apiKey.trim() || !region.trim() || !model.trim()}
                  onClick={() => void saveAndTest("bedrock")}>{busy ? "Testing…" : "Save & test"}</button>
                <TestLine res={res} err={err} busy={false} />
              </div>
            </div>
          )}

          {choice === "custom" && (
            <div className={styles.formFields}>
              <input style={field} placeholder="https://openrouter.ai/api/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              <input style={field} placeholder="API key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              <input style={field} placeholder="Model — e.g. anthropic/claude-sonnet-4.5" value={model} onChange={(e) => setModel(e.target.value)} />
              <div className={styles.actions}>
                <button style={{ ...quietBtn, opacity: busy || !baseUrl.trim() ? 0.5 : 1 }} disabled={busy || !baseUrl.trim()}
                  onClick={() => void saveAndTest("custom")}>{busy ? "Testing…" : "Save & test"}</button>
                <TestLine res={res} err={err} busy={false} />
              </div>
            </div>
          )}
        </section>
      </div>

      <Foot
        onSkip={() => onNext("skipped")}
        next={
          <button style={{ ...primaryBtn, opacity: canContinue ? 1 : 0.5 }} disabled={!canContinue}
            onClick={async () => {
              // Subscription path: persist the explicit choice so the instance default is declared.
              if (choice === "subscription" && !res) {
                try { await setGlobalSetting("models", { mode: "subscription" }); } catch { /* declarative only */ }
              }
              onNext("done");
            }}>
            Continue
          </button>
        }
      />
    </>
  );
}

/** Step 2 — transcription: connect to a self-hosted OpenAI-compatible STT service. */
function TranscriptionStep({ onNext }: { onNext: (state: StepState) => void }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [res, setRes] = useState<ConfigTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The deployment env may already carry a working backend —
  // surface that: a green pre-test means "you can just continue".
  useEffect(() => {
    testTranscription().then(setRes).catch(() => undefined);
  }, []);

  const saveAndTest = async () => {
    setBusy(true); setErr(null);
    try {
      await setGlobalSetting("transcription", { url: url.trim(), token: token.trim() });
      setRes(await testTranscription());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const dirty = !!url.trim();

  return (
    <>
      <div className={styles.stepContent}>
        <div className={styles.stepIntro}>
          <span className={styles.stepIndex}>02 / TRANSCRIPTION</span>
          <h1 className={styles.stepTitle}>Self-hosted transcription</h1>
          <p className={styles.stepDescription}>Point meeting bots at an OpenAI-compatible transcription endpoint you control.</p>
        </div>

        <section className={styles.transcriptionPanel}>
          <div className={styles.selectedHeader}>
            <div className={styles.providerHeading}>
              <Radio on />
              <h2>OpenAI-compatible endpoint</h2>
            </div>
          </div>
          <p className={styles.selectedDescription}>Use a local or private STT service. The URL must be reachable from the TINA meeting service.</p>
          <div className={styles.formFields}>
            <label className={styles.fieldLabel}>
              Service URL
              <input style={field} placeholder="http://transcription:8083" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label className={styles.fieldLabel}>
              API key (optional)
              <input style={field} placeholder="API key (optional)" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
            </label>
            <div className={styles.actions}>
              <button style={{ ...quietBtn, opacity: busy || !dirty ? 0.5 : 1 }} disabled={busy || !dirty}
                onClick={() => void saveAndTest()}>
                {busy ? "Testing…" : "Save & test"}
              </button>
              <TestLine res={res} err={err} busy={busy} />
            </div>
          </div>
        </section>
      </div>

      <Foot
        onSkip={() => onNext("skipped")}
        next={
          <button style={{ ...primaryBtn, opacity: res?.ok ? 1 : 0.5 }} disabled={!res?.ok} onClick={() => onNext("done")}>
            Finish setup
          </button>
        }
      />
    </>
  );
}

function Radio({ on }: { on: boolean }) {
  return <span aria-hidden="true" className={`${styles.radio} ${on ? styles.radioSelected : ""}`} />;
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "muted"; children: React.ReactNode }) {
  const toneClass = tone === "ok" ? styles.badgeOk : tone === "warn" ? styles.badgeWarn : styles.badgeMuted;
  return <span className={`${styles.badge} ${toneClass}`}>{children}</span>;
}

function Foot({ onSkip, next }: { onSkip: () => void; next: React.ReactNode }) {
  return (
    <div className={styles.footer}>
      <button className={styles.skipButton} onClick={onSkip}>
        Skip for now
      </button>
      {next}
    </div>
  );
}

function Steps({ at }: { at: 1 | 2 }) {
  const dot = (n: number, label: string) => {
    const on = at === n, done = at > n;
    return (
      <span key={n} className={`${styles.step} ${on ? styles.stepActive : ""} ${done ? styles.stepDone : ""}`}>
        <span className={styles.stepDot}>{done ? "✓" : n}</span>
        {label}
      </span>
    );
  };
  return (
    <div className={styles.steps}>
      {dot(1, "Agent model")}
      <span className={styles.stepRule} aria-hidden="true" />
      {dot(2, "Transcription")}
    </div>
  );
}

export function SetupGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [states, setStates] = useState<{ models?: StepState; transcription?: StepState }>({});

  useEffect(() => {
    let on = true;
    getGlobalSetting("setup")
      .then((v) => on && setPhase(shouldShowSetup(v) ? "wizard" : "hidden"))
      .catch(() => on && setPhase("hidden")); // fail-safe: never block the workbench on the probe
    return () => { on = false; };
  }, []);

  if (phase === "checking") return <div style={{ height: "100dvh", background: "var(--bg)" }} />;
  if (phase === "hidden") return <>{children}</>;

  const advance = (key: "models" | "transcription", state: StepState) => {
    const next = { ...states, [key]: state };
    setStates(next);
    // Persist per-step state as it happens — a mid-wizard reload resumes honestly.
    void setGlobalSetting("setup", { [key]: state }).catch(() => undefined);
    if (key === "models") setStep(2);
    else setStep(3);
  };

  const finish = () => {
    void setGlobalSetting("setup", { completed: "true" }).catch(() => undefined);
    // The admin→user onboarding seam: "Go to Meetings" must actually LAND on Meetings. The
    // workbench's layout store initializes its rail from this persisted key (layout.ts LS_LIST)
    // and it is created only when the workbench mounts — i.e. after this gate unhides — so a
    // plain localStorage write is the whole hand-off.
    try { localStorage.setItem("tina.terminal.activeList.v1", "meetings"); } catch { /* noop */ }
    setPhase("hidden");
  };

  return (
    <div className={styles.setupStage}>
      <section className={styles.setupModal} role="dialog" aria-modal="true" aria-label="Set up your TINA instance">
        <header className={styles.setupHeader}>
          <div className={styles.setupBrand}>
            <img className={styles.setupBrandMark} src="/provider-logos/tina-mark-inverse.svg" alt="" aria-hidden="true" />
            <div>
              <div className={styles.setupBrandName}>TINA</div>
              <div className={styles.setupEyebrow}>Set up your instance</div>
            </div>
          </div>
          {step < 3 && <Steps at={step as 1 | 2} />}
        </header>
        {step === 1 && <ModelsStep onNext={(s) => advance("models", s)} />}
        {step === 2 && <TranscriptionStep onNext={(s) => advance("transcription", s)} />}
        {step === 3 && (
          <div className={styles.stepContent}>
            <div className={styles.successContent}>
              <h1 className={styles.successTitle}>You&rsquo;re set ✓</h1>
              <div className={styles.successSummary}>
                <div style={{ color: states.models === "done" ? "var(--green)" : "var(--t3)" }}>
                  {states.models === "done" ? "✓ Agent model configured and tested" : "○ Agent model skipped — finish it in Settings → Models"}
                </div>
                <div style={{ color: states.transcription === "done" ? "var(--green)" : "var(--t3)" }}>
                  {states.transcription === "done" ? "✓ Transcription configured and tested" : "○ Transcription skipped — finish it in Settings → Models"}
                </div>
              </div>
              <p className={styles.successCopy}>
                Everything a meeting needs is wired up. Next: get a meeting in front of a bot — connect
                your calendar, plan a meeting, or drop a bot on a running Meet.
              </p>
              <div>
                <button style={primaryBtn} onClick={finish}>Go to Meetings</button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
