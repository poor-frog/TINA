import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TranscriptReview } from "../TranscriptReview";

const segment = { segment_id: "s/1", speaker: "You", raw_text: "API thứ sáu", normalized_text: "API thứ sáu", text: "API thứ sáu", revision: 0, history: [] };
const response = (revision = 0) => ({ status: "completed", segments: [{ ...segment, revision, text: revision ? "API thứ Sáu." : segment.text, history: revision ? [{ revision, text: "API thứ Sáu.", at: "2026-10-20T00:00:00Z" }] : [] }] });
const fetchMock = vi.fn();
const mediaReadyState = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "readyState");
const mediaCurrentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
const mediaPlay = HTMLMediaElement.prototype.play;
const mediaPause = HTMLMediaElement.prototype.pause;
const mediaLoad = HTMLMediaElement.prototype.load;
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith('/refinement') ? null : response() }));
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();
  if (mediaReadyState) Object.defineProperty(HTMLMediaElement.prototype, "readyState", mediaReadyState);
  if (mediaCurrentTime) Object.defineProperty(HTMLMediaElement.prototype, "currentTime", mediaCurrentTime);
  HTMLMediaElement.prototype.play = mediaPlay;
  HTMLMediaElement.prototype.pause = mediaPause;
  HTMLMediaElement.prototype.load = mediaLoad;
});

