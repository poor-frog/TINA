import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor, cleanup } from "@testing-library/react";
import { LucianReadAloud, clearReadAloudAudioCache } from "../lucian/LucianReadAloud";

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  preload = "";
  duration = 5;
  currentTime = 0;
  paused = true;
  ended = false;
  private listeners = new Map<string, Set<() => void>>();

  constructor(src = "") {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, cb: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }

  load() {}

  emit(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }

  play = vi.fn(async () => {
    this.paused = false;
    this.ended = false;
    this.emit("loadedmetadata");
  });

  pause = vi.fn(() => {
    this.paused = true;
    this.emit("pause");
  });
}

describe("LucianReadAloud VieNeu playback", () => {
  const originalAudio = globalThis.Audio;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const speechSpeak = vi.fn();

  beforeEach(() => {
    clearReadAloudAudioCache();
    FakeAudio.instances = [];
    speechSpeak.mockReset();
    (globalThis as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio;
    URL.createObjectURL = vi.fn(() => `blob:vieneu-${FakeAudio.instances.length + 1}`);
    URL.revokeObjectURL = vi.fn();
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak: speechSpeak, cancel: vi.fn() },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    (globalThis as unknown as { Audio: typeof Audio }).Audio = originalAudio;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it("never auto-fetches or calls browser speechSynthesis; plays VieNeu WAV on click and caches Blob", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      })
    );

    render(
      <LucianReadAloud
        text="Bạn đã nói về việc cung cấp tính năng linh hoạt."
        audioUrl="/api/meetings/42/voice-assistant/audio/req-1"
        autoPlay={true}
      />
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(speechSpeak).not.toHaveBeenCalled();

    const playBtn = screen.getByRole("button", { name: /^read aloud$/i });
    fireEvent.click(playBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(FakeAudio.instances).toHaveLength(1);
      expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/meetings/42/voice-assistant/audio/req-1",
      expect.objectContaining({ cache: "no-store" })
    );
    expect(speechSpeak).not.toHaveBeenCalled();

    // Pause, unmount, remount same reply → hits browser Blob cache without refetching
    fireEvent.click(screen.getByRole("button", { name: /pause read aloud/i }));
    cleanup();

    render(
      <LucianReadAloud
        text="Bạn đã nói về việc cung cấp tính năng linh hoạt."
        audioUrl="/api/meetings/42/voice-assistant/audio/req-1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^read aloud$/i }));
    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(2);
      expect(FakeAudio.instances[1].play).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pauses an already playing reply when another reply starts playing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      })
    );

    render(
      <div>
        <LucianReadAloud text="Câu trả lời một." audioUrl="/api/meetings/42/voice-assistant/audio/req-a" />
        <LucianReadAloud text="Câu trả lời hai." audioUrl="/api/meetings/42/voice-assistant/audio/req-b" />
      </div>
    );

    const buttons = screen.getAllByRole("button", { name: /^read aloud$/i });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(FakeAudio.instances[0].paused).toBe(false);

    fireEvent.click(buttons[1]);
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
    expect(FakeAudio.instances[1].paused).toBe(false);
  });

  it("shows VieNeu busy error with retry and never falls back to browser speechSynthesis", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "Dịch vụ giọng đọc VieNeu đang bận phục vụ cuộc họp." }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([82, 73, 70, 70, 9, 9, 9, 9]), {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        })
      );

    render(
      <LucianReadAloud
        text="Câu trả lời khi VieNeu đang bận."
        audioUrl="/api/meetings/42/voice-assistant/audio/req-busy"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /^read aloud$/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("VieNeu đang bận");
    });
    expect(speechSpeak).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /thử lại/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(FakeAudio.instances).toHaveLength(1);
      expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
