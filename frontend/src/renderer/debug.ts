let locale: Locale = 'en';
let t: Messages = {};
let busy = false;
let awaitingTranscript = false;
let inputName = '';
let micLost = false;
let lastDefaultTitle = '';
let captureFinished = false;
let heardSound = false;
let minListenSeconds: number | null = null;
let pauseAutoCancelSeconds: number | null = null;
let pauseWarningSeconds: number | null = null;
let pauseWarnTimer: number | null = null;
let pauseCancelTimer: number | null = null;
let captureState: 'idle' | 'listening' | 'paused' = 'idle';
let uploadPaused = false;
let micOnly = false;
let waitingForMicrophone = false;
let meetingStartedAt: Date | null = null;
let summaryLines: string[] = [];

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function applyCopy(): void {
  document.documentElement.lang = locale;
  const title = document.getElementById('noteTitle') as HTMLInputElement;
  title.placeholder = t.newNote;
  title.setAttribute('aria-label', t.noteTitleLabel);
  if (!title.value.trim() || title.value === lastDefaultTitle) {
    title.value = t.newNote;
  }
  lastDefaultTitle = t.newNote;
  document.title = title.value.trim() || t.newNote;
  $('listenToggle').textContent = t.stop;
  $('generate').textContent = t.generate;
  $('duration').setAttribute('aria-label', t.duration);
  $('backToNotepad').setAttribute('aria-label', t.home);
  $('spikeMore').setAttribute('aria-label', t.moreActions);
  $('moveToTrash').textContent = t.moveToTrash;
  $('showTranscript').textContent = t.showTranscript;
  $('shareSummary').setAttribute('aria-label', t.shareSummary);
  $('copySummary').setAttribute('aria-label', t.copySummary);
  renderNoteMeta();
  const notes = document.getElementById('noteBody') as HTMLTextAreaElement;
  notes.setAttribute('aria-label', t.listenNotesLabel);
  notes.placeholder = t.listenNotesPlaceholder;
  $('levelPill').setAttribute('aria-label', t.levelPillLabel);
  renderInputDevice();
  renderDuration();
  applyGenerateEnabled();
}

function renderInputDevice(): void {
  $('deviceWarning').textContent = micLost ? t.errorMicLost : micOnly ? t.micOnly : '';
}

function noteBody(): HTMLTextAreaElement {
  return document.getElementById('noteBody') as HTMLTextAreaElement;
}

function recordingWorkspace(): { id: string; name: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    id: params.get('workspaceId') ?? '',
    name: params.get('workspaceName') ?? '',
  };
}

