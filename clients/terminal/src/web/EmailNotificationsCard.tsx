"use client";
/** EmailNotificationsCard — Per-user email notification toggles in Settings → Account,
 *  persisted to admin-api `/internal/users/{id}/settings` via `/api/person-settings`. */
import { useEffect, useState } from "react";
import { emitWebToast } from "./lucian/webToast";

interface EmailPrefs {
  mail_minutes: boolean;
  mail_rsvp: boolean;
}

const DEFAULT_PREFS: EmailPrefs = {
  mail_minutes: true,
  mail_rsvp: true,
};

export function EmailNotificationsCard({ email = "" }: { email?: string }) {
  const [prefs, setPrefs] = useState<EmailPrefs>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<keyof EmailPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/person-settings", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Partial<EmailPrefs>;
      })
      .then((data) => {
        if (!active) return;
        setPrefs({
          mail_minutes: typeof data.mail_minutes === "boolean" ? data.mail_minutes : DEFAULT_PREFS.mail_minutes,
          mail_rsvp: typeof data.mail_rsvp === "boolean" ? data.mail_rsvp : DEFAULT_PREFS.mail_rsvp,
        });
        setError(null);
      })
      .catch(() => {
        if (!active) return;
        setError("Could not load email preferences. Changes will retry on toggle.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const toggle = async (key: keyof EmailPrefs) => {
    if (savingKey !== null) return;
    const previous = prefs;
    const nextValue = !prefs[key];
    setPrefs({ ...prefs, [key]: nextValue });
    setSavingKey(key);
    setError(null);
    try {
      const res = await fetch("/api/person-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: nextValue }),
        cache: "no-store",
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error || `Failed to save (HTTP ${res.status})`);
      }
      const saved = (await res.json()) as Partial<EmailPrefs>;
      setPrefs({
        mail_minutes: typeof saved.mail_minutes === "boolean" ? saved.mail_minutes : nextValue,
        mail_rsvp: typeof saved.mail_rsvp === "boolean" ? saved.mail_rsvp : previous.mail_rsvp,
      });
      emitWebToast("Email preferences saved");
    } catch (err) {
      setPrefs(previous);
      setError((err as Error).message || "Could not save email preference.");
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <section
      className="tina-web-settings-card tina-web-account-session"
      aria-labelledby="account-email-notifications-heading"
    >
      <h2 id="account-email-notifications-heading">Email notifications</h2>
      <p className="tina-web-account-subtitle">
        {email
          ? `Automatic emails from tina@meettina.site are sent to ${email}.`
          : "Control automatic emails sent from tina@meettina.site."}
      </p>

      <div className="tina-web-account-action">
        <div>
          <h3>Post-meeting summary email</h3>
          <p>Receive a meeting summary and recording link right after your meeting finishes.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={prefs.mail_minutes}
          aria-label="Post-meeting summary email"
          className={`tina-web-switch ${prefs.mail_minutes ? "on" : ""}`}
          disabled={loading || savingKey !== null}
          onClick={() => void toggle("mail_minutes")}
        >
          <span className="tina-web-switch-thumb" aria-hidden="true" />
        </button>
      </div>

      <div className="tina-web-account-action">
        <div>
          <h3>Calendar invite RSVP</h3>
          <p>Automatically reply Yes when TINA is invited to a calendar meeting.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={prefs.mail_rsvp}
          aria-label="Calendar invite RSVP"
          className={`tina-web-switch ${prefs.mail_rsvp ? "on" : ""}`}
          disabled={loading || savingKey !== null}
          onClick={() => void toggle("mail_rsvp")}
        >
          <span className="tina-web-switch-thumb" aria-hidden="true" />
        </button>
      </div>

      {error && (
        <p className="tina-web-account-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