describe("transcript review", () => {
  it("preserves the selected draft and collapses 100 background notifications into one reload", async () => {
    const doc = { status: "completed", segments: [segment, { ...segment, segment_id: "second", text: "second", raw_text: "second" }] };
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith("/document") ? doc : url.endsWith("/alignment") ? { job: null, available: false } : null }));
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    await screen.findByLabelText(/Corrected transcript/);
    fireEvent.change(screen.getByLabelText("Segment"), { target: { value: "second" } });
    fireEvent.change(screen.getByLabelText(/Corrected transcript/), { target: { value: "unsaved draft" } });
    fetchMock.mockClear();
    act(() => { for (let i = 0; i < 100; i++) window.dispatchEvent(new CustomEvent("tina:transcript-corrected", { detail: { meetingId: "42" } })); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Segment")).toHaveProperty("value", "second");
    expect(screen.getByLabelText(/Corrected transcript/)).toHaveProperty("value", "unsaved draft");
  });

  it("keeps the draft's base revision until a conflicting remote edit is explicitly reviewed", async () => {
    let doc = response();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const payload = JSON.parse(init.body as string);
        expect(payload.expected_revision).toBe(doc.segments[0].revision);
        doc = { ...doc, segments: [{ ...doc.segments[0], revision: 2, text: payload.text }] };
      }
      const body = url.endsWith("/refinement") ? null : url.endsWith("/alignment") ? { job: null, available: false } : doc;
      return { ok: true, json: async () => body };
    });
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    await screen.findByLabelText(/Corrected transcript/);
    fireEvent.change(screen.getByLabelText(/Corrected transcript/), { target: { value: "draft from revision zero" } });
    doc = { ...response(1), segments: [{ ...response(1).segments[0], text: "remote edit" }] };
    act(() => window.dispatchEvent(new CustomEvent("tina:transcript-corrected", { detail: { meetingId: "42" } })));
    await screen.findByText("This segment changed elsewhere. Your draft is kept.");
    expect(screen.getByLabelText("Corrected transcript · revision 0")).toHaveProperty("value", "draft from revision zero");
    expect(screen.getByText("Save revision")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByText("Save revision"));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByText("Discard draft and use latest"));
    expect(screen.getByLabelText("Corrected transcript · revision 1")).toHaveProperty("value", "remote edit");
    fireEvent.change(screen.getByLabelText(/Corrected transcript/), { target: { value: "reviewed edit" } });
    fireEvent.click(screen.getByText("Save revision"));
    await screen.findByLabelText("Corrected transcript · revision 2");
    const payload = JSON.parse(fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body);
    expect(payload).toEqual({ expected_revision: 1, text: "reviewed edit" });
  });

  it("allows one in-flight reload and one follow-up for notifications arriving during the request", async () => {
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    await screen.findByLabelText(/Corrected transcript/);
    vi.useFakeTimers();
    let release!: (doc: ReturnType<typeof response>) => void;
    let first = true, current = 0, maximum = 0;
    fetchMock.mockClear().mockImplementation(async (url: string) => {
      if (url.endsWith("/document")) {
        current++; maximum = Math.max(maximum, current);
        return { ok: true, json: async () => {
          const doc = first ? (first = false, await new Promise<ReturnType<typeof response>>(done => { release = done; })) : response();
          current--; return doc;
        } };
      }
      return { ok: true, json: async () => url.endsWith("/alignment") ? { job: null, available: false } : null };
    });
    const notify = () => window.dispatchEvent(new CustomEvent("tina:transcript-corrected", { detail: { meetingId: "42" } }));
    await act(async () => { notify(); await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { for (let i = 0; i < 100; i++) notify(); await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { release(response()); });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(maximum).toBe(1);
  });

  it("keeps editing locked until Save finishes even when a background reload finishes first", async () => {
    let release!: (doc: ReturnType<typeof response>) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return { ok: true, json: () => new Promise(done => { release = done; }) };
      return { ok: true, json: async () => url.endsWith("/refinement") ? null : url.endsWith("/alignment") ? { job: null, available: false } : response() };
    });
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    await screen.findByLabelText(/Corrected transcript/);
    fireEvent.change(screen.getByLabelText(/Corrected transcript/), { target: { value: "saved draft" } });
    fireEvent.click(screen.getByText("Save revision"));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    vi.useFakeTimers();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tina:transcript-corrected", { detail: { meetingId: "42" } }));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByLabelText(/Corrected transcript/)).toHaveProperty("disabled", true);
    expect(screen.getByText("Save revision")).toHaveProperty("disabled", true);
    await act(async () => { release(response(1)); });
    expect(screen.getByLabelText(/Corrected transcript/)).toHaveProperty("disabled", false);
  });

  it("retries a queued update after a network error, waiting for the other requests to settle", async () => {
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    await screen.findByLabelText(/Corrected transcript/);
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    let releaseAlignment!: (view: object) => void;
    let documents = 0, alignments = 0;
    fetchMock.mockClear().mockImplementation(async (url: string) => {
      if (url.endsWith("/document")) {
        documents++;
        return { ok: true, json: () => documents === 1 ? new Promise((_done, fail) => { reject = fail; }) : Promise.resolve(response(1)) };
      }
      if (url.endsWith("/alignment")) {
        alignments++;
        return { ok: true, json: () => alignments === 1 ? new Promise(done => { releaseAlignment = done; }) : Promise.resolve({ job: null, available: false }) };
      }
      return { ok: true, json: async () => null };
    });
    const notify = () => window.dispatchEvent(new CustomEvent("tina:transcript-corrected", { detail: { meetingId: "42" } }));
    await act(async () => { notify(); await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { notify(); await vi.advanceTimersByTimeAsync(100); reject(new Error("Temporary network error")); });
    expect(documents).toBe(1);
    await act(async () => { releaseAlignment({ job: null, available: false }); });
    expect(documents).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(screen.getByLabelText("Corrected transcript · revision 1")).toHaveProperty("value", "API thứ Sáu.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops retrying after two failed reloads even when more updates are queued", async () => {
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    await screen.findByLabelText(/Corrected transcript/);
    vi.useFakeTimers();
    const rejects: Array<(reason: Error) => void> = [];
    fetchMock.mockClear().mockImplementation(async (url: string) => ({ ok: true, json: () => url.endsWith("/document")
      ? new Promise((_done, fail) => { rejects.push(fail); }) : Promise.resolve(url.endsWith("/alignment") ? { job: null, available: false } : null) }));
    const notify = () => window.dispatchEvent(new CustomEvent("tina:transcript-corrected", { detail: { meetingId: "42" } }));
    await act(async () => { notify(); await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { notify(); await vi.advanceTimersByTimeAsync(100); rejects[0](new Error("Offline")); });
    expect(rejects).toHaveLength(2);
    await act(async () => { notify(); await vi.advanceTimersByTimeAsync(100); rejects[1](new Error("Offline")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(rejects).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(screen.getByRole("alert").textContent).toContain("Offline");
    expect(screen.getByText("Reload")).toHaveProperty("disabled", false);
  });

  it("preserves original text, sends expected revision and requests a view refresh", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => response() });
    const event = vi.fn(); window.addEventListener("tina:transcript-corrected", event);
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    await screen.findByLabelText("Original transcript");
    expect(screen.getByLabelText("Original transcript")).toHaveProperty("readOnly", true);
    fireEvent.change(screen.getByLabelText(/Corrected transcript/), { target: { value: "API thứ Sáu." } });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => response(1) });
    fireEvent.click(screen.getByText("Save revision"));
    await waitFor(() => expect(event).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls.find(([, options]) => options?.method === "PATCH")!;
    expect(url).toBe("/api/transcripts/by-id/42/segments/s%2F1");
    expect(JSON.parse(init.body)).toEqual({ expected_revision: 0, text: "API thứ Sáu." });
    expect((screen.getByLabelText("Original transcript") as HTMLTextAreaElement).value).toBe("API thứ sáu");
    window.removeEventListener("tina:transcript-corrected", event);
  });
  it("shows revision conflicts and keeps the unsaved correction", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => response() });
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    await screen.findByLabelText("Original transcript");
    fireEvent.change(screen.getByLabelText(/Corrected transcript/), { target: { value: "my correction" } });
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ detail: "Transcript changed; reload before saving" }) });
    fireEvent.click(screen.getByText("Save revision"));
    expect((await screen.findByRole("alert")).textContent).toContain("Transcript changed");
    expect((screen.getByLabelText(/Corrected transcript/) as HTMLTextAreaElement).value).toBe("my correction");
  });
});


