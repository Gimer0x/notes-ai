type NoteStatus = 'ready' | 'processing' | 'failed' | 'listening' | 'paused';

type Me = {
  email: string;
  plan: 'free' | 'paid';
  planInterval: 'month' | 'year' | null;
  remainingSeconds: number;
  remainingNotes: number | null;
};

type Workspace = {
  id: string;
  name: string;
  icon: string;
  createdAt: string;
  updatedAt: string;
};

const WORKSPACE_SYMBOLS: { id: string; body: string }[] = [
  { id: 'circle', body: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.6"/>' },
  { id: 'home', body: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z"/>' },
  { id: 'user', body: '<circle cx="12" cy="8" r="3.2"/><path d="M5 19.2c.8-3 3.4-4.7 7-4.7s6.2 1.7 7 4.7"/>' },
  { id: 'briefcase', body: '<rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7M3 12h18"/>' },
  { id: 'star', body: '<path d="m12 3.5 2.2 4.6 5 .7-3.6 3.5.9 5.1L12 15.2 7.5 17.4l.9-5.1L4.8 8.8l5-.7L12 3.5Z"/>' },
  { id: 'heart', body: '<path d="M12 19s-6.5-4.1-6.5-8.2A3.4 3.4 0 0 1 12 8a3.4 3.4 0 0 1 6.5 2.8C18.5 14.9 12 19 12 19Z"/>' },
  { id: 'bookmark', body: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.2L6 20V5.5a1 1 0 0 1 1-1Z"/>' },
  { id: 'folder', body: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z"/>' },
  { id: 'calendar', body: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3.5V7M16 3.5V7M4 10h16"/>' },
  { id: 'flag', body: '<path d="M6 20V4.5M6 5h11l-2 3.5 2 3.5H6"/>' },
  { id: 'book', body: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v16H7.5A2.5 2.5 0 0 0 5 21.5V5.5Z"/><path d="M5 18.2A2.5 2.5 0 0 1 7.5 16H19"/>' },
  { id: 'chat', body: '<path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H10l-4 3.5V6.5Z"/>' },
];
type TranscriptTurn = {
  source: 'mic' | 'system' | 'mix';
  startSec: number;
  endSec: number;
  text: string;
};

type Note = {
  id: string;
  workspaceId: string;
  title: string | null;
  status: NoteStatus;
  summaryText: string[];
  transcriptText: string | null;
  transcriptTurns: TranscriptTurn[];
  language: 'en' | 'es' | null;
  errorCode: 'upload' | 'stt' | 'gpt' | null;
  errorMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
};

type View =
  | { name: 'home' }
  | { name: 'profile' }
  | { name: 'workspace'; id: string }
  | { name: 'note'; workspaceId: string; noteId: string }
  | { name: 'transcript'; workspaceId: string; noteId: string }
  | { name: 'listen'; workspaceId: string; noteId: string };

type PendingDialog =
  | { kind: 'delete-note'; note: Note }
  | { kind: 'delete-workspace'; id: string }
  | { kind: 'info' };

const $ = (id: string) => document.getElementById(id) as HTMLElement;

let locale: Locale = 'en';
let t: Messages = {};
let me: Me | null = null;
let view: View = { name: 'home' };
let listenSeconds = 0;
let heardSound = false;
let listsReady = false;
let liveNoteId: string | null = null;
let captureState: 'idle' | 'listening' | 'paused' = 'idle';
let listenTimer: number | null = null;
let searchQuery = '';
let symbolPickerId: string | null = null;
let addingWorkspace = false;
let pendingDialog: PendingDialog | null = null;

let workspaces: Workspace[] = [];
let notes: Note[] = [];

function noteTitle(note: Note): string {
  return note.title?.trim() || t.untitled;
}

function stripNumeration(line: string): string {
  let text = line.trim().replace(/^#+\s*/, '');
  let previous = '';
  while (text && text !== previous) {
    previous = text;
    text = text.replace(/^(?:[-*•]+|\d+[.)\-:]?)\s+/, '').trim();
  }
  return text;
}

function titleFromSummary(lines: string[]): string | null {
  for (const line of lines) {
    const stripped = stripNumeration(line);
    if (stripped) {
      return stripped.slice(0, 120);
    }
  }
  return null;
}

function setStaticTitle(text: string): void {
  const heading = $('mainTitle');
  heading.onblur = null;
  heading.onkeydown = null;
  heading.contentEditable = 'false';
  heading.removeAttribute('aria-label');
  heading.textContent = text;
}

function bindHeadingTitle(note: Note): void {
  const heading = $('mainTitle');
  heading.contentEditable = 'true';
  heading.spellcheck = false;
  heading.setAttribute('aria-label', t.noteTitleLabel);
  if (document.activeElement !== heading) {
    heading.textContent = note.title?.trim() || t.untitled;
  }
  heading.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      heading.blur();
    }
  };
  heading.onblur = () => {
    let next = (heading.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!next) {
      next = titleFromSummary(note.summaryText) ?? '';
    }
    if (!next || (next === t.untitled && !note.title?.trim())) {
      heading.textContent = t.untitled;
      if (!note.title?.trim()) {
        return;
      }
      next = '';
    }
    next = next.slice(0, 120);
    heading.textContent = next || t.untitled;
    if ((note.title ?? '') === next) {
      return;
    }
    void pith.notes.rename(note.id, next || null).then((updated) => {
      replaceNote(updated);
      if (document.activeElement !== heading) {
        heading.textContent = noteTitle(updated);
      }
    }).catch((error: unknown) => {
      heading.textContent = noteTitle(note);
      setMainError(apiMessage(error));
    });
  };
}

function noteWhen(note: Note): Date {
  const date = new Date(note.startedAt ?? note.createdAt);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function replaceNote(note: Note): void {
  notes = notes.map((item) => (item.id === note.id ? note : item));
}

function apiMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('sign_in_required')) {
    return t.signInRequired;
  }
  if (code.includes('no_listening_time')) {
    return t.errorNoListeningTime;
  }
  if (code.includes('no_notes')) {
    return t.errorNoNotes;
  }
  if (code.includes('last_workspace')) {
    return t.errorLastWorkspace;
  }
  if (code.includes('workspace_not_empty')) {
    return t.errorWorkspaceNotEmpty;
  }
  if (code.includes('note_processing')) {
    return t.errorNoteProcessing;
  }
  if (code.includes('record_again')) {
    return t.errorRecordAgain;
  }
  if (code.includes('mic_denied')) {
    return t.errorMicDenied;
  }
  return t.errorGeneric;
}

function planLabel(user: Me): string {
  if (user.plan !== 'paid') {
    return t.planFree;
  }
  if (user.planInterval === 'year') {
    return t.planPaidYearly;
  }
  if (user.planInterval === 'month') {
    return t.planPaidMonthly;
  }
  return t.planPaid;
}

function statusLabel(status: NoteStatus): string {
  if (status === 'ready') {
    return t.noteStatusReady;
  }
  if (status === 'processing') {
    return t.noteStatusProcessing;
  }
  if (status === 'failed') {
    return t.noteStatusFailed;
  }
  if (status === 'paused') {
    return t.statusPaused;
  }
  return t.noteStatusListening;
}

function dateLocale(): string {
  return locale === 'es' ? 'es' : 'en';
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDayHeader(date: Date): string {
  const today = startOfDay(new Date());
  const that = startOfDay(date);
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86400000);
  if (diffDays === 0) {
    return t.dateToday;
  }
  if (diffDays === 1) {
    return t.dateYesterday;
  }
  return date.toLocaleDateString(dateLocale(), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function formatNoteTime(note: Note): string {
  return noteWhen(note).toLocaleTimeString(dateLocale(), { timeStyle: 'short' });
}

function formatNoteDateTime(note: Note): string {
  const when = noteWhen(note);
  const date = when.toLocaleDateString(dateLocale(), {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return `${date} · ${formatNoteTime(note)}`;
}

function symbolBody(icon: string | undefined): string {
  return WORKSPACE_SYMBOLS.find((item) => item.id === icon)?.body ?? WORKSPACE_SYMBOLS[0].body;
}

function symbolSvg(icon: string | undefined): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${symbolBody(icon)}</svg>`;
}

function noteIcon(icon: string | undefined): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'note-icon';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `
    <svg viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="#f3eee6" />
      <svg x="4" y="4" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5c534c" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">${symbolBody(icon)}</svg>
    </svg>
  `;
  return wrap;
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

function stopListenClock(): void {
  if (listenTimer != null) {
    clearInterval(listenTimer);
    listenTimer = null;
  }
}

function startListenClock(): void {
  stopListenClock();
  listenTimer = window.setInterval(() => {
    if (!liveNoteId || captureState !== 'listening') {
      return;
    }
    listenSeconds += 1;
    const clock = document.getElementById('listenClock');
    if (clock) {
      clock.textContent = formatClock(listenSeconds);
    }
  }, 1000);
}

function recordingWorkspace(): Workspace | null {
  const current = view;
  if (current.name === 'workspace') {
    return workspaces.find((item) => item.id === current.id) ?? null;
  }
  if (current.name === 'note' || current.name === 'listen' || current.name === 'transcript') {
    return workspaces.find((item) => item.id === current.workspaceId) ?? null;
  }
  return workspaces[0] ?? null;
}

function syncNewNote(): void {
  const button = $('openSpike') as HTMLButtonElement;
  const signedIn = Boolean(me);
  button.disabled = !signedIn;
  button.title = signedIn ? '' : t.signInRequired;
}

async function reloadLists(): Promise<void> {
  if (!me) {
    workspaces = [];
    notes = [];
    listsReady = false;
    syncNewNote();
    return;
  }
  workspaces = await pith.notes.listWorkspaces();
  const groups = await Promise.all(
    workspaces.map((workspace) => pith.notes.listNotes(workspace.id)),
  );
  notes = groups.flat();
  const staleIds = new Set(
    notes
      .filter(
        (note) =>
          note.id !== liveNoteId &&
          (note.status === 'listening' || note.status === 'paused'),
      )
      .map((note) => note.id),
  );
  await Promise.all(
    [...staleIds].map((id) => pith.notes.cancel(id).catch(() => undefined)),
  );
  if (staleIds.size > 0) {
    notes = notes.filter((note) => !staleIds.has(note.id));
  }
  listsReady = true;
  syncNewNote();
}

async function abandonListen(): Promise<void> {
  const noteId = liveNoteId;
  if (!noteId) {
    return;
  }
  liveNoteId = null;
  heardSound = false;
  stopListenClock();
  listenSeconds = 0;
  try {
    await pith.capture.cancel();
  } catch {
    // The helper may already be idle.
  }
  captureState = 'idle';
  try {
    await pith.notes.cancel(noteId);
  } catch {
    // The note may already have been stopped.
  }
  notes = notes.filter((item) => item.id !== noteId);
}

async function refreshMe(): Promise<void> {
  me = await pith.auth.me();
  const signedIn = Boolean(me);
  $('signIn').hidden = signedIn;
  $('signOut').hidden = !signedIn;
  fillProfileFields();
  syncNewNote();
  if (signedIn && $('mainError').textContent === t.signInRequired) {
    setMainError('');
  }
}

function fillProfileFields(): void {
  const email = document.getElementById('profileEmail');
  const plan = document.getElementById('profilePlan');
  const minutesEl = document.getElementById('profileMinutes');
  const upgrade = document.getElementById('upgrade') as HTMLButtonElement | null;
  if (!email || !plan || !minutesEl) {
    return;
  }
  if (!me) {
    email.textContent = t.signedOut;
    plan.textContent = '—';
    minutesEl.textContent = '—';
    if (upgrade) {
      upgrade.hidden = true;
    }
    return;
  }
  email.textContent = me.email;
  plan.textContent = planLabel(me);
  minutesEl.textContent = t.remainingTime.replace(
    '{minutes}',
    String(Math.floor(me.remainingSeconds / 60)),
  );
  if (upgrade) {
    upgrade.hidden = me.plan === 'paid';
  }
}

function bindLangSelect(select: HTMLSelectElement): void {
  select.setAttribute('aria-label', t.language);
  select.options[0].textContent = t.langEn;
  select.options[1].textContent = t.langEs;
  select.value = locale;
  select.addEventListener('change', async (event) => {
    locale = (event.target as HTMLSelectElement).value as Locale;
    t = await pith.getMessages(locale);
    applyCopy();
    await refreshMe();
  });
}

function workspaceNameInput(): HTMLInputElement {
  return document.getElementById('workspaceName') as HTMLInputElement;
}

function showAddWorkspaceForm(): void {
  addingWorkspace = true;
  setSideError('');
  $('addWorkspace').hidden = true;
  const input = workspaceNameInput();
  input.hidden = false;
  input.value = '';
  input.focus();
}

function hideAddWorkspaceForm(): void {
  addingWorkspace = false;
  const input = workspaceNameInput();
  input.hidden = true;
  input.value = '';
  $('addWorkspace').hidden = false;
}

function commitAddWorkspace(): void {
  setSideError('');
  const name = workspaceNameInput().value.trim();
  if (!name) {
    return;
  }
  void (async () => {
    try {
      const workspace = await pith.notes.createWorkspace(name);
      workspaces = [...workspaces, workspace];
      hideAddWorkspaceForm();
      view = { name: 'workspace', id: workspace.id };
      render();
    } catch (error) {
      setSideError(apiMessage(error));
    }
  })();
}

function closeMenus(): void {
  symbolPickerId = null;
  document.querySelectorAll('.symbol-pop').forEach((pop) => pop.remove());
  document.querySelectorAll('.menu-open').forEach((row) => {
    row.classList.remove('menu-open');
  });
  document.querySelectorAll('.note-menu-pop').forEach((menu) => {
    (menu as HTMLElement).hidden = true;
  });
  document.querySelectorAll('.note-more').forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
  });
}

function makeOverflowMenu(
  row: HTMLElement,
  deleteLabel: string,
  onDelete: () => void,
): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'note-menu';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'ghost icon-btn note-more';
  more.setAttribute('aria-label', t.moreActions);
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.textContent = '...';
  const pop = document.createElement('div');
  pop.className = 'note-menu-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'menu');
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger-item';
  del.setAttribute('role', 'menuitem');
  del.textContent = deleteLabel;
  pop.append(del);
  menu.append(more, pop);
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = pop.hidden;
    closeMenus();
    if (willOpen) {
      const rect = more.getBoundingClientRect();
      pop.style.position = 'fixed';
      pop.style.top = `${rect.bottom + 6}px`;
      pop.style.right = `${document.documentElement.clientWidth - rect.right}px`;
      pop.style.left = 'auto';
      pop.hidden = false;
      more.setAttribute('aria-expanded', 'true');
      row.classList.add('menu-open');
    }
  });
  del.addEventListener('click', (event) => {
    event.stopPropagation();
    onDelete();
  });
  menu.addEventListener('click', (event) => event.stopPropagation());
  return menu;
}

function closeConfirm(): void {
  pendingDialog = null;
  $('confirmDialog').hidden = true;
}

function showDialog(title: string, body: string, dangerLabel?: string): void {
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  $('confirmCancel').textContent = dangerLabel ? t.cancel : t.dialogOk;
  $('confirmOk').hidden = !dangerLabel;
  if (dangerLabel) {
    $('confirmOk').textContent = dangerLabel;
  }
  $('confirmDialog').hidden = false;
}

function openDeleteConfirm(note: Note): void {
  setMainError('');
  if (note.status === 'processing' || note.status === 'listening' || note.status === 'paused') {
    setMainError(t.errorNoteProcessing);
    closeMenus();
    return;
  }
  pendingDialog = { kind: 'delete-note', note };
  closeMenus();
  showDialog(t.confirmDeleteNoteTitle, t.confirmDeleteNoteBody, t.deletePermanently);
}

function confirmPending(): void {
  if (!pendingDialog) {
    return;
  }
  const pending = pendingDialog;
  closeConfirm();
  void (async () => {
    try {
      if (pending.kind === 'delete-note') {
        await pith.notes.delete(pending.note.id);
        notes = notes.filter((item) => item.id !== pending.note.id);
        view = { name: 'workspace', id: pending.note.workspaceId };
      } else if (pending.kind === 'delete-workspace') {
        await pith.notes.deleteWorkspace(pending.id);
        workspaces = workspaces.filter((item) => item.id !== pending.id);
        notes = notes.filter((item) => item.workspaceId !== pending.id);
        view = { name: 'home' };
      }
      render();
    } catch (error) {
      setMainError(apiMessage(error));
    }
  })();
}

function setSideError(message: string): void {
  $('sideError').textContent = message;
}

function setMainError(message: string): void {
  $('mainError').textContent = message;
}

function workspaceById(id: string): Workspace | undefined {
  return workspaces.find((item) => item.id === id);
}

function notesIn(workspaceId: string): Note[] {
  return notes.filter((item) => item.workspaceId === workspaceId);
}

function symbolPicker(workspace: Workspace): HTMLElement {
  const pop = document.createElement('div');
  pop.className = 'symbol-pop';
  pop.addEventListener('click', (event) => event.stopPropagation());
  const current = WORKSPACE_SYMBOLS.some((item) => item.id === workspace.icon) ? workspace.icon : 'circle';
  for (const item of WORKSPACE_SYMBOLS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'symbol-choice';
    button.innerHTML = symbolSvg(item.id);
    button.setAttribute('aria-label', t.chooseSymbol);
    button.setAttribute('aria-pressed', item.id === current ? 'true' : 'false');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      void chooseSymbol(workspace, item.id);
    });
    pop.append(button);
  }
  return pop;
}

async function chooseSymbol(workspace: Workspace, icon: string): Promise<void> {
  const previous = workspace.icon;
  symbolPickerId = null;
  workspace.icon = icon;
  render();
  try {
    const updated = await pith.notes.setWorkspaceIcon(workspace.id, icon);
    const index = workspaces.findIndex((item) => item.id === workspace.id);
    if (index >= 0) {
      workspaces[index] = updated;
    }
    render();
  } catch (error) {
    workspace.icon = previous;
    setSideError(apiMessage(error));
    render();
  }
}

function renderWorkspaces(): void {
  document.querySelectorAll('.symbol-pop').forEach((pop) => pop.remove());
  const list = $('workspaceList');
  list.replaceChildren();
  const query = searchQuery.trim().toLowerCase();
  const visible = workspaces.filter((workspace) => {
    if (!query) {
      return true;
    }
    return workspace.name.toLowerCase().includes(query);
  });
  if (query && visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = t.searchNoMatch;
    list.append(empty);
    return;
  }
  for (const workspace of visible) {
    const row = document.createElement('div');
    row.className = 'workspace-entry';
    row.tabIndex = 0;
    const name = document.createElement('span');
    name.className = 'workspace-name';
    name.textContent = workspace.name;
    const selected =
      (view.name === 'workspace' && view.id === workspace.id) ||
      (view.name === 'note' && view.workspaceId === workspace.id) ||
      (view.name === 'listen' && view.workspaceId === workspace.id);
    if (selected) {
      row.classList.add('active');
    }
    const symbol = document.createElement('button');
    symbol.type = 'button';
    symbol.className = 'workspace-symbol';
    symbol.setAttribute('aria-label', t.chooseSymbol);
    symbol.innerHTML = symbolSvg(workspace.icon);
    symbol.addEventListener('click', (event) => {
      event.stopPropagation();
      symbolPickerId = symbolPickerId === workspace.id ? null : workspace.id;
      renderWorkspaces();
    });
    row.append(symbol, name, makeOverflowMenu(row, t.deleteWorkspace, () => requestDeleteWorkspace(workspace.id)));
    row.addEventListener('click', () => {
      void (async () => {
        if (liveNoteId) {
          await abandonListen();
        }
        view = { name: 'workspace', id: workspace.id };
        render();
      })();
    });
    list.append(row);
    if (symbolPickerId === workspace.id) {
      openSymbolPicker(symbol, workspace);
    }
  }
}

function openSymbolPicker(anchor: HTMLElement, workspace: Workspace): void {
  const pop = symbolPicker(workspace);
  document.body.append(pop);
  const rect = anchor.getBoundingClientRect();
  const height = pop.offsetHeight;
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - height - 4);
  }
  pop.style.left = `${rect.left}px`;
  pop.style.top = `${top}px`;
}

function renderHome(): void {
  setStaticTitle(t.home);
  if (notes.length === 0) {
    $('view').innerHTML = `<p class="empty">${t.emptyRecordings}</p>`;
    return;
  }
  $('view').innerHTML = `<div class="note-feed" id="noteList"></div>`;
  renderNoteFeed(document.getElementById('noteList') as HTMLElement, notes, true);
}

function renderProfile(): void {
  setStaticTitle(t.profile);
  $('view').innerHTML = `
    <div class="profile">
      <div class="profile-row">
        <span class="title-label">${t.profileEmail}</span>
        <p id="profileEmail"></p>
      </div>
      <div class="profile-row">
        <span class="title-label">${t.profilePlan}</span>
        <p id="profilePlan"></p>
      </div>
      <div class="profile-row">
        <span class="title-label">${t.profileMinutes}</span>
        <p id="profileMinutes"></p>
      </div>
      <div class="profile-row">
        <label class="title-label" for="lang">${t.language}</label>
        <select id="lang">
          <option value="en"></option>
          <option value="es"></option>
        </select>
      </div>
      <div class="detail-actions">
        <button type="button" class="primary" id="upgrade" hidden></button>
      </div>
    </div>
  `;
  fillProfileFields();
  $('upgrade').textContent = t.upgrade;
  $('upgrade').addEventListener('click', () => pith.auth.upgrade());
  bindLangSelect(document.getElementById('lang') as HTMLSelectElement);
}

function renderWorkspace(id: string): void {
  const workspace = workspaceById(id);
  if (!workspace) {
    view = { name: 'home' };
    render();
    return;
  }
  setStaticTitle(workspace.name);
  const items = notesIn(id);
  if (items.length === 0) {
    $('view').innerHTML = `<p class="empty">${t.emptyNotes}</p>`;
    return;
  }
  $('view').innerHTML = `<div class="note-feed" id="noteList"></div>`;
  renderNoteFeed(document.getElementById('noteList') as HTMLElement, items, false);
}

function renderNoteFeed(list: HTMLElement, items: Note[], showWorkspace: boolean): void {
  const ordered = [...items].sort(
    (a, b) => noteWhen(b).getTime() - noteWhen(a).getTime(),
  );
  const groups = new Map<string, Note[]>();
  for (const note of ordered) {
    const when = noteWhen(note);
    const key = `${when.getFullYear()}-${when.getMonth()}-${when.getDate()}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(note);
    groups.set(key, bucket);
  }
  for (const group of groups.values()) {
    const heading = document.createElement('p');
    heading.className = 'note-day';
    heading.textContent = formatDayHeader(noteWhen(group[0]));
    list.append(heading);
    for (const note of group) {
      const row = document.createElement('div');
      row.className = 'note-entry';
      row.tabIndex = 0;
      const copy = document.createElement('span');
      copy.className = 'note-copy';
      const name = document.createElement('span');
      name.className = 'note-title';
      name.textContent = noteTitle(note);
      copy.append(name);
      if (showWorkspace) {
        const workspace = workspaceById(note.workspaceId);
        const sub = document.createElement('span');
        sub.className = 'note-workspace';
        sub.textContent = workspace ? workspace.name : '';
        copy.append(sub);
      }
      const end = document.createElement('span');
      end.className = 'note-end';
      const time = document.createElement('span');
      time.className = 'note-time';
      time.textContent = formatNoteTime(note);
      end.append(time, makeOverflowMenu(row, t.deleteNote, () => openDeleteConfirm(note)));
      row.append(noteIcon(workspaceById(note.workspaceId)?.icon), copy, end);
      row.addEventListener('click', () => {
        view = { name: 'note', workspaceId: note.workspaceId, noteId: note.id };
        render();
      });
      list.append(row);
    }
  }
}

let copyTimer: number | null = null;

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

function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => copyWithSelection(text));
  }
  copyWithSelection(text);
  return Promise.resolve();
}

function bindCopy(text: string, label: string): void {
  const copy = $('copySummary') as HTMLButtonElement;
  if (copyTimer !== null) {
    window.clearTimeout(copyTimer);
    copyTimer = null;
  }
  copy.hidden = text.trim().length === 0;
  copy.classList.remove('copied');
  copy.setAttribute('aria-label', label);
  copy.onclick = () => {
    void writeClipboard(text).then(() => {
      copy.classList.add('copied');
      copy.setAttribute('aria-label', t.copiedSummary);
      copyTimer = window.setTimeout(() => {
        copy.classList.remove('copied');
        copy.setAttribute('aria-label', label);
      }, 1500);
    });
  };
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

function renderSummary(lines: string[]): string {
  type Kind = 'h' | 'ul' | 'ol';
  const items = lines.map((line) => {
    const indent = line.match(/^ */)?.[0].length ?? 0;
    const depth = Math.min(3, Math.floor(indent / 2));
    const text = line.trim();
    if (text.startsWith('#')) {
      return { kind: 'h' as Kind, depth: 0, text: text.replace(/^#+\s*/, '') };
    }
    const numbered = text.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      return { kind: 'ol' as Kind, depth, text: numbered[1] };
    }
    const bullet = text.match(/^[•\-*]\s+(.*)$/);
    return { kind: 'ul' as Kind, depth, text: bullet ? bullet[1] : text };
  });
  let html = '';
  let list: 'ul' | 'ol' | null = null;
  const closeList = (): void => {
    if (list === 'ul') {
      html += '</ul>';
    } else if (list === 'ol') {
      html += '</ol>';
    }
    list = null;
  };
  for (const item of items) {
    if (!item.text) {
      continue;
    }
    if (item.kind === 'h') {
      closeList();
      html += `<h2 class="summary-heading">${escapeHtml(item.text)}</h2>`;
      continue;
    }
    if (list !== item.kind) {
      closeList();
      list = item.kind;
      html += list === 'ul' ? '<ul class="summary-list">' : '<ol class="summary-steps">';
    }
    const nested = item.depth > 0 ? ' class="nested"' : '';
    html += `<li${nested}>${escapeHtml(item.text)}</li>`;
  }
  closeList();
  return html;
}

function renderNote(workspaceId: string, noteId: string): void {
  const note = notes.find((item) => item.id === noteId);
  if (!note) {
    view = { name: 'workspace', id: workspaceId };
    render();
    return;
  }
  bindHeadingTitle(note);
  const lines = note.summaryText;
  const options = workspaces
    .map(
      (workspace) =>
        `<option value="${escapeHtml(workspace.id)}" ${workspace.id === note.workspaceId ? 'selected' : ''}>${escapeHtml(workspace.name)}</option>`,
    )
    .join('');
  const hasTranscript = note.transcriptTurns.length > 0 || Boolean(note.transcriptText?.trim());
  const move = $('noteMove');
  move.hidden = false;
  move.innerHTML = `
    <label for="moveNote">${t.moveNote}</label>
    <select id="moveNote">${options}</select>
  `;
  $('view').innerHTML = `
    <div class="detail">
      ${note.status === 'ready' ? '' : `<span class="status-pill ${note.status}">${statusLabel(note.status)}</span>`}
      ${lines.length ? renderSummary(lines) : `<p class="empty">${t.noSummaryYet}</p>`}
      ${note.status === 'failed' ? `<div class="detail-actions"><button type="button" id="retryNote"></button></div>` : ''}
    </div>
  `;
  bindCopy(summaryPlainText(lines), t.copySummary);
  const showTranscript = $('showTranscript') as HTMLButtonElement;
  showTranscript.hidden = !hasTranscript;
  showTranscript.textContent = t.showTranscript;
  showTranscript.onclick = () => {
    view = { name: 'transcript', workspaceId: note.workspaceId, noteId: note.id };
    render();
  };
  const retry = document.getElementById('retryNote');
  if (retry) {
    retry.textContent = t.retry;
    retry.addEventListener('click', () => {
      void pith.notes.retry(note.id).then((updated) => {
        replaceNote(updated);
        render();
      }).catch((error: unknown) => {
        setMainError(apiMessage(error));
      });
    });
  }
  (document.getElementById('moveNote') as HTMLSelectElement).addEventListener(
    'change',
    (event) => {
      const workspaceId = (event.target as HTMLSelectElement).value;
      void pith.notes.move(note.id, workspaceId).then((updated) => {
        replaceNote(updated);
        view = { name: 'note', workspaceId: updated.workspaceId, noteId: updated.id };
        render();
      }).catch((error: unknown) => {
        setMainError(apiMessage(error));
      });
    },
  );
}

function transcriptTurns(note: Note): TranscriptTurn[] {
  const source =
    note.transcriptTurns.length > 0
      ? note.transcriptTurns
      : note.transcriptText?.trim()
        ? [{ source: 'mix' as const, startSec: 0, endSec: note.durationSeconds ?? 0, text: note.transcriptText.trim() }]
        : [];
  return source
    .map((turn) => ({ ...turn, text: cleanSpeech(turn.text) }))
    .filter((turn) => turn.text.length > 0);
}

function cleanSpeech(value: string): string {
  let text = value.replace(/\[[^\]\n]{0,48}\]/g, ' ').replace(/[♪♫♬]+/g, ' ');
  const words = text
    .split(/\s+/)
    .map((token) => token.trim().replace(/[^\p{Script=Latin}\p{N}.,;:!?¿¡'"()\-]/gu, ''))
    .filter((token) => {
      const letters = token.replace(/[^\p{L}]/gu, '');
      const digits = token.replace(/[^\p{N}]/gu, '');
      if (!letters) {
        return digits.length > 0;
      }
      if (/^(.)\1{3,}$/iu.test(letters)) {
        return false;
      }
      if (letters.length === 1 && !/^[aeiouy]$/i.test(letters)) {
        return false;
      }
      if (letters.length >= 5 && !/[aeiouáéíóúüàèìòùâêîôûäëïöüy]/i.test(letters)) {
        return false;
      }
      return true;
    });
  return words
    .join(' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTurnTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const remain = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remain).padStart(2, '0')}`;
}

function renderTranscript(workspaceId: string, noteId: string): void {
  const note = notes.find((item) => item.id === noteId);
  if (!note) {
    view = { name: 'workspace', id: workspaceId };
    render();
    return;
  }
  bindHeadingTitle(note);
  const turns = transcriptTurns(note);
  const rows: string[] = [];
  let previousEnd = -1;
  for (const turn of turns) {
    const gap = previousEnd < 0 || turn.startSec - previousEnd >= 20;
    if (gap) {
      rows.push(`<p class="turn-time">${formatTurnTime(turn.startSec)}</p>`);
    }
    rows.push(
      `<p class="bubble ${turn.source}">${escapeHtml(turn.text)}</p>`,
    );
    previousEnd = turn.endSec;
  }
  $('view').innerHTML = `
    <div class="transcript-screen">
      <div class="chat">${rows.join('')}</div>
    </div>
  `;
  const back = $('showTranscript') as HTMLButtonElement;
  back.hidden = false;
  back.textContent = t.backToSummary;
  back.onclick = () => {
    view = { name: 'note', workspaceId, noteId };
    render();
  };
  bindCopy(turns.map((turn) => turn.text.trim()).filter((text) => text.length > 0).join('\n\n'), t.copyTranscript);
}

function renderListen(workspaceId: string, noteId: string): void {
  const note = notes.find((item) => item.id === noteId);
  if (!note) {
    view = { name: 'workspace', id: workspaceId };
    render();
    return;
  }
  $('mainTitle').textContent = noteTitle(note);
  const listening = captureState === 'listening';
  const paused = captureState === 'paused';
  $('view').innerHTML = `
    <div class="listen">
      <p class="hint">${t.listenHint}</p>
      <label class="title-label" for="noteTitle">${t.noteTitleLabel}</label>
      <input id="noteTitle" class="title-field" maxlength="120" />
      <div class="listen-levels">
        <div>
          <span>${t.levelMic}</span>
          <div class="level-track"><div id="micLevel" class="level-fill"></div></div>
        </div>
        <div>
          <span>${t.levelSystem}</span>
          <div class="level-track"><div id="systemLevel" class="level-fill"></div></div>
        </div>
      </div>
      <div class="clock" id="listenClock">${formatClock(listenSeconds)}</div>
      <p id="listenStatus">${statusLabel(paused ? 'paused' : 'listening')}</p>
      <p class="hint" id="listenQuota"></p>
      <div class="detail-actions">
        <button type="button" id="listenPause" ${listening ? '' : 'disabled'}></button>
        <button type="button" id="listenResume" ${paused ? '' : 'disabled'}></button>
        <button type="button" id="listenStop" ${listening || paused ? '' : 'disabled'}></button>
        <button type="button" class="danger" id="listenCancel"></button>
      </div>
    </div>
  `;
  const titleInput = document.getElementById('noteTitle') as HTMLInputElement;
  titleInput.placeholder = t.noteTitlePlaceholder;
  titleInput.value = note.title ?? '';
  titleInput.addEventListener('change', () => {
    const next = titleInput.value.trim();
    note.title = next || null;
    void pith.notes.rename(note.id, note.title).then(replaceNote).catch((error: unknown) => {
      setMainError(apiMessage(error));
    });
  });
  if (me) {
    const minutes = Math.floor(me.remainingSeconds / 60);
    $('listenQuota').textContent = t.remainingTime.replace('{minutes}', String(minutes));
  }
  $('listenPause').textContent = t.pause;
  $('listenResume').textContent = t.resume;
  $('listenStop').textContent = t.stop;
  $('listenCancel').textContent = t.cancel;
  $('listenPause').addEventListener('click', () => {
    void pith.capture.pause().then(() => {
      captureState = 'paused';
      stopListenClock();
      render();
    }).catch((error: unknown) => setMainError(apiMessage(error)));
  });
  $('listenResume').addEventListener('click', () => {
    void pith.capture.resume().then(() => {
      captureState = 'listening';
      if (heardSound) {
        startListenClock();
      }
      render();
    }).catch((error: unknown) => setMainError(apiMessage(error)));
  });
  $('listenStop').addEventListener('click', () => {
    void (async () => {
      try {
        let durationSeconds = listenSeconds;
        try {
          const ended = await pith.capture.end();
          durationSeconds = ended.durationSeconds;
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          const stopped =
            code.includes('empty') ||
            code.includes('too_short') ||
            code.includes('not_listening');
          if (!stopped) {
            throw error;
          }
        }
        captureState = 'idle';
        liveNoteId = null;
        heardSound = false;
        stopListenClock();
        const saved = await pith.notes.stop(note.id, durationSeconds);
        replaceNote(saved);
        view = { name: 'note', workspaceId: saved.workspaceId, noteId: saved.id };
        render();
      } catch (error) {
        setMainError(apiMessage(error));
      }
    })();
  });
  $('listenCancel').addEventListener('click', () => {
    if (!window.confirm(t.confirmCancelListen)) {
      return;
    }
    void (async () => {
      if (liveNoteId === note.id) {
        await abandonListen();
      } else {
        try {
          await pith.notes.cancel(note.id);
        } catch (error) {
          setMainError(apiMessage(error));
          return;
        }
        notes = notes.filter((item) => item.id !== note.id);
      }
      view = { name: 'workspace', id: workspaceId };
      render();
    })();
  });
}

function requestDeleteWorkspace(id: string): void {
  closeMenus();
  if (workspaces.length <= 1) {
    pendingDialog = { kind: 'info' };
    showDialog(t.confirmLastWorkspaceTitle, t.errorLastWorkspace);
    return;
  }
  if (notesIn(id).length > 0) {
    pendingDialog = { kind: 'info' };
    showDialog(t.confirmWorkspaceNotEmptyTitle, t.errorWorkspaceNotEmpty);
    return;
  }
  pendingDialog = { kind: 'delete-workspace', id };
  showDialog(t.confirmDeleteWorkspace, t.confirmDeleteWorkspaceBody, t.deletePermanently);
}

function showNoteWhen(): void {
  const slot = $('noteWhen');
  const noteId =
    view.name === 'note' || view.name === 'transcript' ? view.noteId : null;
  const note = noteId ? notes.find((item) => item.id === noteId) : undefined;
  const move = $('noteMove');
  if (!note || view.name !== 'note') {
    move.hidden = true;
    move.replaceChildren();
  }
  if (!note || view.name !== 'note') {
    $('copySummary').hidden = true;
  }
  if (!note) {
    slot.hidden = true;
    slot.textContent = '';
    $('showTranscript').hidden = true;
    return;
  }
  slot.hidden = false;
  slot.textContent = formatNoteDateTime(note);
  if (view.name !== 'note') {
    $('showTranscript').hidden = true;
  }
}

function render(): void {
  setMainError('');
  showNoteWhen();
  syncNewNote();
  $('homeBtn').classList.toggle('active', view.name === 'home');
  $('profileBtn').classList.toggle('active', view.name === 'profile');
  renderWorkspaces();
  if (view.name === 'home') {
    renderHome();
  } else if (view.name === 'profile') {
    renderProfile();
  } else if (view.name === 'workspace') {
    renderWorkspace(view.id);
  } else if (view.name === 'note') {
    renderNote(view.workspaceId, view.noteId);
  } else if (view.name === 'transcript') {
    renderTranscript(view.workspaceId, view.noteId);
  } else {
    renderListen(view.workspaceId, view.noteId);
  }
}

function applyCopy(): void {
  document.documentElement.lang = locale;
  document.title = t.appName;
  $('homeBtnLabel').textContent = t.home;
  $('profileBtnLabel').textContent = t.profile;
  $('workspacesLabel').textContent = t.workspaces;
  $('addWorkspaceLabel').textContent = t.addWorkspace;
  workspaceNameInput().placeholder = t.workspaceNamePlaceholder;
  ($('search') as HTMLInputElement).placeholder = t.search;
  $('searchShortcut').textContent = t.searchShortcut;
  $('openSpikeLabel').textContent = t.newNote;
  $('signInLabel').textContent = t.signIn;
  $('signOutLabel').textContent = t.signOut;
  askCopy();
  render();
}

async function init(): Promise<void> {
  locale = await pith.getLocale();
  t = await pith.getMessages(locale);
  applyCopy();
  await refreshMe();
  $('signIn').addEventListener('click', async () => {
    await pith.auth.login();
    await refreshMe();
    try {
      await reloadLists();
    } catch (error) {
      setMainError(apiMessage(error));
    }
    render();
  });
  $('signOut').addEventListener('click', async () => {
    await abandonListen();
    await pith.auth.logout();
    await refreshMe();
    await reloadLists();
    view = { name: 'home' };
    resetAsk();
    render();
  });
  $('homeBtn').addEventListener('click', () => {
    void (async () => {
      await abandonListen();
      view = { name: 'home' };
      render();
    })();
  });
  $('profileBtn').addEventListener('click', () => {
    view = { name: 'profile' };
    render();
  });
  $('search').addEventListener('input', (event) => {
    searchQuery = (event.target as HTMLInputElement).value;
    renderWorkspaces();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('confirmDialog').hidden) {
        closeConfirm();
        return;
      }
      closeMenus();
      if (addingWorkspace) {
        hideAddWorkspaceForm();
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      ($('search') as HTMLInputElement).focus();
    }
  });
  $('addWorkspace').addEventListener('click', () => {
    showAddWorkspaceForm();
  });
  workspaceNameInput().addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitAddWorkspace();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideAddWorkspaceForm();
    }
  });
  workspaceNameInput().addEventListener('blur', () => {
    if (!workspaceNameInput().value.trim()) {
      hideAddWorkspaceForm();
    }
  });
  $('openSpike').addEventListener('click', () => {
    if (!me) {
      setMainError(t.signInRequired);
      return;
    }
    setMainError('');
    void (async () => {
      let workspace = recordingWorkspace();
      if (!workspace) {
        const listed = await pith.notes.listWorkspaces();
        workspaces = listed;
        workspace = listed[0] ?? null;
      }
      if (!workspace) {
        setMainError(t.errorGeneric);
        return;
      }
      await pith.shell.openSpike(workspace.id, workspace.name);
    })().catch((error: unknown) => {
      setMainError(apiMessage(error));
    });
  });
  $('confirmCancel').addEventListener('click', () => closeConfirm());
  $('confirmOk').addEventListener('click', () => confirmPending());
  $('confirmDialog').addEventListener('click', (event) => {
    if (event.target === $('confirmDialog')) {
      closeConfirm();
    }
  });
  document.addEventListener('click', () => closeMenus());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      return;
    }
    void (async () => {
      await refreshMe();
      if (liveNoteId) {
        return;
      }
      try {
        await reloadLists();
        render();
      } catch (error) {
        setMainError(apiMessage(error));
      }
    })();
  });
  pith.capture.onLevels((levels) => {
    const mic = document.getElementById('micLevel');
    const system = document.getElementById('systemLevel');
    if (mic) {
      mic.style.width = `${Math.round(Math.min(1, levels.mic) * 100)}%`;
    }
    if (system) {
      system.style.width = `${Math.round(Math.min(1, levels.system) * 100)}%`;
    }
    if (captureState === 'listening' && !heardSound && (levels.mic > 0 || levels.system > 0)) {
      heardSound = true;
      startListenClock();
    }
  });
  bindAsk();
  try {
    await reloadLists();
    render();
  } catch (error) {
    setMainError(apiMessage(error));
  }
}

