import * as React from "react";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { render, pretty } from "react-email";
import MeetingFollowup, {
  ActionItemsBlock,
  ArtifactButton,
  InsightsSection,
  MeetingTime,
  OrganizerEmailOnly,
  OrganizerMeta,
  OverviewItemPlain,
  OverviewItemTitled,
  OverviewSection,
  Paragraph,
  SampleNotice,
  StatCardPair,
  StatCardSingle,
  TopicChip,
  TopicsBlock,
} from "./meeting-followup";

const directory = new URL("../src/flows_steps/templates/", import.meta.url);
const slots = {
  subject: "TINA_SLOT_SUBJECT",
  preheader: "TINA_SLOT_PREHEADER",
  meeting: "TINA_SLOT_MEETING",
  logo: "TINA_SLOT_LOGO",
  calendar_day: "TINA_SLOT_CALENDAR_DAY",
  notice: "TINA_SLOT_NOTICE",
  organizer_block: "TINA_SLOT_ORGANIZER_BLOCK",
  meeting_time_block: "TINA_SLOT_MEETING_TIME_BLOCK",
  insights_section: "TINA_SLOT_INSIGHTS_SECTION",
  overview_section: "TINA_SLOT_OVERVIEW_SECTION",
  content: "TINA_SLOT_CONTENT",
  text: "TINA_SLOT_TEXT",
  title: "TINA_SLOT_TITLE",
  name: "TINA_SLOT_NAME",
  email: "TINA_SLOT_EMAIL",
  left_text: "TINA_SLOT_LEFT_TEXT",
  right_text: "TINA_SLOT_RIGHT_TEXT",
  stats: "TINA_SLOT_STATS",
  topics: "TINA_SLOT_TOPICS",
  chips: "TINA_SLOT_CHIPS",
  items: "TINA_SLOT_ITEMS",
  actions: "TINA_SLOT_ACTIONS",
  summary_url: "https://tina.invalid/TINA_SLOT_SUMMARY_URL",
  recording_url: "https://tina.invalid/TINA_SLOT_RECORDING_URL",
  app_url: "https://tina.invalid/TINA_SLOT_APP_URL",
  settings_url: "https://tina.invalid/TINA_SLOT_SETTINGS_URL",
  url: "https://tina.invalid/TINA_SLOT_URL",
};

async function compile(element: React.ReactElement) {
  let html = await pretty(await render(element));
  // Python's string.Template owns runtime substitutions, after escaping user values.
  html = html.replaceAll("$", () => "$$");
  const ordered = Object.entries(slots).sort((a, b) => b[1].length - a[1].length);
  for (const [name, slot] of ordered) html = html.replaceAll(slot, `$${name}`);
  assert(!html.includes("TINA_SLOT_"));
  return html.trimEnd() + "\n";
}

const shell = await compile(
  <MeetingFollowup
    subject={slots.subject}
    preheader={slots.preheader}
    meeting={slots.meeting}
    logo={slots.logo}
    calendarDay={slots.calendar_day}
    summaryUrl={slots.summary_url}
    recordingUrl={slots.recording_url}
    appUrl={slots.app_url}
    settingsUrl={slots.settings_url}
    notice={slots.notice}
    organizerBlock={slots.organizer_block}
    meetingTimeBlock={slots.meeting_time_block}
    insightsSection={slots.insights_section}
    overviewSection={slots.overview_section}
  >
    {slots.content}
  </MeetingFollowup>,
);

const fragment = async (element: React.ReactElement) =>
  (await compile(element)).replace(/^<!DOCTYPE[^>]*>\s*/i, "");

const fragments = {
  paragraph: await fragment(<Paragraph>{slots.text}</Paragraph>),
  notice: await fragment(<SampleNotice>{slots.text}</SampleNotice>),
  summary: await fragment(<ArtifactButton href={slots.url} />),
  recording: await fragment(<ArtifactButton href={slots.url} recording />),
  organizer: await fragment(<OrganizerMeta name={slots.name} email={slots.email} />),
  organizer_email_only: await fragment(<OrganizerEmailOnly email={slots.email} />),
  meeting_time: await fragment(<MeetingTime>{slots.text}</MeetingTime>),
  stats_pair: await fragment(<StatCardPair leftText={slots.left_text} rightText={slots.right_text} />),
  stat_single: await fragment(<StatCardSingle text={slots.text} />),
  topic_chip: await fragment(<TopicChip>{slots.text}</TopicChip>),
  topics_block: await fragment(<TopicsBlock chips={slots.chips} />),
  insights_section: await fragment(<InsightsSection stats={slots.stats} topics={slots.topics} moreUrl={slots.url} />),
  overview_item_titled: await fragment(<OverviewItemTitled title={slots.title} text={slots.text} />),
  overview_item_plain: await fragment(<OverviewItemPlain text={slots.text} />),
  actions_block: await fragment(<ActionItemsBlock items={slots.items} />),
  overview_section: await fragment(<OverviewSection items={slots.items} actions={slots.actions} notesUrl={slots.url} />),
};

assert(shell.includes('lang="vi"') && shell.includes("$content"));
assert(shell.includes('href="$summary_url"') && shell.includes('href="$recording_url"'));
assert(shell.includes("<!--[if mso]>"));
for (const button of [fragments.summary, fragments.recording, fragments.insights_section, fragments.overview_section]) {
  assert(button.includes('href="$url"'));
  assert(button.includes("<!--[if mso]>"));
}
for (const html of [shell, ...Object.values(fragments)]) {
  assert(!/display:\s*(flex|grid)|@keyframes|<script|linear-gradient|box-shadow/.test(html));
  assert(!html.includes("TINA"));
  assert(Buffer.byteLength(html) < 102_000);
}
for (const [name, value] of Object.entries({
  "meeting-followup.html": shell,
  "meeting-followup.parts.json": JSON.stringify(fragments, null, 2) + "\n",
})) {
  const path = new URL(name, directory);
  if (process.argv.includes("--check")) assert.equal(readFileSync(path, "utf8"), value, `${name} needs regeneration`);
  else writeFileSync(path, value);
}
console.log(process.argv.includes("--check") ? "React Email exports are current" : "Exported React Email shell and fragments");
