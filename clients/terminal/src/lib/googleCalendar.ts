export const GOOGLE_CALENDAR_PROVIDER = "google-calendar";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
] as const;

export const GOOGLE_CALENDAR_AUTHORIZATION_PARAMS = {
  scope: ["openid", "email", "profile", ...GOOGLE_CALENDAR_SCOPES].join(" "),
  access_type: "offline",
  include_granted_scopes: "true",
  prompt: "consent select_account",
};
