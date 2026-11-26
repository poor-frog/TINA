import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ModelsSection } from "../settings";
import * as api from "../settingsApi";

vi.mock("../settingsApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../settingsApi")>(),
  getGlobalSetting: vi.fn().mockResolvedValue(null), getModelPrefs: vi.fn().mockResolvedValue({}),
  getTranscriptionPrefs: vi.fn(), setTranscriptionPrefs: vi.fn(),
  getAsrRuntime: vi.fn(), setAsrRuntime: vi.fn(), testTranscription: vi.fn(),
}));
type Backend = "viegem";
const saved = (backend: Backend = "viegem") => ({ backend, available_backends: ["viegem"] as Backend[],
  effective: { backend, label: "VieGem + LM", model: "model", source: "user" as const } });
const state = (backend: Backend | null = "viegem", enabled = true): api.AsrRuntime => ({ instance: "fixture",
  account: { backend, enabled, revision: 4 }, counts: { viegem: 1 },
  workers: { viegem: { running: true, ready: true, device: "mps" } }, operation: null });
async function transcription() {
  render(<ModelsSection />);
  fireEvent.click(screen.getByRole("tab", { name: "Transcription" }));
  const panel = within(screen.getByRole("tabpanel", { name: "Transcription" }));
  await waitFor(() => expect((panel.getByRole("radio", { name: "VieGem + LM" }) as HTMLInputElement).disabled).toBe(false));
  return panel;
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTranscriptionPrefs).mockResolvedValue(saved());
  vi.mocked(api.getAsrRuntime).mockResolvedValue(state());
  vi.mocked(api.setAsrRuntime).mockImplementation(async (backend, enabled) => {
    vi.mocked(api.getTranscriptionPrefs).mockResolvedValue(saved(backend));
    vi.mocked(api.getAsrRuntime).mockResolvedValue(state(backend, enabled));
    return state(backend, enabled);
  });
});

describe("compact transcription picker", () => {
  it("selects a model immediately, needs no token or Save, and restores selection", async () => {
    vi.mocked(api.getAsrRuntime).mockResolvedValue(state(null));
    const panel = await transcription();
    expect(panel.queryByRole("button", { name: "Save" })).toBeNull();
    expect(panel.queryByLabelText("Backend")).toBeNull();
    expect(panel.queryByLabelText("Token")).toBeNull();
    expect(screen.queryByLabelText("Current model settings")).toBeNull();
    fireEvent.click(panel.getByRole("radio", { name: "VieGem + LM" }));
    await waitFor(() => expect(api.setAsrRuntime).toHaveBeenCalledWith("viegem", true, 4));
    await waitFor(() => expect((panel.getByRole("radio", { name: "VieGem + LM" }) as HTMLInputElement).checked).toBe(true));
    cleanup();
    const reload = await transcription();
    expect((reload.getByRole("radio", { name: "VieGem + LM" }) as HTMLInputElement).checked).toBe(true);
  });
  it("does not forward a stored custom token when choosing managed ASR", async () => {
    vi.mocked(api.getTranscriptionPrefs).mockResolvedValue({ ...saved(), backend: "custom", url: "https://own.example", token: "********1234" });
    vi.mocked(api.getAsrRuntime).mockResolvedValue(state(null));
    const panel = await transcription();
    fireEvent.click(panel.getByRole("radio", { name: "VieGem + LM" }));
    await waitFor(() => expect(api.setAsrRuntime).toHaveBeenCalledWith("viegem", true, 4));
    expect(api.setTranscriptionPrefs).not.toHaveBeenCalled();
  });
  it("keeps custom credentials editable under Other providers and disables an unavailable model", async () => {
    vi.mocked(api.getTranscriptionPrefs).mockResolvedValue({ backend: "custom", url: "http://host.docker.internal:18005", token: "********1234" });
    render(<ModelsSection />);
    fireEvent.click(screen.getByRole("tab", { name: "Transcription" }));
    const panel = within(screen.getByRole("tabpanel", { name: "Transcription" }));
    expect((panel.getByRole("radio", { name: "VieGem + LM" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(panel.getByText("Other providers"));
    await waitFor(() => expect((panel.getByLabelText("Token") as HTMLInputElement).value).toBe("********1234"));
    expect((panel.getByLabelText("Backend") as HTMLSelectElement).value).toBe("custom");
  });
  it("pauses only this account and distinguishes a shared worker still running", async () => {
    const panel = await transcription();
    fireEvent.click(panel.getByRole("switch", { name: "Transcription for my account" }));
    await waitFor(() => expect(api.setAsrRuntime).toHaveBeenCalledWith("viegem", false, 4));
    await waitFor(() => expect(panel.getByText("Paused for your account. Existing sessions can finish.")).toBeTruthy());
    expect(panel.getByText(/A shared model stays on/)).toBeTruthy();
    expect(panel.getByText("Running")).toBeTruthy();
    expect(panel.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });
  it("preserves selection and retains an action error if startup fails", async () => {
    vi.mocked(api.setAsrRuntime).mockRejectedValue(new Error("ASR audio probe failed"));
    vi.mocked(api.getAsrRuntime).mockResolvedValue(state("viegem", false));
    const panel = await transcription();
    fireEvent.click(panel.getByRole("radio", { name: "VieGem + LM" }));
    await waitFor(() => expect(panel.getByRole("alert")).toBeTruthy());
    expect((panel.getByRole("radio", { name: "VieGem + LM" }) as HTMLInputElement).checked).toBe(true);
  });
  it("can resume a paused account by clicking its selected model", async () => {
    vi.mocked(api.getAsrRuntime).mockResolvedValue(state("viegem", false));
    const panel = await transcription();
    fireEvent.click(panel.getByRole("radio", { name: "VieGem + LM" }));
    await waitFor(() => expect(api.setAsrRuntime).toHaveBeenCalledWith("viegem", true, 4));
  });
  it("clears a previous connection result when pausing the selected model", async () => {
    vi.mocked(api.testTranscription).mockResolvedValue({ ok: true, summary: "OK" });
    const panel = await transcription();
    fireEvent.click(panel.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(panel.getByText("Connection verified. Your model is ready.")).toBeTruthy());
    fireEvent.click(panel.getByRole("switch", { name: "Transcription for my account" }));
    await waitFor(() => expect(api.setAsrRuntime).toHaveBeenCalled());
    await waitFor(() => expect(panel.queryByText("Connection verified. Your model is ready.")).toBeNull());
  });
  it("restores focus to the chosen radio after asynchronous startup", async () => {
    let finish!: (value: api.AsrRuntime) => void;
    vi.mocked(api.setAsrRuntime).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(api.getAsrRuntime).mockResolvedValue(state(null));
    const panel = await transcription();
    const radio = panel.getByRole("radio", { name: "VieGem + LM" });
    radio.focus(); fireEvent.click(radio);
    await waitFor(() => expect(api.setAsrRuntime).toHaveBeenCalled());
    radio.blur(); // Browsers blur a focused radio while its fieldset is disabled.
    finish(state());
    await waitFor(() => expect(document.activeElement).toBe(radio));
    expect(radio.getAttribute("aria-describedby")).toBe("asr-viegem-detail asr-viegem-state");
  });
});