function renderNoteMeta(): void {
  const when = meetingStartedAt ?? new Date();
  const dateLocale = locale === 'es' ? 'es' : 'en';
  const date = when.toLocaleDateString(dateLocale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const time = when.toLocaleTimeString(dateLocale, { timeStyle: 'short' });
  $('noteWhen').textContent = `${date} · ${time}`;
  const folder = recordingWorkspace().name.trim();
  const folderLabel = $('noteFolder');
  folderLabel.textContent = folder;
  folderLabel.hidden = folder.length === 0;
}

function clearPauseLimit(): void {
  if (pauseWarnTimer != null) {
    window.clearTimeout(pauseWarnTimer);
    pauseWarnTimer = null;
  }
  if (pauseCancelTimer != null) {
    window.clearTimeout(pauseCancelTimer);
    pauseCancelTimer = null;
  }
}

function armPauseLimit(): void {
  clearPauseLimit();
  if (pauseAutoCancelSeconds == null || pauseAutoCancelSeconds <= 0) {
    return;
  }
  const warning = pauseWarningSeconds ?? 0;
  const warnIn = Math.max(0, pauseAutoCancelSeconds - warning) * 1000;
  pauseWarnTimer = window.setTimeout(() => {
    $('error').textContent = t.pauseWarning;
  }, warnIn);
  pauseCancelTimer = window.setTimeout(() => {
    void moveToTrash();
  }, pauseAutoCancelSeconds * 1000);
}

let summaryTypeToken = 0;
let copyTimer: number | null = null;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

type SummaryKind = 'h' | 'ul' | 'ol';
type SummaryItem = { kind: SummaryKind; depth: number; text: string };

function summaryItems(lines: string[]): SummaryItem[] {
  const items: SummaryItem[] = [];
  for (const line of lines) {
    const indent = line.match(/^ */)?.[0].length ?? 0;
    const depth = Math.min(3, Math.floor(indent / 2));
    const text = line.trim();
    if (!text) {
      continue;
    }
    if (text.startsWith('#')) {
      items.push({ kind: 'h', depth: 0, text: text.replace(/^#+\s*/, '') });
      continue;
    }
    const numbered = text.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      items.push({ kind: 'ol', depth, text: numbered[1] });
      continue;
    }
    const bullet = text.match(/^[•\-*]\s+(.*)$/);
    items.push({ kind: 'ul', depth, text: bullet ? bullet[1] : text });
  }
  return items;
}

function summaryPlainText(lines: string[]): string {
  const blocks: string[] = [];
  let numbered = false;
  let step = 0;
  for (const line of lines) {
    const indent = line.match(/^ */)?.[0].length ?? 0;
    const depth = Math.min(3, Math.floor(indent / 2));
    const text = line.trim();
    if (!text) {
      continue;
    }
    if (text.startsWith('#')) {
      numbered = false;
      step = 0;
      if (blocks.length > 0) {
        blocks.push('');
      }
      blocks.push(text.replace(/^#+\s*/, ''));
      continue;
    }
    const stepMatch = text.match(/^\d+[.)]\s+(.*)$/);
    const pad = '  '.repeat(depth);
    if (stepMatch) {
      if (!numbered) {
        numbered = true;
        step = 0;
      }
      step += 1;
      blocks.push(`${pad}${step}. ${stepMatch[1]}`);
      continue;
    }
    numbered = false;
    const bullet = text.match(/^[•\-*]\s+(.*)$/);
    blocks.push(`${pad}• ${bullet ? bullet[1] : text}`);
  }
  return blocks.join('\n').trim();
}

function appendSummaryItem(view: HTMLElement, item: SummaryItem, list: HTMLElement | null): HTMLElement {
  if (item.kind === 'h') {
    const heading = document.createElement('h2');
    heading.className = 'summary-heading';
    view.append(heading);
    return heading;
  }
  const row = document.createElement('li');
  if (item.depth > 0) {
    row.className = 'nested';
  }
  list?.append(row);
  return row;
}

function openSummaryList(view: HTMLElement, kind: 'ul' | 'ol'): HTMLElement {
  const list = document.createElement(kind);
  list.className = kind === 'ul' ? 'summary-list' : 'summary-steps';
  view.append(list);
  return list;
}

function scrollSummaryToStart(): void {
  const scroller = summaryScroller();
  if (scroller) {
    scroller.scrollTop = 0;
  }
}

function summaryScroller(): HTMLElement | null {
  const scroller = document.querySelector('.spike-copy');
  return scroller instanceof HTMLElement ? scroller : null;
}

async function typeInto(node: HTMLElement, text: string, token: number): Promise<boolean> {
  const chunks = Math.max(1, Math.min(8, text.length || 1));
  const step = Math.max(1, Math.ceil(text.length / chunks));
  const gap = Math.min(99, Math.max(text.length === 0 ? 13.2 : 39.6, text.length * 1.76)) / chunks;
  for (let count = step; count < text.length; count += step) {
    if (token !== summaryTypeToken) {
      return false;
    }
    node.textContent = text.slice(0, count);
    node.scrollIntoView({ block: 'nearest' });
    await wait(gap);
  }
  if (token !== summaryTypeToken) {
    return false;
  }
  node.textContent = text;
  node.scrollIntoView({ block: 'nearest' });
  return true;
}

function paintSummary(view: HTMLElement, items: SummaryItem[]): void {
  view.replaceChildren();
  let list: HTMLElement | null = null;
  let listKind: 'ul' | 'ol' | null = null;
  for (const item of items) {
    if (item.kind === 'h') {
      list = null;
      listKind = null;
    } else if (listKind !== item.kind) {
      list = openSummaryList(view, item.kind);
      listKind = item.kind;
    }
    appendSummaryItem(view, item, list).textContent = item.text;
  }
  scrollSummaryToStart();
}

function showSummary(note: NoteRecord): void {
  const items = summaryItems(note.summaryText);
  const view = $('summaryView');
  const token = ++summaryTypeToken;
  summaryLines = note.summaryText;
  noteBody().hidden = true;
  $('transcriptView').hidden = true;
  view.hidden = false;
  enableSummaryActions(note);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || items.length === 0) {
    paintSummary(view, items);
    return;
  }
  view.replaceChildren();
  void (async () => {
    let list: HTMLElement | null = null;
    let listKind: 'ul' | 'ol' | null = null;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind === 'h') {
        list = null;
        listKind = null;
      } else if (listKind !== item.kind) {
        list = openSummaryList(view, item.kind);
        listKind = item.kind;
      }
      const node = appendSummaryItem(view, item, list);
      const kept = await typeInto(node, item.text, token);
      if (!kept) {
        return;
      }
      if (index < items.length - 1) {
        await wait(19.8);
      }
    }
    if (token === summaryTypeToken) {
      scrollSummaryToStart();
    }
  })();
}

function formatTurnTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const remain = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remain).padStart(2, '0')}`;
}

function renderTranscript(note: NoteRecord): void {
  const view = $('transcriptView');
  view.replaceChildren();
  const turns =
    note.transcriptTurns.length > 0
      ? note.transcriptTurns
      : note.transcriptText?.trim()
        ? [{ source: 'mix' as const, startSec: 0, endSec: note.durationSeconds ?? 0, text: note.transcriptText.trim() }]
        : [];
  const chat = document.createElement('div');
  chat.className = 'chat';
  let lastStamp = '';
  for (const turn of turns) {
    const text = turn.text.trim();
    if (!text) {
      continue;
    }
    const stamp = formatTurnTime(turn.startSec);
    if (stamp !== lastStamp) {
      const time = document.createElement('p');
      time.className = 'turn-time';
      time.textContent = stamp;
      chat.append(time);
      lastStamp = stamp;
    }
    const bubble = document.createElement('p');
    bubble.className = `bubble ${turn.source}`;
    bubble.textContent = text;
    chat.append(bubble);
  }
  view.append(chat);
}

function toggleTranscript(): void {
  const transcript = $('transcriptView');
  const summary = $('summaryView');
  const button = $('showTranscript') as HTMLButtonElement;
  const opening = transcript.hidden;
  transcript.hidden = !opening;
  summary.hidden = opening;
  button.textContent = opening ? t.backToSummary : t.showTranscript;
}

function copyWithSelection(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {
      copyWithSelection(text);
    });
  }
  copyWithSelection(text);
  return Promise.resolve();
}

function enableSummaryActions(note: NoteRecord): void {
  const share = $('shareSummary') as HTMLButtonElement;
  const copy = $('copySummary') as HTMLButtonElement;
  const transcript = $('showTranscript') as HTMLButtonElement;
  const hasTranscript = note.transcriptTurns.length > 0 || Boolean(note.transcriptText?.trim());
  share.disabled = false;
  copy.disabled = false;
  transcript.disabled = !hasTranscript;
  transcript.textContent = t.showTranscript;
  if (hasTranscript) {
    renderTranscript(note);
  }
  share.onclick = () => openShareDialog(note.id);
  transcript.onclick = () => {
    if (transcript.disabled) {
      return;
    }
    toggleTranscript();
  };
  copy.onclick = () => {
    void writeClipboard(summaryPlainText(summaryLines)).then(() => {
      copy.classList.add('copied');
      copy.setAttribute('aria-label', t.copiedSummary);
      if (copyTimer != null) {
        window.clearTimeout(copyTimer);
      }
      copyTimer = window.setTimeout(() => {
        copy.classList.remove('copied');
        copy.setAttribute('aria-label', t.copySummary);
      }, 1500);
    });
  };
}

const SHARE_RECIPIENTS_KEY = 'pith.shareRecipients';
const SHARE_RECIPIENT_CAP = 10;
let shareChips: string[] = [];
let shareSuggestIndex = 0;
let toastToken = 0;

function isShareEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function shareInput(): HTMLInputElement {
  return document.getElementById('shareEmails') as HTMLInputElement;
}

function loadShareRecipients(): string[] {
  try {
    const raw = localStorage.getItem(SHARE_RECIPIENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string' && isShareEmail(item));
  } catch {
    return [];
  }
}

function rememberShareRecipients(emails: string[]): void {
  const next = [...emails];
  for (const saved of loadShareRecipients()) {
    if (!next.includes(saved)) {
      next.push(saved);
    }
  }
  localStorage.setItem(SHARE_RECIPIENTS_KEY, JSON.stringify(next.slice(0, 40)));
}

function setShareHint(message: string, warn = false): void {
  const hint = $('shareHint');
  hint.textContent = message;
  hint.classList.toggle('warn', warn);
}

function shareSuggestions(): string[] {
  const query = shareInput().value.trim().toLowerCase();
  if (!query) {
    return [];
  }
  return loadShareRecipients()
    .filter((email) => email.startsWith(query) && email !== query && !shareChips.includes(email))
    .slice(0, 5);
}

function renderShareChips(): void {
  const field = $('shareField');
  const input = shareInput();
  field.querySelectorAll('.share-chip').forEach((node) => node.remove());
  for (const email of shareChips) {
    const chip = document.createElement('span');
    chip.className = 'share-chip';
    const label = document.createElement('span');
    label.textContent = email;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'share-chip-remove';
    remove.setAttribute('aria-label', `${t.shareRemove} ${email}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      shareChips = shareChips.filter((item) => item !== email);
      renderShareChips();
      renderShareSuggestions();
      input.focus();
    });
    chip.append(label, remove);
    field.insertBefore(chip, input);
  }
  input.placeholder = shareChips.length === 0 ? t.shareEmailsPlaceholder : '';
}

