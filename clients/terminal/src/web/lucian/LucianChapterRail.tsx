"use client";
// Lucian UX/UI Prompt #195 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#195
import "./lucian-195.css";

export interface ChapterRailItem {
  id: string;
  title: string;
  time: string;
  seconds: number;
  segmentId?: string;
}

export function LucianChapterRail({
  chapters,
  activeIndex,
  onSelect,
}: {
  chapters: ChapterRailItem[];
  activeIndex: number;
  onSelect: (chapter: ChapterRailItem, index: number) => void;
}) {
  if (chapters.length === 0) return null;

  return (
    <div className="ux u195" data-testid="lucian-chapter-rail" aria-label="Meeting chapters">
      <div className="timeline" aria-hidden="true">
        {chapters.map((ch, idx) => (
          <i key={ch.id} className={idx <= activeIndex ? "on" : ""} />
        ))}
      </div>
      <div className="chapters" role="group" aria-label="Jump to chapter">
        {chapters.map((ch, idx) => {
          const isCurrent = idx === activeIndex;
          return (
            <button
              key={ch.id}
              type="button"
              data-ch={idx}
              aria-pressed={isCurrent}
              title={`${ch.title} (${ch.time})`}
              onClick={() => onSelect(ch, idx)}
            >
              <span>{ch.title}</span>
              <small>{ch.time}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