describe("refinement review", () => {
  it("shows word changes with audio, filters unchanged segments, applies and restores", async () => {
    let revision = 0, applied = false;
    const job = () => ({ id: "job", status: "completed", model: "custom", backend: "funasr", items: [
      { segment_id: "s/1", expected_revision: 0, state: applied ? "applied" : "ready", text: "API thứ Sáu." },
      { segment_id: "s2", expected_revision: 0, state: "ready", text: "unchanged" }] });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/refinement')) return { ok: true, json: async () => job() };
      if (url.endsWith('/refinement/apply')) { revision = 1; applied = true; }
      if (init?.method === 'PATCH') revision = 2;
      return { ok: true, json: async () => ({ ...response(revision), segments: [
        { ...response(revision).segments[0], audio: [{ kind: 'recording-span' }], text: revision === 2 ? segment.text : response(revision).segments[0].text },
        { ...segment, segment_id: 's2', text: 'unchanged', raw_text: 'unchanged', audio: [] }] }) };
    });
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole('button', { name: 'Review transcript' }));
    await screen.findByLabelText('Suggested changes');
    expect(screen.getByLabelText('Suggested changes').querySelector('ins')?.textContent).toContain('Sáu.');
    expect(screen.getByLabelText('Suggested changes').querySelector('del')?.textContent).toContain('sáu');
    expect(screen.getByLabelText('Segment audio').getAttribute('src')).toContain('/s%2F1/audio');
    fireEvent.click(screen.getByLabelText('Only changed segments'));
    expect(screen.queryByRole('option', { name: /unchanged/ })).toBeNull();
    fireEvent.click(screen.getByText('Apply refinement'));
    await waitFor(() => expect(screen.getByLabelText(/Corrected transcript/)).toHaveProperty('value', 'API thứ Sáu.'));
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/refinement/apply') && JSON.parse(init.body).expected_revision === 0)).toBe(true);
    fireEvent.click(screen.getByText('Restore original'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH' && JSON.parse(init.body).text === null)).toBe(true));
  });
});