function renderShareSuggestions(): void {
  const list = $('shareSuggest');
  const input = shareInput();
  const matches = shareSuggestions();
  list.replaceChildren();
  if (matches.length === 0) {
    list.hidden = true;
    shareSuggestIndex = 0;
    input.removeAttribute('aria-activedescendant');
    return;
  }
  if (shareSuggestIndex >= matches.length) {
    shareSuggestIndex = 0;
  }
  const query = input.value.trim().toLowerCase();
  matches.forEach((email, index) => {
    const item = document.createElement('li');
    item.id = `shareSuggest-${index}`;
    item.setAttribute('role', 'presentation');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'share-option';
    button.setAttribute('role', 'option');
    const matched = document.createElement('span');
    matched.className = 'share-match';
    matched.textContent = email.slice(0, query.length);
    button.append(matched, document.createTextNode(email.slice(query.length)));
    if (index === shareSuggestIndex) {
      button.classList.add('active');
      button.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', item.id);
    }
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      commitShareEmail(email);
      input.focus();
    });
    item.append(button);
    list.append(item);
  });
  list.hidden = false;
}

function commitShareEmail(raw: string): boolean {
  const email = raw.trim().toLowerCase().replace(/[,;]+$/, '');
  if (!isShareEmail(email)) {
    return false;
  }
  if (!shareChips.includes(email)) {
    if (shareChips.length >= SHARE_RECIPIENT_CAP) {
      setShareHint(t.shareFull, true);
      return false;
    }
    shareChips.push(email);
  }
  shareInput().value = '';
  shareSuggestIndex = 0;
  setShareHint(t.shareHint);
  renderShareChips();
  renderShareSuggestions();
  return true;
}

