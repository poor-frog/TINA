import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsDialog } from "../settings";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("hides manual thinking and clears a legacy pin when model settings are saved", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/user/models") return Response.json({ mode: "groq", model: "openai/gpt-oss-20b", effort: "high" });
    if (path === "/api/user/transcription") return Response.json({ backend: "default" });
    if (path === "/api/models/catalog") return Response.json({ models: [] });
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsDialog onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Models" }));
  await waitFor(() => expect((screen.getByLabelText("Chat model") as HTMLSelectElement).value).toBe("openai/gpt-oss-20b"));
  expect(screen.queryByText("Intelligence", { exact: true })).toBeNull();
  expect(screen.queryByLabelText(/thinking|intelligence/i)).toBeNull();
  fireEvent.change(screen.getByLabelText("Chat model"), { target: { value: "openai/gpt-oss-120b" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => {
    const saved = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/user/models" && init?.method === "PUT");
    expect(saved).toBeTruthy();
    expect(JSON.parse(String(saved?.[1]?.body))).toEqual({ model: "openai/gpt-oss-120b", effort: "" });
  });
});


it("saves a separate translation model while retaining the chat model", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/user/models") return Response.json({ mode: "groq", model: "openai/gpt-oss-120b" });
    if (path === "/api/user/transcription") return Response.json({ backend: "default" });
    if (path === "/api/models/catalog") return Response.json({ models: [] });
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsDialog onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Models" }));
  await screen.findByRole("option", { name: "Same as meeting model" });
  fireEvent.change(screen.getByLabelText("Translation model"), { target: { value: "openai/gpt-oss-20b" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => {
    const saved = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/user/models" && init?.method === "PUT");
    expect(JSON.parse(String(saved?.[1]?.body))).toEqual({ translation_model: "openai/gpt-oss-20b", effort: "" });
  });
});
