import type { Metadata } from "next";
import Link from "next/link";
import styles from "./PrivacyPolicy.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy — MeetTina",
  description: "How MeetTina and the MeetTina Chrome Extension handle authentication, meeting data, and browser permissions.",
};

export default function PrivacyPolicyPage() {
  return (
    <main className={styles.page} lang="en">
      <div className={styles.container}>
        <header className={styles.header}>
          <Link href="/" className={styles.brand}>
            <img src="/tina-logo.svg" alt="" width={28} height={30} />
            <span>MeetTina</span>
          </Link>
          <Link href="/" className={styles.backLink}>
            Back to MeetTina
          </Link>
        </header>

        <section className={styles.hero}>
          <p className={styles.eyebrow}>Privacy Policy</p>
          <h1 className={styles.title}>MeetTina &amp; MeetTina Chrome Extension</h1>
          <p className={styles.updated}>Effective date: November 27, 2026 · Applies to meettina.site</p>
        </section>

        <section className={styles.card}>
          <h2>1. Information We Process</h2>
          <ul>
            <li>
              <strong>Account &amp; authentication data:</strong> When you sign in with Google to connect MeetTina or the Chrome Extension, we process your Google account email address and verified Google subject identifier to match your MeetTina account and issue a revocable PKCE extension session token.
            </li>
            <li>
              <strong>Authorized meeting &amp; transcript data:</strong> When you view meetings, send or stop a MeetTina Bot, read live or archived transcripts, translate text, or ask questions about a meeting, requests are sent solely to your configured MeetTina instance (<code>https://meettina.site</code>) and scoped to meetings you own or are authorized to access.
            </li>
            <li>
              <strong>Active tab meeting URL &amp; in-call display context:</strong> On supported meeting URLs (such as <code>meet.google.com</code>), the extension inspects the active meeting URL only when needed to detect the meeting room, show the MeetTina overlay, and match participant display labels/avatars already visible on the page with your authorized meeting speaker data.
            </li>
            <li>
              <strong>Local extension preferences:</strong> Theme, transcript display language, panel position, and meeting timestamp pins are stored locally in Chrome extension storage.
            </li>
          </ul>
        </section>

        <section className={styles.card}>
          <h2>2. What the Chrome Extension Does Not Do</h2>
          <ul>
            <li>
              <strong>No audio, microphone, or video capture:</strong> The MeetTina Chrome Extension does not request microphone, camera, or tab audio capture permissions and does not record or upload browser media streams.
            </li>
            <li>
              <strong>No browsing-history tracking or advertising use:</strong> MeetTina never reads unrelated browser tabs, never injects ads, and never sells or transfers user data to data brokers or third-party advertisers.
            </li>
            <li>
              <strong>No background bot auto-joining:</strong> The extension only sends or stops a MeetTina Bot in response to an explicit user action.
            </li>
          </ul>
        </section>

        <section className={styles.card}>
          <h2>3. Chrome Extension Permissions</h2>
          <ul>
            <li><strong>identity:</strong> Runs the PKCE authorization flow with <code>https://meettina.site/connect-extension</code>.</li>
            <li><strong>storage:</strong> Stores your revocable extension session credential and UI preferences locally.</li>
            <li><strong>tabs:</strong> Detects supported meeting links in the active tab and opens your meetings on MeetTina.</li>
            <li><strong>sidePanel:</strong> Renders the authorized transcript viewer inside Chrome&apos;s side panel.</li>
            <li><strong>Host access (<code>meettina.site</code>, <code>meet.google.com</code>):</strong> Communicates with the MeetTina API and renders the optional in-call MeetTina panel inside Google Meet.</li>
          </ul>
        </section>

        <section className={styles.card}>
          <h2>4. Security, Retention &amp; Revocation</h2>
          <p>
            All extension communication with MeetTina uses HTTPS. Browser extension tokens are scoped strictly to extension meeting/transcript routes and can be revoked immediately at any time by clicking <strong>Sign out</strong> in the extension or revoking tokens in MeetTina Settings.
          </p>
          <p>
            For data access, correction, or account deletion requests, please sign in at{" "}
            <Link href="/">https://meettina.site</Link> or contact your MeetTina workspace administrator.
          </p>
        </section>
      </div>
    </main>
  );
}