function acceptShareSuggestion(): void {
  const chosen = shareSuggestions()[shareSuggestIndex];
  if (chosen) {
    commitShareEmail(chosen);
  }
}

function showToast(message: string): void {
  const toast = $('toast');
  const token = ++toastToken;
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.remove('show');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (token === toastToken) {
        toast.classList.add('show');
      }
    });
  });
  window.setTimeout(() => {
    if (token !== toastToken) {
      return;
    }
    const hide = (event: TransitionEvent) => {
      if (event.propertyName !== 'transform' || toast.classList.contains('show')) {
        return;
      }
      toast.hidden = true;
      toast.removeEventListener('transitionend', hide);
    };
    toast.addEventListener('transitionend', hide);
    toast.classList.remove('show');
    window.setTimeout(() => {
      if (token === toastToken && !toast.classList.contains('show')) {
        toast.hidden = true;
      }
    }, 800);
  }, 2600);
}

function closeShareDialog(): void {
  $('shareDialog').hidden = true;
  shareChips = [];
  shareSuggestIndex = 0;
  const input = shareInput();
  input.value = '';
  renderShareChips();
  renderShareSuggestions();
}

function shareFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('sign_in_required')) {
    return t.signInRequired;
  }
  if (code.includes('mail_not_configured')) {
    return t.errorMailNotConfigured;
  }
  return t.errorGeneric;
}

function openShareDialog(noteId: string): void {
  const dialog = $('shareDialog');
  const send = document.getElementById('shareSend') as HTMLButtonElement;
  const cancel = document.getElementById('shareCancel') as HTMLButtonElement;
  $('shareTitle').textContent = t.shareTitle;
  $('shareBody').textContent = t.shareBody;
  send.textContent = t.shareSend;
  cancel.textContent = t.shareCancel;
  send.disabled = false;
  shareChips = [];
  shareSuggestIndex = 0;
  shareInput().value = '';
  setShareHint(t.shareHint);
  renderShareChips();
  renderShareSuggestions();
  cancel.onclick = () => closeShareDialog();
  send.onclick = () => {
    const draft = shareInput().value.trim();
    if (draft && !isShareEmail(draft.toLowerCase())) {
      setShareHint(t.shareInvalid, true);
      shareInput().focus();
      return;
    }
    if (draft && !commitShareEmail(draft)) {
      shareInput().focus();
      return;
    }
    if (shareChips.length === 0) {
      setShareHint(t.shareNeedEmail, true);
      shareInput().focus();
      return;
    }
    const emails = [...shareChips];
    send.disabled = true;
    void pith.notes
      .share(noteId, emails)
      .then(() => {
        rememberShareRecipients(emails);
        closeShareDialog();
        showToast(t.shareSent);
      })
      .catch((error: unknown) => {
        send.disabled = false;
        setShareHint(shareFailure(error), true);
      });
  };
  dialog.hidden = false;
  shareInput().focus();
}

