import { botFetch, type BotConnection } from './bot-transcript';

interface Source {
  id: string;
  kind: 'transcript' | 'document';
  quote: string;
  speaker_name?: string;
  start_ms?: number;
  path?: string;
  meeting_title?: string;
  meeting_id?: number;
}

interface Answer {
  id: string;
  question: string;
  claims: { text: string; source_ids: string[] }[];
  sources: Source[];
  stale: boolean;
  saved_path: string | null;
  coverage?: { selected: number; available: number; bounded: boolean };
  catch_up_window?: CatchUpWindow;
  meeting_ids?: number[];
  reply_to?: string;
  assistant?: boolean;
}

interface CatchUpWindow {
  start_ms: number;
  end_ms: number;
  confirmed_through_ms: number | null;
  boundary_omitted: boolean;
}

interface Knowledge {
  answers: Answer[];
  documents: { path: string; title: string }[];
  segment_count: number;
}

class AskError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function knowledgeRequest<T>(config: BotConnection, meetingId: number, signal: AbortSignal,
  action: '' | '/ask' | `/answers/${string}/apply` = '',
  body?: { question: string; documents?: string[]; notes_preview?: true; reply_to?: string; assistant?: true }): Promise<T> {
  const path = `/agent/workspace/meeting-knowledge/${meetingId}${action}`;
  const response = await botFetch(config, path, {
    method: action ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(action === '/ask' ? 180000 : 20000)]),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    let message = typeof value?.detail === 'string' ? value.detail.slice(0, 300) : 'Ask TINA gặp lỗi. Hãy thử lại.';
    if (response.status === 401 || response.status === 403)
      message = 'Kiểm tra phiên TINA và quyền truy cập cuộc họp.';
    else if (response.status === 404)
      message = 'Ask TINA chưa khả dụng. Kiểm tra quyền cuộc họp hoặc cập nhật cổng TINA.';
    else if (body?.assistant && response.status === 422)
      message = 'Hãy cập nhật Agent API TINA để dùng Chat Assistant trong cuộc họp.';
    else if (body?.reply_to && response.status === 422)
      message = 'Hãy cập nhật Agent API TINA để dùng Hỏi tiếp.';
    else if (body?.notes_preview && response.status === 422)
      message = 'Hãy cập nhật Agent API TINA để tạo bản tóm tắt Notes.';
    else if (body?.notes_preview && value?.detail === 'No confirmed transcript yet')
      message = 'Chưa có transcript đã xác nhận. Hãy chờ TINA Bot lưu lời nói.';
    else if (body?.notes_preview && value?.detail === 'Transcript changed. Generate notes again.')
      message = 'Transcript đã thay đổi trong lúc tạo. Hãy tạo lại bản tóm tắt.';
    else if (value?.detail?.code === 'reply_to_stale')
      message = 'Nguồn của câu trả lời trước đã thay đổi. Hãy bỏ ngữ cảnh và hỏi lại.';
    else if (value?.detail?.code === 'reply_to_unavailable')
      message = 'Câu trả lời đã chọn không còn dùng được để hỏi tiếp. Hãy chọn câu khác hoặc bỏ ngữ cảnh.';
    else if (response.status === 409 && action === '/ask' && value?.detail === 'No confirmed transcript or selected documents yet')
      message = 'Chưa có transcript đã xác nhận. Hãy đợi TINA ghi nhận lời nói hoặc chọn tài liệu liên quan.';
    throw new AskError(message, response.status);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Gateway không trả về dữ liệu Ask TINA.');
  if (body?.reply_to && value.reply_to !== body.reply_to)
    throw new Error('Agent API chưa xác nhận ngữ cảnh hỏi tiếp. Hãy cập nhật Agent API TINA.');
  if (body?.assistant && value.assistant !== true)
    throw new Error('Agent API chưa xác nhận Chat Assistant cho cuộc họp này.');
  return value as T;
}

