import { describe, expect, it } from "vitest";
import { linkedAgendaIds } from "../LiveAssistRunningView";
import type { LiveMeetingItem } from "../liveMeetingStateApi";

describe("live agenda assignment", () => {
  const topic = { id: "topic", details: { agenda_ids: ["first"] } } as LiveMeetingItem;
  const agendas = ["first", "second"].map((id) => ({ id, type: "agenda" } as LiveMeetingItem));
  const items = new Map([topic, ...agendas].map((entry) => [entry.id, entry]));
  const item = (agendaIds?: string[]) => ({
    id: "discussion", details: { topic_id: topic.id, ...(agendaIds && { agenda_ids: agendaIds }) },
  } as LiveMeetingItem);

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