function bindShareComposer(): void {
  const input = shareInput();
  $('shareField').addEventListener('click', (event) => {
    if (event.target === $('shareField')) {
      input.focus();
    }
  });
  input.addEventListener('input', () => {
    shareSuggestIndex = 0;
    if ($('shareHint').classList.contains('warn')) {
      setShareHint(t.shareHint);
    }
    renderShareSuggestions();
  });
  input.addEventListener('keydown', (event) => {
    const matches = shareSuggestions();
    if (event.key === 'Tab' && matches.length > 0) {
      event.preventDefault();
      acceptShareSuggestion();
      return;
    }
    if (event.key === 'ArrowDown' && matches.length > 0) {
      event.preventDefault();
      shareSuggestIndex = (shareSuggestIndex + 1) % matches.length;
      renderShareSuggestions();
      return;
    }
    if (event.key === 'ArrowUp' && matches.length > 0) {
      event.preventDefault();
      shareSuggestIndex = (shareSuggestIndex - 1 + matches.length) % matches.length;
      renderShareSuggestions();
      return;
    }
    if (event.key === 'Enter' || event.key === ',' || event.key === ';' || event.key === ' ') {
      const draft = input.value.trim();
      if (!draft && event.key !== 'Enter') {
        event.preventDefault();
        return;
      }
      if (isShareEmail(draft.toLowerCase())) {
        event.preventDefault();
        commitShareEmail(draft);
        return;
      }
      if (event.key === 'Enter' && matches.length > 0) {
        event.preventDefault();
        acceptShareSuggestion();
        return;
      }
      if (event.key !== 'Enter') {
        event.preventDefault();
        if (draft) {
          setShareHint(t.shareInvalid, true);
        }
      }
    }
    if (event.key === 'Backspace' && input.value === '' && shareChips.length > 0) {
      shareChips.pop();
      renderShareChips();
      renderShareSuggestions();
    }
  });
  input.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!/[\s,;]/.test(text)) {
      return;
    }
    event.preventDefault();
    let invalid = false;
    for (const part of text.split(/[\s,;]+/)) {
      if (!part.trim()) {
        continue;
      }
      if (!commitShareEmail(part)) {
        invalid = true;
      }
    }
    if (invalid) {
      setShareHint(t.shareInvalid, true);
    }
  });
  input.addEventListener('blur', () => {
    const draft = input.value.trim();
    if (draft && isShareEmail(draft.toLowerCase())) {
      commitShareEmail(draft);
    }
  });
}

function closeSpikeMenu(): void {
  $('spikeMenuPop').hidden = true;
  $('spikeMore').setAttribute('aria-expanded', 'false');
}

async function moveToTrash(): Promise<void> {
  clearPauseLimit();
  closeSpikeMenu();
  const state = await pith.capture.getState();
  if (state === 'listening' || state === 'paused') {
    await withBusy(async () => {
      pauseTimer();
      await pith.capture.cancel();
      if (liveNoteId) {
        await pith.notes.cancel(liveNoteId).catch(() => undefined);
        liveNoteId = null;
      }
      await pith.capture.disarm();
      resetTimer();
    });
    const next = await pith.capture.getState();
    if (next !== 'idle') {
      return;
    }
  }
  pith.shell.openNotepad();
}

function applyDevice(device: CaptureDevice): void {
  inputName = device.inputName || '';
  micLost = Boolean(device.lost);
  renderInputDevice();
}

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const known = [
    'helper_missing',
    'helper_exit',
    'helper_timeout',
    'mic_denied',
    'macos_only',
    'no_spike_key',
    'empty',
    'too_short',
    'config_failed',
    'no_google_client',
    'auth_denied',
    'auth_failed',
    'auth_timeout',
    'safe_storage_unavailable',
    'already_running',
    'not_listening',
    'upload_paused',
    'backend_unavailable',
    'slices_missing',
    'request_timeout',
    'no_source',
    'File too large',
    'no_last_mix',
  ];
  for (const code of known) {
    if (raw.includes(code)) {
      return code;
    }
  }
  return raw;
}

