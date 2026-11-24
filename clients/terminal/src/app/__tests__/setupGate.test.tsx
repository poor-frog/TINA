/** SetupGate — the admin first-run wizard's gating behavior. The wizard must show ONLY to an
 *  admin on an instance whose setup is incomplete; everyone else falls straight through to the
 *  workbench (children). The probe is /api/admin/settings/setup — 404 (non-admin) → null. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import { SetupGate, shouldShowSetup } from "../SetupGate";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubSetupProbe(response: { status: number; value?: Record<string, string> }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/admin/settings/setup")) {
        if (response.status === 404) return new Response(null, { status: 404 });
        return new Response(JSON.stringify({ key: "setup", value: response.value ?? {} }), { status: 200 });
      }
      // the wizard's mount-time model detection — irrelevant to gating, keep it quiet
      return new Response(JSON.stringify({ ok: false, summary: "stub" }), { status: 200 });
    }),
  );
}

describe("shouldShowSetup", () => {
  it("null (non-admin probe 404) → hidden", () => expect(shouldShowSetup(null)).toBe(false));
  it("completed → hidden", () => expect(shouldShowSetup({ completed: "true" })).toBe(false));
  it("fresh / partial → shown", () => {
    expect(shouldShowSetup({})).toBe(true);
    expect(shouldShowSetup({ models: "done" })).toBe(true);
  });
});

describe("SetupGate", () => {
  it("non-admin falls through to the workbench", async () => {
    stubSetupProbe({ status: 404 });
    render(<SetupGate><div data-testid="workbench" /></SetupGate>);
    await waitFor(() => expect(screen.getByTestId("workbench")).toBeTruthy());
  });

  it("completed instance falls through", async () => {
    stubSetupProbe({ status: 200, value: { completed: "true" } });
    render(<SetupGate><div data-testid="workbench" /></SetupGate>);
    await waitFor(() => expect(screen.getByTestId("workbench")).toBeTruthy());
  });

  it("admin on a fresh instance gets the wizard, not the workbench", async () => {
    stubSetupProbe({ status: 200, value: {} });
    render(<SetupGate><div data-testid="workbench" /></SetupGate>);
    await waitFor(() => expect(screen.getByText("How should the agent think?")).toBeTruthy());
    expect(screen.queryByTestId("workbench")).toBeNull();
  });

  it("requires the Antigravity warning acknowledgment before saving and continuing", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/admin/settings/setup")) {
        return new Response(JSON.stringify({ key: "setup", value: {} }), { status: 200 });
      }
      if (String(url).includes("/api/admin/settings/models") && init?.method === "PUT") {
        return new Response(JSON.stringify({ key: "models", value: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, summary: "stub" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupGate><div data-testid="workbench" /></SetupGate>);

    await screen.findByText("How should the agent think?");
    fireEvent.click(screen.getByRole("radio", { name: /Google Antigravity CLI/ }));
    expect(screen.getByRole("alert")).toBeTruthy();
    const acknowledge = screen.getByRole("checkbox");
    const save = screen.getByRole("button", { name: "Save provider" });
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(acknowledge);
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(save.textContent).toBe("Saved"));
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/models", expect.objectContaining({
      method: "PUT",
      body: expect.stringContaining('"antigravity_terms_acknowledged":"true"'),
    }));
    expect((continueButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("probe failure fails SAFE — workbench renders", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    render(<SetupGate><div data-testid="workbench" /></SetupGate>);
    await waitFor(() => expect(screen.getByTestId("workbench")).toBeTruthy());
  });

  it.each([
    ["groq", "Groq"], ["deepseek", "DeepSeek"], ["gemini", "Gemini"],
  ])("saves a %s key with the server default model and tests before continuing", async (mode, label) => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/admin/settings/setup")) {
        return Response.json({ key: "setup", value: {} });
      }
      if (String(url).includes("/api/admin/settings/models") && init?.method === "PUT") {
        return Response.json({ key: "models", value: { mode } });
      }
      return Response.json({ ok: false, summary: "No model connected" });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupGate><div data-testid="workbench" /></SetupGate>);

    await screen.findByText("How should the agent think?");
    fireEvent.click(screen.getByRole("radio", { name: `${label} API key` }));
    const save = screen.getByRole("button", { name: "Save & test" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(`${label} API key`), { target: { value: "synthetic-provider-key" } });
    fireEvent.click(save);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/models", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ mode, api_key: "synthetic-provider-key", model: "", effort: "" }),
    })));
    await waitFor(() => expect(save.textContent).toBe("Save & test"));
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("No model connected");
  });

  it.each(["Groq", "DeepSeek", "Gemini"])("clears %s credentials when changing to a different provider", async (label) => {
    stubSetupProbe({ status: 200, value: {} });
    render(<SetupGate><div data-testid="workbench" /></SetupGate>);
    await screen.findByText("How should the agent think?");
    fireEvent.click(screen.getByRole("radio", { name: `${label} API key` }));
    fireEvent.change(screen.getByPlaceholderText(`${label} API key`), { target: { value: "synthetic-provider-key" } });
    fireEvent.change(screen.getByLabelText(`${label} model`), { target: { value: "explicit-model" } });
    fireEvent.click(screen.getByRole("radio", { name: "OpenAI API key" }));
    expect((screen.getByPlaceholderText("OpenAI API key") as HTMLInputElement).value).toBe("");
    expect((screen.getByPlaceholderText("OpenAI API model ID") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("radio", { name: `${label} API key` }));
    expect((screen.getByPlaceholderText(`${label} API key`) as HTMLInputElement).value).toBe("");
  });
});
