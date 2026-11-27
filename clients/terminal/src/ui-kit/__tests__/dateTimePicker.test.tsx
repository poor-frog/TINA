import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DateTimePicker } from "../DateTimePicker";

beforeEach(() => vi.setSystemTime(new Date(2027, 0, 27, 12)));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("moves dates with the keyboard and applies the exact local minute as ISO", () => {
  const change = vi.fn();
  const openChange = vi.fn();
  render(<DateTimePicker value={new Date(2027, 0, 31, 10).toISOString()} onChange={change} onOpenChange={openChange} />);
  const trigger = screen.getByRole("button");
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const days = within(screen.getByRole("group", { name: "Dates" }));
  const selected = days.getByRole("button", { pressed: true });
  expect(document.activeElement).toBe(selected);
  fireEvent.keyDown(selected, { key: "ArrowRight" });
  expect(document.activeElement?.textContent).toBe("1");
  expect(screen.getByText(/February 2027/)).toBeTruthy();

  fireEvent.click(document.activeElement!);
  fireEvent.change(screen.getByRole("textbox", { name: "Time" }), { target: { value: "0907" } });
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use date and time" }));
  expect(change).toHaveBeenCalledWith(new Date(2027, 1, 1, 9, 7).toISOString());
  expect(openChange.mock.calls).toEqual([[true], [false]]);
  expect(document.activeElement).toBe(trigger);
});

it("rejects past and invalid times, and Escape discards the edited value", () => {
  const change = vi.fn();
  render(<DateTimePicker value={new Date(2027, 0, 27, 13).toISOString()} onChange={change} />);
  const trigger = screen.getByRole("button");
  fireEvent.click(trigger);
  const group = within(screen.getByRole("group", { name: "Dates" }));
  const pastDay = group.getByRole("button", { name: /26.*2027/ });
  expect((pastDay as HTMLButtonElement).disabled).toBe(true);

  const time = screen.getByRole("textbox", { name: "Time" });
  fireEvent.change(time, { target: { value: "10:07" } });
  fireEvent.keyDown(time, { key: "Enter" });
  expect(screen.getByRole("alert").textContent).toBe("Choose a time in the future.");
  fireEvent.change(time, { target: { value: "25:00" } });
  fireEvent.keyDown(time, { key: "Enter" });
  expect(screen.getByRole("alert").textContent).toBe("Enter a time from 00:00 to 23:59.");

  act(() => time.focus());
  fireEvent.keyDown(time, { key: "Escape" });
  expect(change).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
