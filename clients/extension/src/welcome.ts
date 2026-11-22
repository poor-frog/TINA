import { listBotMeetings, type BotMeeting } from './bot-transcript';
import {
  ACCOUNT_KEY, DEFAULT_GATEWAY, DEFAULT_TERMINAL, sessionCommand, sessionEndpoints, storedAccount,
  type ExtensionAccount,
} from './extension-session';

const welcome = document.querySelector<HTMLElement>('#welcome')!;
const workspace = document.querySelector<HTMLElement>('#workspace')!;
const signIn = document.querySelector<HTMLButtonElement>('#signIn')!;
const signInLabel = document.querySelector('#signInLabel')!;
const status = document.querySelector<HTMLElement>('#status')!;
const signInText = signInLabel.textContent;
const apiKeyOption = document.querySelector<HTMLDetailsElement>('#apiKeyOption')!;
const apiKeyInput = document.querySelector<HTMLInputElement>('#tinaApiKey')!;
const apiKeySubmit = document.querySelector<HTMLButtonElement>('#connectApiKey')!;
const views = ['home', 'meetings', 'settings'] as const;
type View = typeof views[number];
const meetingList = document.querySelector('#meetingList')!;
const meetingRow = document.querySelector<HTMLTemplateElement>('#meetingRow')!;
const meetingNotice = document.querySelector<HTMLElement>('#meetingNotice')!;
const meetingStatus = document.querySelector('#meetingStatus')!;
const retryMeetings = document.querySelector<HTMLButtonElement>('#retryMeetings')!;
const viewAll = document.querySelector<HTMLButtonElement>('#viewAll')!;
const openMeetings = document.querySelector<HTMLButtonElement>('#openMeetings')!;
const openSettings = document.querySelector<HTMLButtonElement>('#openSettings')!;
const signOut = document.querySelector<HTMLButtonElement>('#signOut')!;
const errorNotice = document.querySelector<HTMLElement>('#workspaceError')!;
const formatDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

let terminal = DEFAULT_TERMINAL;
let gateway = DEFAULT_GATEWAY;
let account: ExtensionAccount | undefined;
let view: View = 'home';
let request: AbortController | undefined;

function renderAccount(value: unknown) {
  account = storedAccount(value);
  welcome.hidden = !!account;
  workspace.hidden = !account;
  document.documentElement.dataset.signedIn = String(!!account);
  document.querySelector('#accountEmail')!.textContent = account?.email ?? '';
  document.querySelector<HTMLInputElement>('#terminalUrl')!.value = account?.terminal ?? '';
  document.querySelector<HTMLInputElement>('#botGatewayUrl')!.value = account?.gateway ?? '';
  meetingList.replaceChildren();
  showView('home');
  if (account) {
    apiKeyInput.value = '';
    apiKeyOption.open = false;
    setStatus('');
  }
}

function showView(next: View, focus?: HTMLElement) {
  request?.abort();
  view = next;
  for (const name of views) document.getElementById(name)!.hidden = name !== view;
  workspace.scrollTop = 0;
  errorNotice.hidden = true;
  errorNotice.textContent = '';
  focus?.focus();
}

function meetingState(status: string): [string, string?] {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'ended':
    case 'past': return ['Completed', 'completed'];
    case 'active':
    case 'recording': return ['In progress', 'progress'];
    case 'requested':
    case 'joining': return ['Joining', 'progress'];
    case 'awaiting_admission': return ['Waiting to join', 'progress'];
    case 'needs_help': return ['Needs attention', 'progress'];
    case 'processing': return ['Processing', 'progress'];
    case 'stopping': return ['Stopping', 'progress'];
    case 'stopped': return ['Stopped'];
    case 'failed': return ['Failed', 'failed'];
    default: return ['Unknown'];
  }
}

function appendMeeting(meeting: BotMeeting) {
  const row = meetingRow.content.cloneNode(true) as DocumentFragment;
  row.querySelector('strong')!.textContent = meeting.title.trim() || meeting.nativeMeetingId;
  const time = row.querySelector('time')!;
  const start = new Date(meeting.startMs);
  if (Number.isFinite(start.getTime())) {
    time.textContent = formatDate.format(start);
    time.dateTime = start.toISOString();
  } else time.hidden = true;
  const chip = row.querySelector<HTMLElement>('.status-chip')!;
  const [label, tone] = meetingState(meeting.status);
  chip.textContent = label;
  if (tone) chip.dataset.tone = tone;
  row.querySelector('button')!.addEventListener('click', () => void openTerminal(`meetings/${meeting.id}`));
  meetingList.append(row);
}