export function requestNotesPreview(config: BotConnection, meetingId: number, signal: AbortSignal): Promise<unknown> {
  return knowledgeRequest(config, meetingId, signal, '/ask', { question: 'Tóm tắt cuộc họp', notes_preview: true });
}

const wallTime = (ms: number) => new Date(ms).toLocaleTimeString('vi-VN');

function confirmedThrough(ms: number | null | undefined): string {
  return ms != null && Number.isFinite(ms) ? ` Transcript đã xác nhận đến ${wallTime(ms)}.` : '';
}

function line<K extends keyof HTMLElementTagNameMap>(tag: K, copy: string, className?: string) {
  const element = document.createElement(tag);
  element.textContent = copy;
  if (className) element.className = className;
  return element;
}

function sourceLabel(source: Source): string {
  if (source.kind === 'document') return source.path || 'Tài liệu';
  const ms = source.start_ms;
  const seconds = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const time = ms == null || !Number.isFinite(ms) ? '' : ms >= 1e12
    ? new Date(ms).toLocaleTimeString('vi-VN')
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return [source.meeting_title, source.speaker_name || 'Transcript', time].filter(Boolean).join(' · ');
}

export function createMeetAsk() {
  const form = document.getElementById('askForm') as HTMLFormElement;
  const question = document.getElementById('askQuestion') as HTMLTextAreaElement;
  const send = document.getElementById('askSend') as HTMLButtonElement;
  const reload = document.getElementById('askReload') as HTMLButtonElement;
  const status = document.getElementById('askStatus')!;
  const feed = document.getElementById('askFeed')!;
  const answers = document.getElementById('askAnswers')!;
  const welcome = document.getElementById('askWelcome')!;
  const prompts = document.querySelectorAll<HTMLButtonElement>('#askPrompts button');
  const documents = document.getElementById('askDocuments') as HTMLDetailsElement;
  const choices = document.getElementById('askDocumentChoices')!;
  const newQuestion = document.getElementById('askNewQuestion') as HTMLButtonElement;
  let context: { config: BotConnection; meetingId: number; lifetime: AbortController } | null = null;
  let replyTo: Pick<Answer, 'id'> | null = null;
  let ready = false;
  let busy = false;

  function canFollow(answer: Answer | undefined) {
    return !!answer && !answer.stale && answer.claims.length > 0 && /^[0-9a-f]{32}$/.test(answer.id)
      && !answer.meeting_ids?.length && answer.sources.length > 0
      && answer.sources.every(source => (source.kind === 'transcript' || (answer.assistant && source.kind === 'document'))
        && (source.meeting_id == null || source.meeting_id === context?.meetingId));
  }

  function showStatus(copy: string, error = false, announceOnly = false) {
    status.textContent = copy;
    status.hidden = !copy;
    status.dataset.error = String(error);
    status.classList.toggle('visually-hidden', announceOnly);
  }

  function syncForm() {
    question.disabled = !ready;
    send.disabled = !ready || busy || !question.value.trim();
    newQuestion.disabled = !replyTo || busy;
    documents.hidden = choices.childElementCount === 0;
    reload.disabled = busy;
    welcome.hidden = !ready || busy || answers.childElementCount > 0 || !reload.hidden;
    for (const prompt of prompts) prompt.disabled = busy;
    form.setAttribute('aria-busy', String(busy));
    const checked = choices.querySelectorAll('input:checked').length;
    for (const option of choices.querySelectorAll('input')) option.disabled = checked >= 8 && !option.checked;
  }

  function clearResults() {
    ready = false;
    replyTo = null;
    answers.replaceChildren();
    choices.replaceChildren();
    documents.hidden = true;
    documents.open = false;
  }

  async function run(message: string, task: (room: NonNullable<typeof context>) => Promise<void>, pending?: HTMLElement) {
    const room = context;
    if (!room || busy) return;
    busy = true;
    reload.hidden = true;
    syncForm();
    showStatus(message, false, !!pending);
    try {
      await task(room);
    } catch (error) {
      if (room.lifetime.signal.aborted) return;
      if (error instanceof AskError && [401, 403, 404].includes(error.status)) clearResults();
      const message = error instanceof TypeError || error instanceof DOMException
        ? 'Không nhận được phản hồi từ TINA. Tải lại để kiểm tra lịch sử trước khi gửi lại.'
        : error instanceof Error ? error.message : 'Ask TINA gặp lỗi.';
      if (pending?.isConnected) {
        pending.closest('.ask-answer')?.classList.add('ask-failed');
        const failure = line('p', message, 'ask-status');
        failure.dataset.error = 'true';
        pending.replaceChildren(failure);
        showStatus(message, true, true);
      } else showStatus(message, true);
      reload.hidden = false;
    } finally {
      if (context === room) {
        busy = false;
        syncForm();
      }
    }
  }

  function createTurn(text: string) {
    const card = line('article', '', 'ask-answer');
    const reply = line('div', '', 'ask-reply');
    card.append(line('h2', text, 'ask-question'), reply);
    return { card, reply };
  }

  function answerCard(answer: Answer) {
    const { card, reply } = createTurn(answer.question);
    if (answer.stale) reply.append(line('p', 'Nguồn đã thay đổi. Hãy hỏi lại trước khi dùng câu trả lời.', 'note-stale'));
    if (!answer.claims.length) reply.append(line('p', 'Chưa có đủ nguồn để trả lời câu hỏi này.'));
    const sources = new Map(answer.sources.map(source => [source.id, source]));
    for (const claim of answer.claims) {
      const group = line('div', '', 'ask-claim');
      group.append(line('p', claim.text));
      for (const id of new Set(claim.source_ids)) {
        const source = sources.get(id);
        if (!source) continue;
        const citation = line('details', '', 'ask-source');
        citation.append(line('summary', sourceLabel(source)), line('blockquote', source.quote));
        group.append(citation);
      }
      reply.append(group);
    }
    if (answer.coverage?.bounded) reply.append(line('p', `Đã đối chiếu ${answer.coverage.selected}/${answer.coverage.available} đoạn nguồn.`, 'ask-status'));
    if (answer.catch_up_window) {
      const window = answer.catch_up_window;
      reply.append(line('p', `${wallTime(window.start_ms)}–${wallTime(window.end_ms)}.` +
        confirmedThrough(window.confirmed_through_ms) +
        (window.boundary_omitted ? ' Đoạn vắt qua mép thời gian được bỏ qua.' : ''), 'ask-status'));
    }
    if (answer.saved_path) reply.append(line('p', 'Đã lưu vào Wiki', 'ask-status'));
    else if (!answer.stale && answer.claims.length && /^[0-9a-f]{32}$/.test(answer.id)) {
      const save = line('details', '', 'ask-save');
      const summary = line('summary', 'Lưu vào Wiki');
      const actions = line('div', '', 'ask-confirm');
      const confirm = line('button', 'Xác nhận lưu', 'button primary');
      confirm.type = 'button';
      const cancel = line('button', 'Hủy', 'button');
      cancel.type = 'button';
      cancel.onclick = () => { save.open = false; summary.focus(); };
      confirm.onclick = () => void run('Đang lưu vào Wiki…', async room => {
        const result = await knowledgeRequest<{ path: string }>(room.config, room.meetingId,
          room.lifetime.signal, `/answers/${answer.id}/apply`);
        if (room.lifetime.signal.aborted) return;
        if (!result.path) throw new Error('TINA chưa xác nhận đã lưu trang Wiki.');
        card.replaceWith(answerCard({ ...answer, saved_path: result.path }));
        showStatus('Đã lưu vào Wiki.', false, true);
      });
      actions.append(confirm, cancel);
      save.append(summary, line('p', 'Tạo trang Wiki mới từ câu trả lời và các nguồn trên.'), actions);
      reply.append(save);
    }
    return card;
  }

  function load() {
    void run('Đang tải nguồn cuộc họp…', async room => {
      const data = await knowledgeRequest<Knowledge>(room.config, room.meetingId, room.lifetime.signal);
      if (room.lifetime.signal.aborted) return;
      if (!Array.isArray(data.answers) || !Array.isArray(data.documents)) throw new Error('Dữ liệu Ask TINA không hợp lệ.');
      const checked = new Set(Array.from(choices.querySelectorAll<HTMLInputElement>('input:checked'), option => option.value));
      const followLatest = !ready || feed.scrollHeight - feed.clientHeight - feed.scrollTop < 24;
      if (!ready && canFollow(data.answers[0])) replyTo = data.answers[0];
      answers.replaceChildren(...data.answers.slice().reverse().map(answerCard));
      if (data.answers.length) welcome.hidden = true;
      if (followLatest) feed.scrollTop = feed.scrollHeight;
      choices.replaceChildren(...data.documents.map(doc => {
        const label = line('label', '');
        const option = line('input', '');
        option.type = 'checkbox';
        option.value = doc.path;
        option.checked = checked.has(doc.path);
        label.append(option, ' ' + doc.title);
        return label;
      }));
      ready = true;
      showStatus(data.segment_count ? '' : 'Đang chờ transcript đã xác nhận.');
    });
  }

  reload.onclick = load;
  newQuestion.onclick = () => {
    replyTo = null;
    syncForm();
    question.focus();
  };
  choices.addEventListener('change', () => {
    replyTo = null;
    syncForm();
  });
  question.addEventListener('input', syncForm);
  for (const prompt of prompts) prompt.onclick = () => {
    question.value = prompt.textContent || '';
    question.focus();
    syncForm();
  };
  question.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!send.disabled) form.requestSubmit();
  });
  function submitQuestion() {
    const text = question.value.trim();
    if (!context || !ready || busy || !text || text.length > 2000) return;
    const parent = replyTo;
    const body = parent ? { question: text, reply_to: parent.id, assistant: true as const }
        : { question: text, assistant: true as const, documents: Array.from(choices.querySelectorAll<HTMLInputElement>('input:checked'), option => option.value) };
    const pendingText = 'TINA đang trả lời…';
    const { card, reply } = createTurn(text);
    const pending = line('p', pendingText, 'ask-pending');
    pending.prepend(line('span', '', 'ask-spinner'));
    reply.append(pending);
    answers.querySelector('.ask-failed')?.remove();
    answers.append(card);
    welcome.hidden = true;
    question.value = '';
    question.focus({ preventScroll: true });
    feed.scrollTop = feed.scrollHeight;
    void run(pendingText, async room => {
      let answer: Answer;
      try {
        answer = await knowledgeRequest<Answer>(room.config, room.meetingId, room.lifetime.signal, '/ask', body);
      } catch (error) {
        if (!room.lifetime.signal.aborted && !question.value) question.value = text;
        throw error;
      }
      if (room.lifetime.signal.aborted) return;
      const followLatest = feed.scrollHeight - feed.clientHeight - feed.scrollTop < 24;
      card.replaceWith(answerCard(answer));
      replyTo = canFollow(answer) ? answer : null;
      showStatus('TINA đã trả lời.', false, true);
      if (followLatest) feed.scrollTop = feed.scrollHeight;
    }, reply);
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    submitQuestion();
  });

  function reset() {
    context?.lifetime.abort();
    context = null;
    busy = false;
    question.value = '';
    clearResults();
    reload.hidden = true;
    showStatus('Gửi TINA Bot để bắt đầu hỏi về cuộc họp.');
    syncForm();
  }

  return {
    reset,
    open(config: BotConnection, meetingId: number) {
      if (context?.meetingId !== meetingId) {
        reset();
        context = { config, meetingId, lifetime: new AbortController() };
      }
      load();
    },
  };
}