type AskTurn = { role: 'user' | 'assistant'; text: string };
type AskAttachment = { name: string; mime: string; dataBase64: string };

const ASK_FILE_LIMIT = 4;
const ASK_FILE_BYTES = 1_200_000;

let askMessages: AskTurn[] = [];
let askFiles: AskAttachment[] = [];
let askSessionFiles: AskAttachment[] = [];
let askError = '';
let askBusy = false;
let askOpen = true;
let askEpoch = 0;
let askRecording = false;
let askDiscardVoice = false;
let askRecorder: MediaRecorder | null = null;
let askStream: MediaStream | null = null;
let askStopTimer = 0;

function askCopy(): void {
  ($('askInput') as HTMLInputElement).placeholder = t.askPlaceholder;
  $('askTodos').textContent = t.listRecentTodos;
  $('askAttach').setAttribute('aria-label', t.askAttach);
  $('askMic').setAttribute('aria-label', askRecording ? t.askListening : t.askMic);
  $('askToggle').setAttribute('aria-label', askOpen ? t.askHide : t.askShow);
  $('askNewSession').setAttribute('aria-label', t.askNewSession);
}

function presentAskText(role: 'user' | 'assistant', text: string): string {
  if (role !== 'assistant') {
    return text;
  }
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\*+\s*/, '').replaceAll('*', ''))
    .join('\n');
}

function askFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('sign_in_required')) {
    return t.signInRequired;
  }
  if (code.includes('ask_file_too_large') || code.includes('voice_too_large')) {
    return t.askFileTooLarge;
  }
  if (code.includes('ask_files')) {
    return t.askTooMany;
  }
  if (code.includes('ask_file_type')) {
    return t.askFileType;
  }
  return t.askFailed;
}

function renderAsk(): void {
  const thread = $('askThread');
  const panel = $('askPanel');
  const files = $('askFiles');
  const hasThread = askMessages.length > 0 || askError.length > 0 || askBusy;
  panel.classList.toggle('empty', !hasThread);
  panel.classList.toggle('collapsed', hasThread && !askOpen);
  ($('askToggle') as HTMLButtonElement).disabled = !hasThread;
  ($('askNewSession') as HTMLButtonElement).disabled = !hasThread;
  thread.innerHTML = [
    ...askMessages.map(
      (message) =>
        `<p class="ask-turn ${message.role}">${escapeHtml(presentAskText(message.role, message.text))}</p>`,
    ),
    askBusy ? '<p class="ask-turn ask-pending">…</p>' : '',
    askError ? `<p class="ask-error">${escapeHtml(askError)}</p>` : '',
  ].join('');
  files.hidden = askFiles.length === 0;
  files.innerHTML = askFiles
    .map(
      (file, index) =>
        `<span class="ask-file">${escapeHtml(file.name)}<button type="button" data-ask-remove="${index}" aria-label="×">×</button></span>`,
    )
    .join('');
  $('askMic').classList.toggle('recording', askRecording);
  $('askForm')
    .querySelectorAll('button, input')
    .forEach((node) => {
      const control = node as HTMLButtonElement | HTMLInputElement;
      control.disabled = askBusy && control.id !== 'askMic';
      if (control.id === 'askMic' && askRecording) {
        control.disabled = false;
      }
    });
  askCopy();
  if (hasThread && askOpen) {
    thread.scrollTop = thread.scrollHeight;
  }
}

