import { botFetch, type BotConnection } from './bot-transcript';

type ReviewStatus = 'approved' | 'discarded' | 'pending';
type Review = { revision: number; status: ReviewStatus; text: string };
type FactItem = {
  fact: {
    id: string;
    type: 'decision' | 'action_item';
    text: string;
    deadline_text?: string | null;
    evidence: { quote: string; speaker_name?: string; start_ms: number }[];
  };
  fingerprint: string;
  review: Review | null;
  stale: boolean;
};

const labels = { approved: 'Đã xác nhận', discarded: 'Đã bỏ qua', pending: 'Đề xuất' };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function sourceTime(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms >= 1e12) return new Date(ms).toLocaleTimeString('vi-VN');
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

class FactsError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? 'Kiểm tra API key và quyền truy cập cuộc họp.'
      : status === 404 ? 'Không truy cập được cuộc họp hoặc Gateway chưa hỗ trợ đề xuất.'
        : status === 409 ? 'Nguồn hoặc trạng thái đã thay đổi. Kiểm tra đề xuất mới trước khi duyệt.'
          : 'Chưa xác nhận được kết quả. Hãy kiểm tra lại trạng thái.');
  }
}

export function createMeetFacts(root: HTMLElement) {
  const status = root.querySelector<HTMLElement>('#notesFactsStatus')!;
  const cards = root.querySelector<HTMLElement>('#notesFactsEntries')!;
  let room: { url: string; config: BotConnection; lifetime: AbortController } | null = null;
  let readRequest: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let items: FactItem[] = [];
  let snapshot = '';
  let verified = false;
  let saving = false;

  async function request(active: NonNullable<typeof room>, signal: AbortSignal, review?: object) {
    const response = await botFetch(active.config, active.url + (review ? '/facts/review' : '?facts_only=true'), {
      method: review ? 'POST' : 'GET',
      headers: review ? { 'Content-Type': 'application/json' } : {},
      body: review ? JSON.stringify(review) : undefined,
      signal: AbortSignal.any([active.lifetime.signal, signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) throw new FactsError(response.status);
    const result = await response.json();
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('Dữ liệu đề xuất của TINA không hợp lệ.');
    return result;
  }

  function syncButtons() {
    for (const button of cards.querySelectorAll<HTMLButtonElement>('button'))
      button.disabled = !verified || saving;
  }

  function render() {
    const expanded = new Set(Array.from(cards.querySelectorAll<HTMLDetailsElement>('details[open]'), node => node.dataset.factId));
    cards.replaceChildren();
    for (const [kind, title] of [['decision', 'Quyết định'], ['action_item', 'Việc cần làm']]) {
      const groupItems = items.filter(item => item.fact.type === kind);
      if (!groupItems.length) continue;
      const group = element('section', '', 'fact-group');
      group.append(element('h4', title));
      for (const item of groupItems) {
        const { fact, review } = item;
        const text = review?.text || fact.text;
        const state = review?.status ?? 'pending';
        const card = element('article', '', 'fact-card');
        card.append(element('p', item.stale ? 'Nguồn đã thay đổi' : labels[state], item.stale ? 'note-meta note-stale' : 'note-meta'));
        card.append(element('p', text, 'note-copy'));
        if (fact.deadline_text) card.append(element('p', `Hạn được nhắc trong cuộc họp · ${fact.deadline_text}`, 'note-meta'));
        const evidence = element('details');
        evidence.dataset.factId = fact.id;
        evidence.open = expanded.has(fact.id);
        const first = fact.evidence[0];
        const cite = [first?.speaker_name, sourceTime(first?.start_ms)].filter(Boolean).join(' · ');
        evidence.append(element('summary', cite || 'Xem transcript gốc'));
        for (const source of fact.evidence) evidence.append(element('blockquote', source.quote));
        card.append(evidence);
        if (!item.stale && text.trim() && text.length <= 4000) {
          const actions = element('div', '', 'fact-actions');
          const options: [ReviewStatus, string][] = state === 'pending'
            ? [['approved', 'Xác nhận'], ['discarded', 'Bỏ qua']] : [['pending', 'Mở lại']];
          for (const [next, label] of options) {
            const button = element('button', label, 'button');
            button.type = 'button';
            button.onclick = () => void submit(item, next);
            actions.append(button);
          }
          card.append(actions);
        }
        group.append(card);
      }
      if (group.childElementCount > 1) cards.append(group);
    }
    syncButtons();
  }

  async function refresh(active: NonNullable<typeof room>, feedback = '') {
    const controller = new AbortController();
    readRequest = controller;
    try {
      const result = await request(active, controller.signal);
      if (room !== active || controller.signal.aborted) return;
      if (!Array.isArray(result.facts)) throw new Error('Gateway chưa trả về đề xuất của cuộc họp.');
      const next = (result.facts as FactItem[]).filter(item =>
        (item?.fact?.type === 'decision' || item?.fact?.type === 'action_item')
        && typeof item.fact.text === 'string' && Array.isArray(item.fact.evidence)
        && /^[0-9a-f-]{36}$/.test(item.fact.id) && /^[0-9a-f]{64}$/.test(item.fingerprint));
      const signature = JSON.stringify(next);
      verified = true;
      if (signature !== snapshot) {
        items = next;
        snapshot = signature;
        render();
      } else syncButtons();
      root.hidden = items.length === 0;
      status.textContent = feedback;
    } catch (error) {
      if (room !== active || controller.signal.aborted) return;
      verified = false;
      if (error instanceof FactsError && [401, 403, 404].includes(error.status)) {
        items = [];
        snapshot = '';
        cards.replaceChildren();
      }
      syncButtons();
      root.hidden = false;
      status.textContent = error instanceof Error ? error.message : 'Không tải được đề xuất.';
    } finally {
      if (room === active && readRequest === controller && !controller.signal.aborted) {
        readRequest = null;
        timer = setTimeout(() => void refresh(active), 10000);
      }
    }
  }

  async function submit(item: FactItem, next: ReviewStatus) {
    const active = room;
    if (!active || saving || !verified || item.stale) return;
    readRequest?.abort();
    clearTimeout(timer);
    saving = true;
    syncButtons();
    status.textContent = 'Đang lưu đánh giá…';
    let feedback = '';
    try {
      const revision = item.review?.revision ?? 0;
      const result = await request(active, active.lifetime.signal, {
        fact_id: item.fact.id, expected_fingerprint: item.fingerprint, expected_revision: revision,
        status: next, text: item.review?.text || item.fact.text,
      });
      if (result.status !== next || result.revision !== revision + 1)
        throw new Error('Chưa xác nhận được đánh giá đã lưu.');
      feedback = next === 'pending' ? 'Đã mở lại đề xuất.' : labels[next] + '.';
    } catch (error) {
      feedback = error instanceof Error ? error.message : 'Không lưu được đánh giá.';
    } finally {
      if (room === active) {
        saving = false;
        verified = false;
        syncButtons();
        await refresh(active, feedback);
      }
    }
  }

  function stop() {
    room?.lifetime.abort();
    clearTimeout(timer);
    room = null;
    readRequest = null;
    saving = false;
    verified = false;
    items = [];
    snapshot = '';
    cards.replaceChildren();
    root.hidden = true;
  }

  return {
    stop,
    start(config: BotConnection, id: number) {
      stop();
      if (!config.account) return;
      status.textContent = '';
      try {
        room = { url: `/agent/workspace/meeting-knowledge/${id}`, config,
          lifetime: new AbortController() };
        void refresh(room);
      } catch (error) {
        root.hidden = false;
        status.textContent = error instanceof Error ? error.message : 'Kiểm tra URL Gateway.';
      }
    },
  };
}
