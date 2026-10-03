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
  createdAt: string;
  updatedAt: string;
};
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
let addingWorkspace = false;
let pendingDialog: PendingDialog | null = null;

let workspaces: Workspace[] = [];
let notes: Note[] = [];

function noteTitle(note: Note): string {
  return note.title?.trim() || t.untitled;
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

function noteIcon(): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'note-icon';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `
    <svg viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="#f3eee6" />
      <circle cx="16" cy="16" r="7" stroke="#5c534c" stroke-width="1.5" />
      <circle cx="16" cy="16" r="3.5" stroke="#5c534c" stroke-width="1.5" />
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

function renderWorkspaces(): void {
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
    row.append(name, makeOverflowMenu(row, t.deleteWorkspace, () => requestDeleteWorkspace(workspace.id)));
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
  }
}

function renderHome(): void {
  $('mainTitle').textContent = t.home;
  if (notes.length === 0) {
    $('view').innerHTML = `<p class="empty">${t.emptyRecordings}</p>`;
    return;
  }
  $('view').innerHTML = `<div class="note-feed" id="noteList"></div>`;
  renderNoteFeed(document.getElementById('noteList') as HTMLElement, notes, true);
}

function renderProfile(): void {
  $('mainTitle').textContent = t.profile;
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
  $('mainTitle').textContent = workspace.name;
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
      row.append(noteIcon(), copy, end);
      row.addEventListener('click', () => {
        view = { name: 'note', workspaceId: note.workspaceId, noteId: note.id };
        render();
      });
      list.append(row);
    }
  }
}

function renderNote(workspaceId: string, noteId: string): void {
  const note = notes.find((item) => item.id === noteId);
  if (!note) {
    view = { name: 'workspace', id: workspaceId };
    render();
    return;
  }
  $('mainTitle').textContent = noteTitle(note);
  const lines = note.summaryText;
  const options = workspaces
    .map(
      (workspace) =>
        `<option value="${escapeHtml(workspace.id)}" ${workspace.id === note.workspaceId ? 'selected' : ''}>${escapeHtml(workspace.name)}</option>`,
    )
    .join('');
  const hasTranscript = note.transcriptTurns.length > 0 || Boolean(note.transcriptText?.trim());
  $('view').innerHTML = `
    <div class="detail">
      <input id="noteTitle" class="title-field" maxlength="120" />
      <span class="status-pill ${note.status}">${statusLabel(note.status)}</span>
      ${lines.length ? `<ol>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ol>` : `<p class="empty">${t.noSummaryYet}</p>`}
      ${hasTranscript ? `<button type="button" class="text-btn" id="showTranscript"></button>` : ''}
      <div class="detail-actions">
        <label for="moveNote">${t.moveNote}</label>
        <select id="moveNote">${options}</select>
        ${note.status === 'failed' ? `<button type="button" id="retryNote"></button>` : ''}
      </div>
    </div>
  `;
  const showTranscript = document.getElementById('showTranscript');
  if (showTranscript) {
    showTranscript.textContent = t.showTranscript;
    showTranscript.addEventListener('click', () => {
      view = { name: 'transcript', workspaceId: note.workspaceId, noteId: note.id };
      render();
    });
  }
  const titleInput = document.getElementById('noteTitle') as HTMLInputElement;
  titleInput.placeholder = t.noteTitlePlaceholder;
  titleInput.setAttribute('aria-label', t.noteTitleLabel);
  titleInput.value = note.title ?? '';
  titleInput.addEventListener('change', () => {
    const next = titleInput.value.trim();
    void pith.notes.rename(note.id, next || null).then((updated) => {
      replaceNote(updated);
      $('mainTitle').textContent = noteTitle(updated);
    }).catch((error: unknown) => {
      setMainError(apiMessage(error));
    });
  });
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
  if (note.transcriptTurns.length > 0) {
    return note.transcriptTurns;
  }
  const text = note.transcriptText?.trim() ?? '';
  if (!text) {
    return [];
  }
  return [{ source: 'mix', startSec: 0, endSec: note.durationSeconds ?? 0, text }];
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
  $('mainTitle').textContent = noteTitle(note);
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
      <button type="button" class="text-btn" id="backToSummary"></button>
      <div class="chat">${rows.join('')}</div>
    </div>
  `;
  const back = document.getElementById('backToSummary') as HTMLButtonElement;
  back.textContent = t.backToSummary;
  back.addEventListener('click', () => {
    view = { name: 'note', workspaceId, noteId };
    render();
  });
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
  if (!note) {
    slot.hidden = true;
    slot.textContent = '';
    return;
  }
  slot.hidden = false;
  slot.textContent = formatNoteDateTime(note);
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
  try {
    await reloadLists();
    render();
  } catch (error) {
    setMainError(apiMessage(error));
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