describe("aligned word playback", () => {
  function playback(ready = 1) {
    let clock = 0, hash = "a".repeat(64);
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => ready });
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { configurable: true, get: () => clock, set: (value: number) => { clock = value; } });
    HTMLMediaElement.prototype.play = play as unknown as typeof HTMLMediaElement.prototype.play;
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith("/refinement") ? null : url.endsWith("/alignment") ? {
      available: true, job: { id: "alignment", status: "completed", model: "mfa", items: [{ segment_id: "s/1", state: "aligned", expected_revision: 0, audio_sha256: hash,
        words: [{ index: 0, text: "API", start_ms: 100, end_ms: 300, aligned: true }],
        phrases: [{ speaker_id: null, speaker_name: "Speaker", text: "API", word_indices: [0] }],
      }] },
    } : { status: "completed", segments: [{ ...segment, text: "API", raw_text: "API", audio: [{ kind: "recording-span" }] },
      { ...segment, segment_id: "second", text: "second", raw_text: "second", audio: [{ kind: "recording-span" }] }] } }));
    return { play, clock: (value: number) => { clock = value; }, replaceSource: () => { hash = "b".repeat(64); } };
  }

  it.each(["segment", "recording"])("clears a word boundary when the %s changes", async mode => {
    const audio = playback();
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    fireEvent.click(await screen.findByRole("button", { name: "Play API from 100 to 300 milliseconds" }));
    if (mode === "segment") fireEvent.change(screen.getByLabelText("Segment"), { target: { value: "second" } });
    else {
      audio.replaceSource(); vi.useFakeTimers();
      await act(async () => { window.dispatchEvent(new CustomEvent("tina:transcript-corrected", { detail: { meetingId: "42" } })); await vi.advanceTimersByTimeAsync(100); });
    }
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
    audio.clock(1);
    fireEvent.timeUpdate(screen.getByLabelText("Segment audio"));
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  });

  it.each(["segment", "close", "current"])("only plays a pending word while its source is current: %s", async mode => {
    const audio = playback(0);
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    fireEvent.click(await screen.findByRole("button", { name: "Play API from 100 to 300 milliseconds" }));
    const source = screen.getByLabelText("Segment audio");
    if (mode === "segment") fireEvent.change(screen.getByLabelText("Segment"), { target: { value: "second" } });
    if (mode === "close") fireEvent(screen.getByRole("dialog"), new Event("close"));
    fireEvent.loadedMetadata(source);
    expect(audio.play).toHaveBeenCalledTimes(mode === "current" ? 1 : 0);
  });

  it.each(["stale", "current"])("handles rejected playback without leaking errors from an old source: %s", async mode => {
    const audio = playback();
    let reject!: (reason: Error) => void;
    audio.play.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    fireEvent.click(await screen.findByRole("button", { name: "Play API from 100 to 300 milliseconds" }));
    if (mode === "stale") fireEvent.change(screen.getByLabelText("Segment"), { target: { value: "second" } });
    await act(async () => { reject(new Error("Playback interrupted")); });
    if (mode === "stale") expect(screen.queryByRole("alert")).toBeNull();
    else expect(screen.getByRole("alert").textContent).toContain("Could not play saved audio");
  });

  it("plays the aligned word range and leaves an OOV token unclickable", async () => {
    const currentTime = vi.fn();
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 1 });
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { configurable: true, get: () => 0, set: currentTime });
    HTMLMediaElement.prototype.play = play as unknown as typeof HTMLMediaElement.prototype.play;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/refinement")) return { ok: true, json: async () => null };
      if (url.endsWith("/alignment")) return { ok: true, json: async () => ({ version: "transcript-alignment.v1", available: true, job: {
        id: "job", status: "completed", model: "mfa-vi", items: [{ segment_id: "s/1", state: "aligned", expected_revision: 0,
          audio_sha256: "b".repeat(64), words: [
            { index: 0, text: "API", start_ms: 100, end_ms: 300, aligned: true, speaker_name: "Speaker 1", speaker_id: "speaker-1" },
            { index: 1, text: "hormone,", start_ms: null, end_ms: null, aligned: false, speaker_name: "Unknown speaker", speaker_id: null },
          ], phrases: [{ speaker_id: null, speaker_name: "Speaker 1", text: "API hormone,", start_ms: 100, end_ms: 300, word_indices: [0, 1] }],
        }],
      } }) };
      return { ok: true, json: async () => ({ ...response(), segments: [{ ...response().segments[0], audio: [{ kind: "recording-span" }] }] }) };
    });
    render(<TranscriptReview meetingId="42" />);
    fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
    const apiWord = await screen.findByRole("button", { name: "Play API from 100 to 300 milliseconds" });
    expect(screen.getByText("hormone,").getAttribute("title")).toBe("No reliable word timestamp");
    fireEvent.click(apiWord);
    expect(currentTime).toHaveBeenCalledWith(0.1);
    expect(play).toHaveBeenCalledTimes(1);
  });
});


it("checks audio without ASR and filters quality flags by current revision", async () => {
  const doc = { status: "completed", segments: [{ ...segment, audio: [{ kind: "recording-span" }] }] };
  const job = { id: "quality", status: "completed", model: "", backend: "audio-check", items: [{ segment_id: "s/1", expected_revision: 0, state: "checked", quality: { needs_review: true, reasons: ["low_volume"] } }] };
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => {
    if (url.endsWith("/refinement/start")) { expect(JSON.parse(init!.body as string).mode).toBe("check"); return job; }
    return url.endsWith("/document") ? doc : url.endsWith("/alignment") ? { available: false, job: null } : null;
  } }));
  render(<TranscriptReview meetingId="42" />);
  fireEvent.click(screen.getByRole("button", { name: "Review transcript" }));
  await screen.findByLabelText(/Corrected transcript/);
  fireEvent.click(screen.getByRole("button", { name: "Check audio" }));
  await screen.findByText("Needs review: Low volume");
  fireEvent.click(screen.getByLabelText("Only segments needing review"));
  expect(screen.getByRole("option", { name: /Review/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Apply refinement" })).toBeNull();
});
