"use client";

import { signIn } from "next-auth/react";
import { GOOGLE_CALENDAR_AUTHORIZATION_PARAMS, GOOGLE_CALENDAR_PROVIDER } from "./googleCalendar";

export async function startGoogleCalendarLink(callbackUrl: string): Promise<void> {
  const response = await fetch("/api/auth/google-calendar-link", { method: "POST", cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "Google Calendar connection is unavailable");
  }
  await signIn(GOOGLE_CALENDAR_PROVIDER, { callbackUrl }, GOOGLE_CALENDAR_AUTHORIZATION_PARAMS);
}

export function calendarSettingsCallbackUrl(currentUrl: string): string {
  const url = new URL(currentUrl);
  url.searchParams.set("tina-calendar-settings", "google-linked");
  return url.toString();
}
