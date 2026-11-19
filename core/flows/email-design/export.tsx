import * as React from "react";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { render, pretty } from "react-email";
import MeetingFollowup, { ArtifactButton, Paragraph, SampleNotice } from "./meeting-followup";

const directory = new URL("../src/flows_steps/templates/", import.meta.url);
const slots = {
  subject: "TINA_SLOT_SUBJECT", meeting: "TINA_SLOT_MEETING", logo: "TINA_SLOT_LOGO",
  notice: "TINA_SLOT_NOTICE", content: "TINA_SLOT_CONTENT", text: "TINA_SLOT_TEXT",
  url: "https://tina.invalid/TINA_SLOT_URL",
};

async function compile(element: React.ReactElement) {
  let html = await pretty(await render(element));
  // Python's string.Template owns runtime substitutions, after escaping user values.
  html = html.replaceAll("$", () => "$$");
  for (const [name, slot] of Object.entries(slots)) html = html.replaceAll(slot, `$${name}`);
  assert(!html.includes("TINA_SLOT_"));
  return html.trimEnd() + "\n";
}

const shell = await compile(<MeetingFollowup subject={slots.subject} meeting={slots.meeting}
  logo={slots.logo} notice={slots.notice}>{slots.content}</MeetingFollowup>);
const fragment = async (element: React.ReactElement) =>
  (await compile(element)).replace(/^<!DOCTYPE[^>]*>\s*/i, "");
const fragments = {
  paragraph: await fragment(<Paragraph>{slots.text}</Paragraph>),
  notice: await fragment(<SampleNotice>{slots.text}</SampleNotice>),
  summary: await fragment(<ArtifactButton href={slots.url} />),
  recording: await fragment(<ArtifactButton href={slots.url} recording />),
};

assert(shell.includes('lang="vi"') && shell.includes("$content"));
for (const button of [fragments.summary, fragments.recording]) {
  assert(button.includes('href="$url"'));
  assert(button.includes("<!--[if mso]>"));
}
for (const html of [shell, ...Object.values(fragments)]) {
  assert(!/display:\s*(flex|grid)|@keyframes|<script|linear-gradient/.test(html));
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
