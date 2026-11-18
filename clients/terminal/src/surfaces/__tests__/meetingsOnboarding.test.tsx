/** Meetings user onboarding (frames 4–5): the three-path empty state, the STANDING slim
 *  calendar card (state-driven — exists exactly while no calendar is connected), and the
 *  Google Calendar OAuth entry point. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { signIn } from "next-auth/react";

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

vi.mock("../../platform", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useService: () => ({ openTab: vi.fn() }),
}));

import { MeetingsOnboarding, connectOutcome } from "../meetingsOnboarding";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function stubCalendarApi(opts: { connected: boolean; linkError?: string }) {
  const calls: { url: string; method?: string; body?: string }[] = [];
  const CAL = { id: "cal-1", name: "My calendar", ics_url_set: true, ics_url_masked: "calendar.google.com/…d3f1", auto_join: true, bot_name: "TINA", enabled: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method, body: init?.body as string });
      if (u === "/api/auth/google-calendar-link") {
        return opts.linkError
          ? Response.json({ error: opts.linkError }, { status: 503 })
          : Response.json({});
      }
      if (u.includes("/api/user/calendars")) {
        if (init?.method === "POST") return new Response(JSON.stringify(CAL), { status: 201 });
        return new Response(JSON.stringify({ calendars: opts.connected ? [CAL] : [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );
  return calls;
}

describe("connectOutcome", () => {
  it("sync error → loud", () => {
    const o = connectOutcome({ last_error: "HTTP 401 — that looks like the public address" });
    expect(o.ok).toBe(false);
    expect(o.text).toContain("HTTP 401");
  });
  it("counts → 'N upcoming meetings imported'", () => {
    expect(connectOutcome({ counts: { created: 11, updated: 1 } }).text).toContain("12 upcoming meetings imported");
    expect(connectOutcome({ counts: { created: 1 } }).text).toContain("1 upcoming meeting imported");
  });
  it("zero found → honest, not silent", () => {
    expect(connectOutcome({ counts: {} }).text).toMatch(/no upcoming meetings with joinable links/i);
  });
});

describe("slim — the standing affordances on a populated Meetings page", () => {
  it("sends a bare Meet code as an HTTPS destination through the existing Bot API", async () => {
    const calls = stubCalendarApi({ connected: true });
    render(<MeetingsOnboarding variant="slim" />);
    fireEvent.change(screen.getByPlaceholderText(/Paste a meeting link/), { target: { value: "abc-defg-hij" } });
    fireEvent.click(screen.getByRole("button", { name: "Send bot" }));
    await waitFor(() => expect(calls.some(call => call.url === "/api/bots" && call.method === "POST")).toBe(true));
    const request = calls.find(call => call.url === "/api/bots" && call.method === "POST")!;
    expect(JSON.parse(request.body!)).toEqual({ platform: "google_meet", native_meeting_id: "abc-defg-hij", meeting_url: "https://meet.google.com/abc-defg-hij" });
  });

  it("calendar card renders while NO calendar is connected", async () => {
    stubCalendarApi({ connected: false });
    render(<MeetingsOnboarding variant="slim" />);
    await waitFor(() => expect(screen.getByText(/No calendar connected/)).toBeTruthy());
  });

  it("calendar card disappears once connected — plan + drop-bot STAY", async () => {
    const calls = stubCalendarApi({ connected: true });
    const { container } = render(<MeetingsOnboarding variant="slim" />);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/user/calendars"))).toBe(true));
    expect(container.textContent).not.toContain("No calendar connected");
    expect(screen.getByRole("button", { name: "Plan a meeting" })).toBeTruthy();
    expect(screen.getByPlaceholderText(/Paste a meeting link/)).toBeTruthy();
  });

  it("plan + drop-bot are there in the disconnected state too", async () => {
    stubCalendarApi({ connected: false });
    render(<MeetingsOnboarding variant="slim" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Plan a meeting" })).toBeTruthy());
    expect(screen.getByPlaceholderText(/Paste a meeting link/)).toBeTruthy();
  });
});

describe("full — the three-path empty state", () => {
  it("shows all three paths, calendar first, when nothing is connected", async () => {
    stubCalendarApi({ connected: false });
    render(<MeetingsOnboarding variant="full" />);
    await waitFor(() => expect(screen.getByText("Connect your calendar")).toBeTruthy());
    expect(screen.getByText("Plan a meeting")).toBeTruthy();
    expect(screen.getByText("Drop a bot in now")).toBeTruthy();
  });

  it("calendar card retires once connected; plan/drop remain", async () => {
    const calls = stubCalendarApi({ connected: true });
    render(<MeetingsOnboarding variant="full" />);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/user/calendars"))).toBe(true));
    await waitFor(() => expect(screen.getByText(/Calendar connected/)).toBeTruthy());
    expect(screen.queryByText("Connect your calendar")).toBeNull();
    expect(screen.getByText("Plan a meeting")).toBeTruthy();
  });
});

describe("Google Calendar onboarding", () => {
  it("prepares the link and starts read-only OAuth with a settings return URL", async () => {
    const calls = stubCalendarApi({ connected: false });
    render(<MeetingsOnboarding variant="slim" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google Calendar" }));

    await waitFor(() => expect(signIn).toHaveBeenCalledOnce());
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/auth/google-calendar-link"]);
    const [provider, options, params] = vi.mocked(signIn).mock.calls[0];
    expect(provider).toBe("google-calendar");
    expect(new URL(options!.callbackUrl!).searchParams.get("tina-calendar-settings")).toBe("google-linked");
    expect(params).toMatchObject({
      access_type: "offline",
      scope: "openid email profile https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly",
    });
  });

  it("shows a failed link preparation without redirecting to Google", async () => {
    stubCalendarApi({ connected: false, linkError: "Google Calendar connection is unavailable" });
    render(<MeetingsOnboarding variant="slim" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google Calendar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Google Calendar connection is unavailable");
    expect(signIn).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Connect Google Calendar" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