async function loadMeetings() {
  if (!account) return;
  request?.abort();
  const controller = new AbortController();
  request = controller;
  meetingList.replaceChildren();
  meetingNotice.hidden = false;
  retryMeetings.hidden = true;
  meetingStatus.textContent = 'Loading meetings…';
  try {
    const meetings = await listBotMeetings({ account, botGatewayUrl: account.gateway }, controller.signal);
    if (controller.signal.aborted) return;
    const start = ({ startMs }: BotMeeting) => {
      const date = new Date(startMs).getTime();
      return Number.isNaN(date) ? -Infinity : date;
    };
    for (const meeting of meetings.sort((a, b) => start(b) - start(a))) appendMeeting(meeting);
    meetingStatus.textContent = meetings.length ? '' : 'No recent meetings';
    meetingNotice.hidden = meetings.length > 0;
  } catch {
    if (controller.signal.aborted) return;
    meetingStatus.textContent = 'Could not load meetings.';
    retryMeetings.hidden = false;
  }
}

async function openTerminal(path = '') {
  const active = account;
  if (!active) return;
  try {
    const base = sessionEndpoints(active.terminal, active.gateway).terminal;
    await chrome.tabs.create({ url: new URL(path, `${base}/`).href });
    window.close();
  } catch {
    showWorkspaceError('Could not open TINA Terminal.');
  }
}

function showWorkspaceError(message: string) {
  errorNotice.hidden = false;
  errorNotice.textContent = message;
}

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.hidden = !message;
  status.dataset.error = String(error);
}

signIn.addEventListener('click', async () => {
  signIn.disabled = apiKeySubmit.disabled = true;
  signInLabel.textContent = 'Opening sign-in…';
  setStatus('');
  try {
    await sessionCommand({ action: 'login', terminal, gateway });
    if (!account) setStatus('Continue in the TINA sign-in window.');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not open TINA sign-in.', true);
  } finally {
    signIn.disabled = apiKeySubmit.disabled = false;
    signInLabel.textContent = signInText;
  }
});

document.querySelector('#apiKeyForm')!.addEventListener('submit', async event => {
  event.preventDefault();
  if (apiKeySubmit.disabled) return;
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus('Enter a TINA API key.', true);
    apiKeyInput.focus();
    return;
  }
  signIn.disabled = apiKeySubmit.disabled = true;
  apiKeySubmit.textContent = 'Connecting…';
  setStatus('');
  try {
    await sessionCommand({ action: 'login-api-key', terminal, gateway, apiKey });
    apiKeyInput.value = '';
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not connect with this API key.', true);
  } finally {
    signIn.disabled = apiKeySubmit.disabled = false;
    apiKeySubmit.textContent = 'Connect';
  }
});

openMeetings.addEventListener('click', () => {
  showView('meetings', document.getElementById('meetingsTitle')!);
  void loadMeetings();
});
openSettings.addEventListener('click', () => showView('settings', document.getElementById('settingsTitle')!));
for (const back of workspace.querySelectorAll('.back')) {
  back.addEventListener('click', () => showView('home', view === 'settings' ? openSettings : openMeetings));
}
retryMeetings.addEventListener('click', () => {
  document.getElementById('meetingsTitle')!.focus();
  void loadMeetings();
});
viewAll.addEventListener('click', () => void openTerminal());
document.querySelector('#openTerminal')!.addEventListener('click', () => void openTerminal());
signOut.addEventListener('click', async () => {
  const active = account;
  if (!active) return;
  signOut.disabled = true;
  try {
    await sessionCommand({ action: 'logout', key: active.key });
    if (account?.key === active.key) renderAccount(undefined);
  } catch {
    if (account?.key === active.key) showWorkspaceError('Could not sign out. Please try again.');
    else if (!account) setStatus('Signed out of the extension. TINA could not confirm sign-out on the server.', true);
  } finally {
    signOut.disabled = false;
    if (!account) signIn.focus();
  }
});

void chrome.storage.local.get([ACCOUNT_KEY, 'terminalUrl', 'botGatewayUrl']).then(values => {
  terminal = typeof values.terminalUrl === 'string' && values.terminalUrl.trim() ? values.terminalUrl : DEFAULT_TERMINAL;
  gateway = typeof values.botGatewayUrl === 'string' && values.botGatewayUrl.trim() ? values.botGatewayUrl : DEFAULT_GATEWAY;
  renderAccount(values[ACCOUNT_KEY]);
  signIn.disabled = apiKeySubmit.disabled = false;
}).catch(() => setStatus('Could not load TINA settings. Reopen the extension to try again.', true));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[ACCOUNT_KEY]) renderAccount(changes[ACCOUNT_KEY].newValue);
});
window.addEventListener('pagehide', () => request?.abort(), { once: true });
