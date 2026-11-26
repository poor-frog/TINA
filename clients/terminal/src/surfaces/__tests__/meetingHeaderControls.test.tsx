/** Behavioral test for the meeting-header bot control's WS gating (issue #674 C1).
 *
 *  The header state and the control's enabled-ness are a pure function of (row status,
 *  WS-connected): connected+active → Live + enabled "Stop bot"; disconnected → indeterminate
 *  ("Reconnecting…") + DISABLED control — a stale-live snapshot can never present an actionable
 *  "Stop bot"; no active meeting → the send/resend control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { BotControls, meetingHeaderState, meetingWhenLabel } from "../meeting";
import type { MeetingMock } from "../meetingModel";

const NATIVE = "abc-defg-hij";

function row(live_status: string, status: "live" | "past" = live_status === "active" ? "live" : "past"): MeetingMock {
  return {
    id: NATIVE, native_id: NATIVE, title: "Google Meet · " + NATIVE, when: "now",
    status, live_status, platform: "Google Meet", has_recording: false,
    docs: [], participants: [], mentioned: [], actions: [], transcript: [], insights: [],
  } as MeetingMock;
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("meetingHeaderState — pure (row, connected) → header", () => {
  it("does not label a bot still joining or waiting as live", () => {
    for (const status of ["requested", "joining", "awaiting_admission", "needs_help", "stopping"]) {
      expect(meetingHeaderState(row(status, "live"), true)).toBe("pending");
      expect(meetingHeaderState(row(status, "live"), false)).toBe("reconnecting");
    }
  });
  it("connected + live row → live", () => expect(meetingHeaderState(row("active"), true)).toBe("live"));
  it("DISCONNECTED + live row → reconnecting (never a stale Live)", () => expect(meetingHeaderState(row("active"), false)).toBe("reconnecting"));
  it("terminal row → recap (either way)", () => {
    expect(meetingHeaderState(row("completed"), true)).toBe("recap");
    expect(meetingHeaderState(row("completed"), false)).toBe("recap");
  });
  it("unresolved row → connecting", () => expect(meetingHeaderState(undefined, true)).toBe("connecting"));
});

describe("BotControls — enabled-ness follows WS connectivity", () => {
  it("shows the owner's safe join diagnosis on a failed meeting", () => {
    const summary="Google Meet blocked the bot before an admission request could be sent.";
    const {rerender}=render(<BotControls m={{...row('failed'),join_failure_summary:summary}} />);
    expect(screen.getByRole('status').textContent).toBe(summary);
    rerender(<BotControls m={{...row('active'),join_failure_summary:summary}} />);
    expect(screen.queryByText(summary)).toBeNull();
  });
  it("lets the owner cancel a pending automatic retry", async () => {
    render(<BotControls m={{ ...row("failed"), auto_retry: {
      state: "scheduled", attempt: 1, max_attempts: 3,
    } }} connected={true} />);
    expect(screen.queryByRole("button", { name: "Send bot again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel retry" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      `/api/bots/google_meet/${NATIVE}`, { method: "DELETE" },
    ));
  });
  it("connected + active → 'Stop bot' enabled", () => {
    render(<BotControls m={row("active")} connected={true} />);
    const btn = screen.getByRole("button", { name: "Stop bot" });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });
  it("disconnected + (stale) active → 'Stop bot' DISABLED with the reconnect hint", () => {
    render(<BotControls m={row("active")} connected={false} />);
    const btn = screen.getByRole("button", { name: "Stop bot" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute("title")).toMatch(/reconnecting/i);
  });
  it("no active meeting (terminal row) → the send-again control, not Stop", () => {
    render(<BotControls m={row("completed")} connected={true} />);
    expect(screen.queryByRole("button", { name: "Stop bot" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send bot again" })).toBeTruthy();
  });
  it("clicking 'Send bot again' on a failed meeting navigates to the newly created meeting id", async () => {
    const onOpenMeeting = vi.fn();
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === "/api/bots") {
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 28, platform: "google_meet", native_meeting_id: NATIVE, status: "requested" }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ meetings: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;

    render(<BotControls m={{ ...row("failed"), id: "27" }} connected={true} onOpenMeeting={onOpenMeeting} />);
    fireEvent.click(screen.getByRole("button", { name: "Send bot again" }));

    await waitFor(() => expect(onOpenMeeting).toHaveBeenCalledWith("28"));
  });
  it("clicking 'Send bot again' stays on the current meeting and renders an alert when POST /api/bots fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onOpenMeeting = vi.fn();
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === "/api/bots") {
        return {
          ok: false,
          status: 409,
          statusText: "Conflict",
          url: "/api/bots",
          json: async () => ({ detail: "An active or requested meeting already exists" }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ meetings: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;

    render(<BotControls m={{ ...row("failed"), id: "27" }} connected={true} onOpenMeeting={onOpenMeeting} />);
    fireEvent.click(screen.getByRole("button", { name: "Send bot again" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That meeting already has a bot."));
    expect(onOpenMeeting).not.toHaveBeenCalled();
  });
});

describe("recap time — cached live labels never imply the meeting is still running", () => {
  it("retains the live label while the meeting is active", () => {
    expect(meetingWhenLabel({ ...row("active"), when: "Now · live" })).toBe("Now · live");
  });
  it("removes an in-progress placeholder when the meeting has ended without a start time", () => {
    for (const when of ["Bot session in progress", "Now · live", "now"]) {
      expect(meetingWhenLabel({ ...row("stopped"), when })).toBe("");
    }
  });
  it("uses the saved start time when replacing a cached live label", () => {
    const start_time = "2026-11-04T11:00:00Z";
    expect(meetingWhenLabel({ ...row("completed"), when: "Bot session in progress", start_time }))
      .toBe(new Date(start_time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  });
  it("retains an existing date and does not invent one for an invalid timestamp", () => {
    expect(meetingWhenLabel({ ...row("completed"), when: "Nov 4, 6:00 PM" })).toBe("Nov 4, 6:00 PM");
    expect(meetingWhenLabel({ ...row("failed"), when: "Bot session in progress", start_time: "invalid" })).toBe("");
  });
});
