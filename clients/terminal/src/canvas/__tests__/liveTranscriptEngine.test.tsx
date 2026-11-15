import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { LiveTranscriptEngine, type EngineEntity } from "../LiveTranscriptEngine";

function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(ui); });
  return { container, unmount: () => act(() => root.unmount()) };
}

const segments = [{ id: "s0", speaker: "Jane", text: "I spoke with Acme today.", completed: true }];

describe('final ASR display formatting',()=>{
  it('formats final segments without an original disclosure while preserving raw inputs and drafts',()=>{
    const input=[{id:'s-final',speaker:'Lan',completed:true,text:'Mức mười chín phần trăm; ngày mười lăm tháng mười một.'},
      {id:'s-draft',speaker:'Lan',completed:false,text:'Mức hai mươi tư phần trăm.'}];
    const before=JSON.stringify(input);
    const {container,unmount}=render(<LiveTranscriptEngine segments={input}/>);
    expect(container.textContent).toContain('Mức 19%; ngày 15/11.');
    expect(container.textContent).toContain('Mức hai mươi tư phần trăm.');
    expect(container.querySelector('details[data-asr-original]')).toBeNull();
    expect(container.textContent).not.toContain('ASR original');
    expect(container.textContent).not.toContain(input[0].text);
    expect(JSON.stringify(input)).toBe(before);unmount();
  });

  it.each(['vi','bilingual'] as const)('preserves playback identity and original source in %s',language=>{
    const onClick=vi.fn(),input=[{id:'s1',speaker:'Lan',completed:true,text:'mã A gạch ngang một hai ba.'}];
    const {container,unmount}=render(<LiveTranscriptEngine segments={input} language={language}
      playableSegmentIds={new Set(['s1'])} onSegmentClick={onClick}/>);
    const button=container.querySelector('button')!;
    expect(button.textContent).toBe('mã A-123.');button.click();expect(onClick).toHaveBeenCalledWith('s1');
    expect(container.querySelector('details[data-asr-original]')).toBeNull();
    expect(container.textContent).not.toContain('ASR original');
    expect(input[0].text).toBe('mã A gạch ngang một hai ba.');
    unmount();
  });
});

describe("LiveTranscriptEngine — processed v2 inline rendering", () => {
  it("RAW mode (no entities) renders plain text with no entity spans/menu", () => {
    const { container, unmount } = render(<LiveTranscriptEngine segments={segments} />);
    expect(container.textContent).toContain("I spoke with Acme today.");
    expect(container.querySelector('[role="button"][aria-haspopup="menu"]')).toBeNull();
    unmount();
  });

  it("renders exact contested words like an ordinary unresolved tail without leaking wire metadata", () => {
    const contested = [{
      id: "s-contested",
      speaker: "Tom Dean",
      text: "before ⟦shared words⟧{CSRC 201↔CSRC 840} after",
      completed: true,
    }];
    const { container, unmount } = render(<LiveTranscriptEngine segments={contested} />);
    const mark = container.querySelector('[data-contested="true"]') as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe("shared words");
    expect(mark.style.fontStyle).toBe("italic");
    expect(mark.getAttribute("aria-label")).toBe("Unresolved live transcript");
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
    expect(container.textContent).not.toContain("⟦");
    expect(container.textContent).not.toContain("⟧");
    expect(container.textContent).not.toContain("{CSRC");
    expect(container.textContent).not.toContain("CONTESTED");
    unmount();
  });

  it("PROCESSED mode highlights the entity inline and fires Research on click", () => {
    const research = vi.fn();
    const entities: EngineEntity[] = [{ id: "c1", label: "Acme", kind: "company", docPath: "kg/acme.md" }];
    const { container, unmount } = render(
      <LiveTranscriptEngine segments={segments} entities={entities} actions={{ research }} />,
    );
    const mention = container.querySelector('[role="button"][aria-haspopup="menu"]') as HTMLElement;
    expect(mention).not.toBeNull();
    expect(mention.textContent).toBe("Acme");

    act(() => { mention.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const items = [...container.querySelectorAll('[role="menuitem"]')];
    const researchItem = items.find((el) => el.textContent === "Research") as HTMLElement;
    expect(researchItem).toBeDefined();

    act(() => { researchItem.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(research).toHaveBeenCalledWith({ id: "c1", name: "Acme", kind: "company", docPath: "kg/acme.md" });
    unmount();
  });

  it("renders actionable signal badges that fire onSignal", () => {
    const onSignal = vi.fn();
    const { container, unmount } = render(
      <LiveTranscriptEngine
        segments={segments}
        entities={[]}
        signals={[{ id: "sig1", kind: "decision", label: "Ship Friday" }]}
        actions={{ onSignal }}
      />,
    );
    const badge = container.querySelector('[aria-label="signals"] button') as HTMLElement;
    expect(badge).not.toBeNull();
    act(() => { badge.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onSignal).toHaveBeenCalledWith({ id: "sig1", kind: "decision", label: "Ship Friday" });
    unmount();
  });
});

it('distinct speaker IDs with equal names remain separate transcript blocks',()=>{
  const {container,unmount}=render(<LiveTranscriptEngine segments={[{id:'a',speakerId:'person-a',speaker:'Minh',text:'First speaker',completed:true},{id:'b',speakerId:'person-b',speaker:'Minh',text:'Second speaker',completed:true}]} />);
  expect(container.textContent?.match(/Minh/g)?.length).toBe(2);
  unmount();
});

it('retains every segment identity in a merged speaker block for voice evidence navigation', () => {
  const { container, unmount } = render(<LiveTranscriptEngine segments={[
    { id: 'owner', speaker: 'Lan', text: 'Lan phụ trách demo.' },
    { id: 'deadline', speaker: 'Lan', text: 'Hạn thứ Sáu.' },
  ]} />);
  const anchor = container.querySelector<HTMLElement>('[data-transcript-segments]')!;
  expect(JSON.parse(anchor.dataset.transcriptSegments!)).toEqual(['owner', 'deadline']);
  expect(anchor.tabIndex).toBe(-1);
  expect(anchor.textContent).toContain('Hạn thứ Sáu.');
  unmount();
});