function resetAsk(): void {
  askEpoch += 1;
  askOpen = true;
  window.clearTimeout(askStopTimer);
  if (askRecorder && askRecorder.state !== 'inactive') {
    askDiscardVoice = true;
    askRecorder.stop();
  } else {
    askDiscardVoice = false;
  }
  askStream?.getTracks().forEach((track) => track.stop());
  askStream = null;
  askMessages = [];
  askFiles = [];
  askSessionFiles = [];
  askError = '';
  askBusy = false;
  ($('askInput') as HTMLInputElement).value = '';
  renderAsk();
}

function bindAsk(): void {
  $('askForm').addEventListener('submit', (event) => {
    event.preventDefault();
    void sendAsk(($('askInput') as HTMLInputElement).value);
  });
  $('askTodos').addEventListener('click', () => {
    void sendAsk(t.askTodosPrompt);
  });
  $('askAttach').addEventListener('click', () => {
    ($('askFile') as HTMLInputElement).click();
  });
  $('askFile').addEventListener('change', () => {
    const input = $('askFile') as HTMLInputElement;
    void addAskFiles(input.files);
    input.value = '';
  });
  $('askFiles').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button');
    const index = Number(button?.getAttribute('data-ask-remove'));
    if (!Number.isInteger(index)) {
      return;
    }
    askFiles.splice(index, 1);
    renderAsk();
  });
  $('askMic').addEventListener('click', () => {
    void toggleAskMic();
  });
  $('askToggle').addEventListener('click', () => {
    askOpen = !askOpen;
    renderAsk();
  });
  $('askNewSession').addEventListener('click', () => {
    resetAsk();
  });
  renderAsk();
}

