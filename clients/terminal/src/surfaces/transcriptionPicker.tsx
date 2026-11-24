"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui-kit";
import { presentError } from "./apiClient";
import { testTranscription, type AsrRuntime, type ConfigTestResult } from "./settingsApi";
import styles from "./transcriptionPicker.module.css";

type Backend = "viegem";
const MODELS: Array<{ id: Backend; name: string; detail: string }> = [
  { id: "viegem", name: "VieGem + LM", detail: "KenLM · FSMN-VAD" },
];

export function TranscriptionPicker({ runtime, available, busy, target, error, unavailable, onChange }: {
  runtime: AsrRuntime | null;
  available: string[];
  busy: boolean;
  target: Backend | null;
  error: string;
  unavailable: boolean;
  onChange: (backend: Backend, enabled: boolean) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConfigTestResult | null>(null);
  const [testError, setTestError] = useState("");
  const focusAfterUpdate = useRef<HTMLElement | null>(null);
  const selected = runtime?.account.backend;
  const enabled = !!runtime?.account.enabled && !!selected;
  const updating = busy || !!runtime?.operation;
  useEffect(() => {
    if (!updating && focusAfterUpdate.current) {
      if (document.activeElement === document.body) focusAfterUpdate.current.focus();
      focusAfterUpdate.current = null;
    }
  }, [updating]);
  const shared = MODELS.some(({ id }) => runtime?.workers[id].running
    && runtime.counts[id] > (selected === id && enabled ? 1 : 0));
  useEffect(() => { setResult(null); setTestError(""); }, [selected, enabled]);
  const test = async () => {
    setTesting(true); setResult(null); setTestError("");
    try { setResult(await testTranscription()); }
    catch (error) { setTestError(presentError(error).headline); }
    finally { setTesting(false); }
  };
  return <section className={styles.picker} aria-label="Transcription model">
    <div className={styles.header}>
      <div><h2>Speech to text</h2><p>Choose a model for your next session.</p></div>
      <div className={styles.power}>
        <span aria-live="polite">{updating ? "Updating…" : !runtime ? "Loading…" : !selected ? "Other provider" : enabled ? "On" : "Off"}</span>
        {(!runtime || selected) && <button type="button" role="switch" aria-label="Transcription for my account" aria-checked={enabled}
          title={selected ? "Enable or pause transcription for your account" : "Choose a model to enable transcription"}
          disabled={!selected || updating || testing || unavailable} className={styles.toggle}
          onClick={event => { focusAfterUpdate.current = event.currentTarget; if (selected) onChange(selected, !enabled); }}><span /></button>}
      </div>
    </div>
    <fieldset className={styles.models} disabled={!runtime || unavailable || updating || testing} aria-busy={updating}>
      <legend className={styles.srOnly}>Transcription model</legend>
      {MODELS.map(({ id, name, detail }) => {
        const worker = runtime?.workers[id];
        const active = selected === id;
        const configured = available.includes(id);
        const pending = updating && (target || runtime?.operation?.backend) === id;
        const state = !configured ? "Not configured" : pending ? "Updating…" : !worker ? "Loading…"
          : worker.draining ? "Stopping…" : worker.running ? worker.ready ? "Running" : "Starting…" : "Stopped";
        return <label key={id} className={styles.model} data-selected={active} data-available={configured}>
          <input type="radio" name="transcription-model" value={id} aria-label={name} checked={active}
            aria-describedby={`asr-${id}-detail asr-${id}-state`}
            disabled={!configured} onChange={event => { focusAfterUpdate.current = event.currentTarget; onChange(id, true); }}
            onClick={event => { if (active && !enabled) { focusAfterUpdate.current = event.currentTarget; onChange(id, true); } }} />
          <span className={styles.selection} aria-hidden="true">{active && <Icon name="check" size={12} />}</span>
          <span className={styles.description}>
            <span className={styles.modelName}>{name}{active && <span className={styles.selected}>Selected</span>}</span>
            <span id={`asr-${id}-detail`} className={styles.detail}>{detail}{worker?.device && <><span aria-hidden="true"> · </span><span className={styles.device}>{worker.device.toUpperCase()}</span></>}</span>
          </span>
          <span id={`asr-${id}-state`} className={styles.state} data-running={!!worker?.ready}><span aria-hidden="true" />{state}</span>
        </label>;
      })}
    </fieldset>
    <div className={styles.footer}>
      <p>{shared ? "A shared model stays on while another account needs it." : "Unused models stop automatically."}</p>
      <button type="button" className={styles.test} disabled={!enabled || !runtime?.workers[selected!]?.ready || updating || testing || unavailable}
        onClick={() => void test()}><Icon name="refresh" size={13} />{testing ? "Testing…" : "Test connection"}</button>
    </div>
    {(!enabled && runtime && selected) && <p className={styles.note}>Paused for your account. Existing sessions can finish.</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {runtime?.last_error && <p role="alert" className={styles.error}>{runtime.last_error}</p>}
    {testError && <p role="alert" className={styles.error}>{testError}</p>}
    {result && <p role="status" className={result.ok ? styles.success : styles.error}>
      {result.ok ? "Connection verified. Your model is ready." : result.summary}
    </p>}
  </section>;
}
