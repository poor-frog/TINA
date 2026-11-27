import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  CHROME_EXTENSIONS_URL,
  EXTENSION_ARCHIVE_NAME,
  EXTENSION_DOWNLOAD_URL,
  ExtensionDownloadModal,
} from "../ExtensionDownloadModal";

describe("ExtensionDownloadModal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<ExtensionDownloadModal open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows 3-step install instructions, Copy chrome://extensions, and Download again link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onClose = vi.fn();

    render(<ExtensionDownloadModal open={true} onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Install MeetTINA Extension" })).toBeTruthy();
    expect(screen.getByText(`Downloading ${EXTENSION_ARCHIVE_NAME}`)).toBeTruthy();
    expect(screen.getByText(CHROME_EXTENSIONS_URL)).toBeTruthy();

    const downloadAgain = screen.getByRole("link", { name: "Download again" });
    expect(downloadAgain.getAttribute("href")).toBe(EXTENSION_DOWNLOAD_URL);
    expect(downloadAgain.getAttribute("download")).toBe(EXTENSION_ARCHIVE_NAME);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(CHROME_EXTENSIONS_URL);
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
