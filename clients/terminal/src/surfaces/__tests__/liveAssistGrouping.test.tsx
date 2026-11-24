import { describe, expect, it } from "vitest";
import { linkedAgendaIds } from "../LiveAssistRunningView";
import type { LiveMeetingItem } from "../liveMeetingStateApi";

describe("live agenda assignment", () => {
  const fixture = (id: string, type: string, details?: LiveMeetingItem["details"]): LiveMeetingItem =>
    ({ id, type, details, text: "", status: "accepted", revision: 0, human: false, provisional: false, stale: false, evidence: [] });
  const topic = fixture("topic", "topic", { agenda_ids: ["first"] });
  const agendas = ["first", "second"].map((id) => fixture(id, "agenda"));
  const items = new Map([topic, ...agendas].map((entry) => [entry.id, entry]));
  const item = (agendaIds?: string[]) =>
    fixture("discussion", "discussion", { topic_id: topic.id, ...(agendaIds && { agenda_ids: agendaIds }) });

  it("keeps an explicit no-match ungrouped even when its topic has an agenda", () => {
    expect(linkedAgendaIds(item([]), items)).toEqual([]);
  });

  it("uses the direct assignment when the related topic has a different agenda", () => {
    expect(linkedAgendaIds(item(["second"]), items)).toEqual(["second"]);
  });

  it("keeps an item in Other meeting items if its assigned agenda is removed", () => {
    expect(linkedAgendaIds(item(["removed"]), items)).toEqual([]);
  });

  it("continues inheriting the topic agenda for legacy items without a direct field", () => {
    expect(linkedAgendaIds(item(), items)).toEqual(["first"]);
  });
});