async function sendAsk(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || askBusy) {
    return;
  }
  ($('askInput') as HTMLInputElement).value = '';
  if (askRecording) {
    askDiscardVoice = true;
    window.clearTimeout(askStopTimer);
    if (askRecorder && askRecorder.state !== 'inactive') {
      askRecorder.stop();
    }
  }
  const attachments = askSessionFiles.concat(askFiles);
  const names = askFiles.map((file) => file.name).join(', ');
  askSessionFiles = attachments;
  askFiles = [];
  askError = '';
  askOpen = true;
  askMessages.push({ role: 'user', text: names ? `${trimmed}\n${names}` : trimmed });
  askBusy = true;
  const epoch = askEpoch;
  renderAsk();
  try {
    const result = await pith.ask.send(askMessages, askSessionFiles);
    if (epoch !== askEpoch) {
      return;
    }
    askMessages.push({ role: 'assistant', text: result.answer });
  } catch (error) {
    if (epoch !== askEpoch) {
      return;
    }
    askError = askFailure(error);
  } finally {
    if (epoch === askEpoch) {
      askBusy = false;
      renderAsk();
      if (askMessages.at(-1)?.role === 'assistant') {
        ($('askInput') as HTMLInputElement).focus();
      }
    }
  }
}

async function addAskFiles(list: FileList | null): Promise<void> {
  if (!list) {
    return;
  }
  askError = '';
  for (const file of Array.from(list)) {
    if (askFiles.length + askSessionFiles.length >= ASK_FILE_LIMIT) {
      askError = t.askTooMany;
      break;
    }
    const mime = askMime(file);
    if (!mime) {
      askError = t.askFileType;
      continue;
    }
    if (file.size > ASK_FILE_BYTES) {
      askError = t.askFileTooLarge;
      continue;
    }
    askFiles.push({ name: file.name || 'file', mime, dataBase64: await readAskBase64(file) });
  }
  renderAsk();
}