function setError(code: string): void {
  const mapped =
    code === 'helper_missing'
      ? t.errorHelperMissing
      : code === 'helper_exit' || code === 'helper_timeout'
        ? t.errorHelperExit
      : code === 'mic_denied'
        ? t.errorMicDenied
        : code === 'macos_only'
          ? t.errorMacosOnly
          : code === 'no_spike_key'
            ? t.errorNoKey
              : code === 'empty'
              ? t.errorEmpty
              : code === 'summary_failed'
                ? t.summaryFailed
              : code === 'too_short'
                ? t.errorTooShort.replace(
                    '{seconds}',
                    String(minListenSeconds ?? ''),
                  )
                : code === 'config_failed'
                  ? t.errorConfig
                : code === 'File too large'
                  ? t.errorFileTooLarge
                  : code === 'no_last_mix'
                    ? t.errorNoLastMix
                  : code === 'not_listening'
                    ? t.errorNotListening
                  : code === 'upload_paused'
                    ? t.uploadPaused
                  : code === 'backend_unavailable' || code === 'request_timeout'
                    ? t.backendUnavailable
                  : code === 'slices_missing'
                    ? t.slicesMissing
                  : code === 'no_source'
                    ? t.noSource
            : code === 'mic_format'
                ? t.errorMicDenied
            : code === 'no_google_client'
              ? t.errorNoGoogleClient
              : code === 'auth_denied' ||
                  code === 'auth_failed' ||
                  code === 'auth_timeout' ||
                  code === 'safe_storage_unavailable'
                ? t.errorAuth
              : code.startsWith('spike_') || code.includes(' ')
                ? `${t.errorSpike}: ${code}`
                : t.errorGeneric;
  $('error').textContent = mapped;
}

async function syncButtons(): Promise<void> {
  captureState = await pith.capture.getState();
  applyGenerateEnabled();
}

function listenedEnough(): boolean {
  return minListenSeconds != null && recordedSeconds() + 1e-6 >= minListenSeconds;
}

let generating = false;

function applyGenerateEnabled(): void {
  const toggle = $('listenToggle') as HTMLButtonElement;
  const generate = $('generate') as HTMLButtonElement;
  toggle.textContent = captureState === 'paused' ? t.resume : t.stop;
  toggle.disabled =
    busy || captureFinished || (captureState !== 'listening' && captureState !== 'paused');
  const recording = captureState === 'listening' || captureState === 'paused';
  generate.disabled =
    busy ||
    captureFinished ||
    (!uploadPaused && !recording) ||
    (!uploadPaused && !listenedEnough());
  generate.textContent = generating ? t.generating : t.generate;
  generate.classList.toggle('generating', generating);
  $('levelPill').hidden = false;
}

