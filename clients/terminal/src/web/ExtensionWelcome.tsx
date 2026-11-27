// Lucian UX/UI Prompt #393 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#393
// Lucian UX/UI Prompt #008 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#008
"use client";

import { useEffect, useRef, useState } from "react";
import { CHROME_EXTENSIONS_URL, EXTENSION_ARCHIVE_NAME, EXTENSION_DOWNLOAD_URL, copyText } from "./ExtensionDownloadModal";
import { WebIcon } from "./Icons";
import welcome from "./calendarWelcome.module.css";
import styles from "./extensionWelcome.module.css";

function supportsBrowserInstall() {
  if (typeof navigator === "undefined") return false;
  const agent = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(agent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return !mobile && /Chrome\/|Chromium\/|Edg\//.test(agent);
}

function ChromeExtensionsCopy() {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");

  useEffect(() => {
    if (status !== "copied") return;
    const timer = window.setTimeout(() => setStatus("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [status]);

  const copy = async () => {
    if (status === "copying") return;
    setStatus("copying");
    setStatus(await copyText(CHROME_EXTENSIONS_URL) ? "copied" : "error");
  };

  return (
    <div className={styles.copyAddress}>
      <div className={styles.copyLine}>
        <code>{CHROME_EXTENSIONS_URL}</code>
        <button
          type="button"
          className={styles.copyButton}
          aria-label="Copy Chrome extensions address"
          aria-disabled={status === "copying" || undefined}
          data-copied={status === "copied" || undefined}
          onClick={copy}
        >
          <span className={styles.copyIcons} aria-hidden="true">
            {status === "copied" ? (
              <svg key="check" className={styles.checkIcon} viewBox="0 0 24 24">
                <path d="M5.5 12.5l4.2 4.2L18.5 8" />
              </svg>
            ) : (
              <svg key="copy" viewBox="0 0 24 24">
                <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
                <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
              </svg>
            )}
          </span>
          {status === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <p className={status === "error" ? styles.copyError : "sr-only"} role="status">
        {status === "copied" && "Address copied."}
        {status === "error" && "Couldn’t copy. Select the address to copy it manually."}
      </p>
    </div>
  );
}

export function ExtensionWelcome({ storeUrl, onContinue }: {
  storeUrl: string | null;
  onContinue: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const canInstall = supportsBrowserInstall();

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <main className={welcome.screen}>
      <div className={welcome.layout}>
        <section className={welcome.intro} aria-labelledby="extension-welcome-title">
          <div className={welcome.brand}>
            <img src="/tina-logo.svg" width={28} height={28} alt="" />
            <span>TINA</span>
          </div>
          <h1 ref={heading} tabIndex={-1} id="extension-welcome-title" className={styles.title}>Install MeetTINA Extension</h1>
          <p className={welcome.summary}>Read live transcripts and ask Tina inside Google Meet.</p>

          {!canInstall && <p className={styles.compatibility}>Open TINA in Chrome on a computer to install the extension.</p>}
          <div className={welcome.actions}>
            {canInstall && (
              <a
                className={styles.primary}
                href={storeUrl ?? EXTENSION_DOWNLOAD_URL}
                download={storeUrl ? undefined : EXTENSION_ARCHIVE_NAME}
                target={storeUrl ? "_blank" : undefined}
                rel={storeUrl ? "noopener noreferrer" : undefined}
              >
                <WebIcon name={storeUrl ? "externalLink" : "download"} size={18} />
                {storeUrl ? "Open Chrome Web Store" : "Download extension ZIP"}
              </a>
            )}
            <button
              type="button"
              className={canInstall ? styles.continue : styles.primary}
              onClick={onContinue}
            >
              Continue to TINA
            </button>
          </div>
        </section>

        <section className={styles.guide} aria-labelledby="extension-guide-title">
          <h2 id="extension-guide-title">Install in Chrome</h2>
          <ol className={styles.steps} role="list">
            {storeUrl ? (
              <li><strong>Add the extension</strong><span>Choose Add to Chrome in the Web Store, then confirm.</span></li>
            ) : (
              <>
                <li><strong>Unzip the download</strong><span>Extract the <code>meettina-extension</code> folder.</span></li>
                <li>
                  <strong>Load it in Chrome</strong>
                  <span>
                    {canInstall ? "Paste the address into a Chrome tab. " : <>Open <code>{CHROME_EXTENSIONS_URL}</code>. </>}
                    Turn on <b>Developer mode</b> and use <b>Load unpacked</b> to select the folder.
                  </span>
                  {canInstall && <ChromeExtensionsCopy />}
                </li>
              </>
            )}
            <li><strong>Open Google Meet</strong><span>Open the MeetTINA panel and sign in with Google.</span></li>
          </ol>
        </section>
      </div>
    </main>
  );
}