function askMime(file: File): string | null {
  const type = file.type.toLowerCase();
  if (type === 'image/jpg') {
    return 'image/jpeg';
  }
  const known = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/pdf',
  ];
  if (known.includes(type)) {
    return type;
  }
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.txt')) return 'text/plain';
  if (name.endsWith('.md')) return 'text/markdown';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  return null;
}

function readAskBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('ask_file_type'));
    reader.readAsDataURL(file);
  });
}

async function toggleAskMic(): Promise<void> {
  if (askRecording) {
    window.clearTimeout(askStopTimer);
    if (askRecorder && askRecorder.state !== 'inactive') {
      askRecorder.stop();
    }
    return;
  }
  if (askBusy) {
    return;
  }
  // Browser microphone only. This does not start a note or the meeting recorder.
  const state = await pith.capture.getState();
  if (state !== 'idle') {
    askError = t.askMicBusy;
    renderAsk();
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    askError = t.errorMicDenied;
    renderAsk();
    return;
  }
  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  askStream = stream;
  askRecorder = recorder;
  askRecording = true;
  askDiscardVoice = false;
  askError = '';
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  recorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    if (askStream === stream) {
      askStream = null;
    }
    if (askRecorder === recorder) {
      askRecorder = null;
    }
    askRecording = false;
    renderAsk();
    if (askDiscardVoice) {
      askDiscardVoice = false;
      return;
    }
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    void transcribeAsk(blob);
  };
  recorder.start();
  renderAsk();
  askStopTimer = window.setTimeout(() => {
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, 60_000);
}

async function transcribeAsk(blob: Blob): Promise<void> {
  askBusy = true;
  renderAsk();
  try {
    const result = await pith.ask.transcribe(
      await readAskBase64(blob),
      blob.type || 'audio/webm',
      'question.webm',
    );
    const spoken = result.text.trim();
    if (spoken) {
      const input = $('askInput') as HTMLInputElement;
      input.value = [input.value.trim(), spoken].filter((part) => part.length > 0).join(' ');
      input.focus();
    }
  } catch (error) {
    askError = askFailure(error);
  } finally {
    askBusy = false;
    renderAsk();
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

void init();

export {};