function formatClock(totalSeconds: number): string {
  const whole = Math.floor(Math.max(0, totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

let recordedMs = 0;
let runningSince: number | null = null;
let tickId: number | null = null;

function recordedSeconds(): number {
  const extra = runningSince == null ? 0 : Date.now() - runningSince;
  return (recordedMs + extra) / 1000;
}

function renderDuration(seconds = recordedSeconds()): void {
  const clock = formatClock(seconds);
  const el = $('duration');
  el.textContent = clock;
  el.setAttribute('datetime', `PT${Math.floor(Math.max(0, seconds))}S`);
  el.setAttribute('data-running', runningSince != null ? 'true' : 'false');
  applyGenerateEnabled();
}

let configRetryAt = 0;
let configError = false;

async function ensureMinListenConfig(): Promise<void> {
  if (minListenSeconds != null) {
    return;
  }
  const now = Date.now();
  if (now < configRetryAt) {
    return;
  }
  configRetryAt = now + 2000;
  try {
    const config = await pith.getConfig();
    minListenSeconds = config.minListenSeconds;
    pauseAutoCancelSeconds = config.pauseAutoCancelSeconds;
    pauseWarningSeconds = config.pauseWarningSeconds;
    if (configError) {
      configError = false;
      if ($('error').textContent === t.errorConfig) {
        $('error').textContent = '';
      }
    }
    applyGenerateEnabled();
  } catch {
    minListenSeconds = null;
  }
}

function ensureTicker(): void {
  if (tickId != null) {
    return;
  }
  tickId = window.setInterval(() => {
    void ensureMinListenConfig();
    renderDuration();
  }, 200);
}

function stopTicker(): void {
  if (tickId != null) {
    clearInterval(tickId);
    tickId = null;
  }
}

function resetTimer(): void {
  heardSound = false;
  recordedMs = 0;
  runningSince = null;
  stopTicker();
  renderDuration(0);
}

function pauseTimer(): void {
  if (runningSince != null) {
    recordedMs += Date.now() - runningSince;
    runningSince = null;
  }
  stopTicker();
  renderDuration();
}

function resumeTimer(): void {
  if (runningSince == null) {
    runningSince = Date.now();
  }
  ensureTicker();
  renderDuration();
}

function startTimer(): void {
  recordedMs = 0;
  runningSince = Date.now();
  ensureTicker();
  renderDuration();
}

function freezeTimer(seconds: number): void {
  recordedMs = Math.max(0, seconds) * 1000;
  runningSince = null;
  stopTicker();
  renderDuration(seconds);
}

const BAR_REST = [0.28, 0.45, 0.32];
const BAR_PEAK = [0.78, 1, 0.86];

function setBars(container: HTMLElement, level: number): void {
  const max = container.clientHeight;
  if (max <= 0) {
    return;
  }
  const clamped = Math.min(1, Math.max(0, level));
  const bars = container.querySelectorAll('.bar');
  bars.forEach((bar, index) => {
    const rest = BAR_REST[index] ?? 0.3;
    const peak = BAR_PEAK[index] ?? 1;
    (bar as HTMLElement).style.height = `${(rest + (peak - rest) * clamped) * max}px`;
  });
}

function applyLevels(levels: CaptureLevels): void {
  const mixed = Math.max(levels.mic, levels.system);
  setBars($('mixBars'), mixed);
  $('levelPill').setAttribute('aria-valuenow', String(mixed.toFixed(2)));
  if (
    !heardSound &&
    !captureFinished &&
    captureState === 'listening' &&
    mixed > 0
  ) {
    heardSound = true;
    startTimer();
  }
}

function applyStart(result: { inputName: string; systemAudioEnabled?: boolean }): void {
  if (meetingStartedAt == null) {
    meetingStartedAt = new Date();
  }
  micOnly = result.systemAudioEnabled === false;
  renderNoteMeta();
  captureState = 'listening';
  applyDevice({ inputName: result.inputName, lost: !result.inputName });
  renderInputDevice();
  applyGenerateEnabled();
}

function watchMicrophoneGrant(): void {
  if (waitingForMicrophone) {
    return;
  }
  waitingForMicrophone = true;
  window.addEventListener(
    'focus',
    () => {
      waitingForMicrophone = false;
      if (captureFinished || captureState === 'listening' || captureState === 'paused') {
        return;
      }
      void withBusy(() => startRecording());
    },
    { once: true },
  );
}

let liveNoteId: string | null = null;

function noteTitleValue(): string | null {
  const value = (document.getElementById('noteTitle') as HTMLInputElement).value.trim();
  if (!value || value === t.newNote) {
    return null;
  }
  return value;
}

async function leaveRecording(): Promise<void> {
  if (generating) {
    await saveLiveTitle().catch(() => undefined);
    pith.shell.openNotepad(true);
    return;
  }
  const noteId = liveNoteId;
  if (noteId && !captureFinished) {
    clearPauseLimit();
    try {
      await pith.capture.cancel();
    } catch {
      // The helper is already idle after Home starts closing the recorder.
    }
    await pith.notes.cancel(noteId).catch(() => undefined);
    liveNoteId = null;
    await pith.capture.disarm().catch(() => undefined);
  } else {
    await saveLiveTitle().catch(() => undefined);
  }
  pith.shell.openNotepad();
}

async function saveLiveTitle(): Promise<void> {
  if (!liveNoteId) {
    return;
  }
  await pith.notes.rename(liveNoteId, noteTitleValue()).catch((error: unknown) => {
    setError(errorCode(error));
  });
}

async function bindLiveNote(): Promise<void> {
  if (liveNoteId) {
    return;
  }
  let workspaceId = recordingWorkspace().id;
  if (!workspaceId) {
    const listed = await pith.notes.listWorkspaces();
    workspaceId = listed[0]?.id ?? '';
  }
  if (!workspaceId) {
    return;
  }
  const title = (document.getElementById('noteTitle') as HTMLInputElement).value.trim();
  const created = await pith.notes.create(workspaceId, title === t.newNote ? null : title || null);
  liveNoteId = created.id;
  await pith.capture.arm(created.id);
}

async function startRecording(): Promise<void> {
  if (captureFinished) {
    return;
  }
  resetTimer();
  try {
    applyStart(await pith.capture.start());
    await bindLiveNote();
  } catch (error) {
    if (errorCode(error) !== 'mic_denied') {
      throw error;
    }
    $('error').textContent = '';
    const granted = await pith.permissions.promptMicrophone();
    if (!granted) {
      watchMicrophoneGrant();
      return;
    }
    try {
      applyStart(await pith.capture.start());
    await bindLiveNote();
    } catch (retryError) {
      if (errorCode(retryError) !== 'mic_denied') {
        throw retryError;
      }
      $('error').textContent = '';
      await pith.permissions.promptMicrophone();
      watchMicrophoneGrant();
    }
  }
}

async function withBusy(fn: () => Promise<void>): Promise<void> {
  if (busy) {
    return;
  }
  busy = true;
  $('error').textContent = '';
  try {
    await syncButtons();
    await fn();
  } catch (error) {
    setError(errorCode(error));
  } finally {
    busy = false;
    awaitingTranscript = false;
    await syncButtons().catch(() => undefined);
  }
}

async function init(): Promise<void> {
  locale = await pith.getLocale();
  t = await pith.getMessages(locale);
  applyCopy();
  bindShareComposer();
  try {
    const config = await pith.getConfig();
    minListenSeconds = config.minListenSeconds;
    pauseAutoCancelSeconds = config.pauseAutoCancelSeconds;
    pauseWarningSeconds = config.pauseWarningSeconds;
  } catch {
    minListenSeconds = null;
    configError = true;
    setError('config_failed');
  }
  pith.capture.onLevels(applyLevels);
  pith.capture.onDevice(applyDevice);
  window.addEventListener('unhandledrejection', (event) => {
    setError(errorCode(event.reason));
  });
  await syncButtons();
  const pending = await pith.capture.pending().catch(() => null);
  if (pending?.noteId) {
    liveNoteId = pending.noteId;
    uploadPaused = true;
    setError('upload_paused');
    applyGenerateEnabled();
  } else {
    await withBusy(async () => {
      try {
        await startRecording();
      } catch (error) {
        resetTimer();
        throw error;
      }
    });
  }

  $('backToNotepad').addEventListener('click', () => {
    void leaveRecording();
  });
  const title = document.getElementById('noteTitle') as HTMLInputElement;
  title.addEventListener('focus', () => {
    if (title.value === t.newNote) {
      title.select();
    }
  });
  title.addEventListener('input', () => {
    document.title = title.value.trim() || t.newNote;
  });
  title.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    void saveLiveTitle();
    noteBody().focus();
  });
  title.addEventListener('blur', () => {
    void saveLiveTitle();
  });
  $('spikeMore').addEventListener('click', (event) => {
    event.stopPropagation();
    const pop = $('spikeMenuPop');
    const willOpen = pop.hidden;
    closeSpikeMenu();
    if (willOpen) {
      pop.hidden = false;
      $('spikeMore').setAttribute('aria-expanded', 'true');
    }
  });
  $('spikeMenu').addEventListener('click', (event) => event.stopPropagation());
  $('moveToTrash').addEventListener('click', (event) => {
    event.stopPropagation();
    void moveToTrash();
  });
  document.addEventListener('click', () => closeSpikeMenu());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSpikeMenu();
    }
  });
  $('listenToggle').addEventListener('click', () => {
    const stopping = captureState === 'listening';
    if (stopping) {
      pauseTimer();
    }
    void withBusy(async () => {
      const state = await pith.capture.getState();
      if (state === 'listening') {
        pauseTimer();
        try {
          await pith.capture.pause();
          armPauseLimit();
        } catch (error) {
          if (heardSound) {
            resumeTimer();
          }
          throw error;
        }
        return;
      }
      if (stopping) {
        return;
      }
      if (state === 'paused') {
        if (heardSound) {
          resumeTimer();
        }
        try {
          clearPauseLimit();
          await pith.capture.resume();
        } catch (error) {
          pauseTimer();
          armPauseLimit();
          throw error;
        }
      }
    });
  });
  $('generate').addEventListener('click', () => {
    if (!listenedEnough()) {
      return;
    }
    pauseTimer();
    clearPauseLimit();
    generating = true;
    applyGenerateEnabled();
    void withBusy(async () => {
      awaitingTranscript = true;
      const typedNotes = noteBody().value.trim();
      try {
        await bindLiveNote();
        if (!liveNoteId) {
          throw new Error('notes_workspace');
        }
      const noteId = liveNoteId;
      try {
        await saveLiveTitle();
        const result = await pith.capture.stop(noteId, typedNotes);
          liveNoteId = null;
          captureFinished = true;
          freezeTimer(recordedSeconds());
          applyLevels({ mic: 0, system: 0 });
          if (result.startedAt) {
            const started = new Date(result.startedAt);
            if (!Number.isNaN(started.getTime())) {
              meetingStartedAt = started;
              renderNoteMeta();
            }
          }
          uploadPaused = false;
          if (result.summaryText.length > 0) {
            showSummary(result);
          } else {
            setError('summary_failed');
          }
        } catch (error) {
          const code = errorCode(error);
          uploadPaused = code !== 'too_short' && code !== 'empty';
          if (code === 'too_short' || code === 'empty') {
            await pith.notes.cancel(noteId).catch(() => undefined);
            liveNoteId = null;
          }
          if (!captureFinished) {
            freezeTimer(recordedSeconds());
          }
          throw error;
        }
      } finally {
        generating = false;
      }
    });
  });
}

void init();

export {};
