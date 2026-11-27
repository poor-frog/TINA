"use client";
/** ExtensionDownloadModal — Option A install guide shown immediately after triggering
 *  `meettina-extension.zip` download from the Account menu (before Chrome Web Store approval). */
import { useEffect, useRef, useState } from "react";
import { WebIcon } from "./Icons";
import { emitWebToast } from "./lucian/webToast";

export const EXTENSION_DOWNLOAD_URL = "/api/extension/download";
export const EXTENSION_ARCHIVE_NAME = "meettina-extension.zip";
export const CHROME_EXTENSIONS_URL = "chrome://extensions";

/** Programmatically trigger a same-origin file download without navigating away from the app. */
export function triggerExtensionDownload(): void {
  if (typeof document === "undefined") return;
  const link = document.createElement("a");
  link.href = EXTENSION_DOWNLOAD_URL;
  link.download = EXTENSION_ARCHIVE_NAME;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall through to execCommand fallback */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export function ExtensionDownloadModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      setCopied(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  if (!open) return null;

  const handleCopy = async () => {
    const ok = await copyText(CHROME_EXTENSIONS_URL);
    if (!ok) return;
    setCopied(true);
    emitWebToast(`Copied ${CHROME_EXTENSIONS_URL}`);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="tina-web-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Install MeetTINA Extension"
      onClick={onClose}
    >
      <div className="tina-web-modal tina-web-ext-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tina-web-modal-head">
          <div className="tina-web-ext-title">
            <span className="tina-web-ext-badge" aria-hidden="true">
              <WebIcon name="puzzle" size={16} />
            </span>
            <h2>Install MeetTINA Extension</h2>
          </div>
          <button type="button" className="tina-web-icon-btn" aria-label="Close" onClick={onClose}>
            <WebIcon name="close" size={16} />
          </button>
        </div>

        <div className="tina-web-modal-body">
          <div className="tina-web-ext-banner" role="status">
            <WebIcon name="download" size={15} />
            <div className="tina-web-ext-banner-text">
              <strong>Downloading {EXTENSION_ARCHIVE_NAME}</strong>
              <span>Works on Chrome, Arc, Edge, and Brave — installs in under a minute.</span>
            </div>
          </div>

          <ol className="tina-web-ext-steps">
            <li className="tina-web-ext-step">
              <span className="tina-web-ext-step-num" aria-hidden="true">1</span>
              <div className="tina-web-ext-step-body">
                <strong>Unzip the downloaded file</strong>
                <p>
                  Double-click <code>{EXTENSION_ARCHIVE_NAME}</code> to extract the{" "}
                  <code>meettina-extension</code> folder.
                </p>
              </div>
            </li>

            <li className="tina-web-ext-step">
              <span className="tina-web-ext-step-num" aria-hidden="true">2</span>
              <div className="tina-web-ext-step-body">
                <strong>Open Chrome Extensions &amp; turn on Developer mode</strong>
                <p>
                  Paste the URL below into a new tab, then toggle <strong>Developer mode</strong> ON
                  in the top-right corner.
                </p>
                <div className="tina-web-ext-copybar">
                  <code>{CHROME_EXTENSIONS_URL}</code>
                  <button
                    type="button"
                    className="tina-web-btn-ghost tina-web-ext-copy-btn"
                    onClick={() => void handleCopy()}
                  >
                    <WebIcon name={copied ? "check" : "copy"} size={13} />
                    <span>{copied ? "Copied" : "Copy"}</span>
                  </button>
                </div>
              </div>
            </li>

            <li className="tina-web-ext-step">
              <span className="tina-web-ext-step-num" aria-hidden="true">3</span>
              <div className="tina-web-ext-step-body">
                <strong>Load unpacked &amp; sign in</strong>
                <p>
                  Click <strong>Load unpacked</strong>, select the extracted{" "}
                  <code>meettina-extension</code> folder, then open Google Meet and click{" "}
                  <strong>Sign in with Google</strong>.
                </p>
              </div>
            </li>
          </ol>

          <div className="tina-web-ext-footer">
            <a
              href={EXTENSION_DOWNLOAD_URL}
              download={EXTENSION_ARCHIVE_NAME}
              className="tina-web-btn-ghost"
            >
              <WebIcon name="download" size={14} />
              <span>Download again</span>
            </a>
            <button type="button" className="tina-web-btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
