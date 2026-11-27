export const GOOGLE_CALENDAR_PROVIDER = "google-calendar";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
] as const;

export const GOOGLE_CALENDAR_AUTHORIZATION_PARAMS = {
  scope: ["openid", "email", "profile", ...GOOGLE_CALENDAR_SCOPES].join(" "),
  access_type: "offline",
  prompt: "consent select_account",
};
