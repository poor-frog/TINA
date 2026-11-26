import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { ChatGPTPlanNotice } from "../ChatGPTPlanNotice";

test("distinguishes reconnect from usage limits and removes a cleared notice", () => {
  const { rerender } = render(<ChatGPTPlanNotice issue="reconnect_required" />);
  expect(screen.getByRole("alert").textContent).toContain("cấp quyền lại");
  rerender(<ChatGPTPlanNotice issue="usage_limit" />);
  expect(within(screen.getByRole("alert")).getByRole("link").getAttribute("href")).toBe("https://chatgpt.com/settings/usage");
  rerender(<ChatGPTPlanNotice issue={null} />);
  expect(screen.queryByRole("alert")).toBeNull();
});
