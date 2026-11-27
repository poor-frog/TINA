import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EmailNotificationsCard } from "../EmailNotificationsCard";

describe("EmailNotificationsCard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads current settings and toggles mail_minutes via PUT /api/person-settings", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/person-settings");
      if (init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({ mail_minutes: false });
        return new Response(JSON.stringify({ mail_minutes: false, mail_rsvp: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ mail_minutes: true, mail_rsvp: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<EmailNotificationsCard email="lethanhquang094@gmail.com" />);

    const summarySwitch = await screen.findByRole("switch", { name: "Post-meeting summary email" });
    const rsvpSwitch = screen.getByRole("switch", { name: "Calendar invite RSVP" });

    await waitFor(() => {
      expect(summarySwitch.getAttribute("aria-checked")).toBe("true");
      expect(rsvpSwitch.getAttribute("aria-checked")).toBe("false");
      expect((summarySwitch as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(summarySwitch);

    await waitFor(() => {
      expect(summarySwitch.getAttribute("aria-checked")).toBe("false");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rolls back optimistic state and displays an alert if saving fails", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ error: "admin-api unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({ mail_minutes: true, mail_rsvp: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<EmailNotificationsCard email="lethanhquang094@gmail.com" />);

    const summarySwitch = await screen.findByRole("switch", { name: "Post-meeting summary email" });
    await waitFor(() => expect((summarySwitch as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(summarySwitch);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("admin-api unavailable");
      expect(summarySwitch.getAttribute("aria-checked")).toBe("true");
    });
  });
});
