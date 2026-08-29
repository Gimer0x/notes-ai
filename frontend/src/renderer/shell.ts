type NoteStatus = 'ready' | 'processing' | 'failed' | 'listening' | 'paused' | 'idle';

type Me = {
  email: string;
  plan: 'free' | 'paid';
  planInterval: 'month' | 'year' | null;
  remainingSeconds: number;
  remainingNotes: number | null;
};

type Workspace = { id: string; nameKey?: string; name?: string };
type Note = {
  id: string;
  workspaceId: string;
  titleKey?: string;
  title?: string;
  status: NoteStatus;
  at: Date;
  summaryKeys?: string[];
  summary?: string[];
};

type View =
  | { name: 'home' }
  | { name: 'profile' }
  | { name: 'workspace'; id: string }
  | { name: 'note'; workspaceId: string; noteId: string }
  | { name: 'listen'; workspaceId: string; noteId: string };

const $ = (id: string) => document.getElementById(id) as HTMLElement;

let locale: Locale = 'en';
let t: Messages = {};
let me: Me | null = null;
let view: View = { name: 'home' };
let nextId = 4;
let listenSeconds = 0;
let listenTimer: number | null = null;
let searchQuery = '';
let addingWorkspace = false;
let pendingDelete: Note | null = null;

let workspaces: Workspace[] = [
  { id: 'ws-personal', nameKey: 'mockWorkspacePersonal' },
  { id: 'ws-client', nameKey: 'mockWorkspaceClient' },
];

let notes: Note[] = [
  {
    id: 'n1',
    workspaceId: 'ws-personal',
    titleKey: 'mockNoteStandup',
    status: 'ready',
    at: new Date('2026-08-21T10:15:00'),
    summaryKeys: ['mockBullet1', 'mockBullet2', 'mockBullet3'],
  },
  {
    id: 'n2',
    workspaceId: 'ws-personal',
    titleKey: 'mockNoteDesign',
    status: 'processing',
    at: new Date('2026-08-28T09:40:00'),
  },
  {
    id: 'n3',
    workspaceId: 'ws-client',
    titleKey: 'mockNoteOneOnOne',
    status: 'failed',
    at: new Date('2026-08-27T16:05:00'),
  },
];

function label(value: string | undefined, key?: string): string {
  if (key && t[key]) {
    return t[key];
  }
  return value?.trim() || t.untitled;
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
  if (status === 'idle') {
    return t.noteStatusIdle;
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
  return note.at.toLocaleTimeString(dateLocale(), { timeStyle: 'short' });
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
    const note = notes.find((item) => item.status === 'listening');
    if (!note) {
      return;
    }
    listenSeconds += 1;
    const clock = document.getElementById('listenClock');
    if (clock) {
      clock.textContent = formatClock(listenSeconds);
    }
  }, 1000);
}

async function refreshMe(): Promise<void> {
  me = await pith.auth.me();
  const signedIn = Boolean(me);
  $('signIn').hidden = signedIn;
  $('signOut').hidden = !signedIn;
  fillProfileFields();
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
  workspaces.push({ id: `ws-${nextId++}`, name });
  hideAddWorkspaceForm();
  view = { name: 'workspace', id: workspaces[workspaces.length - 1].id };
  render();
}

function closeNoteMenu(): void {
  document.querySelectorAll('.note-entry.menu-open').forEach((row) => {
    row.classList.remove('menu-open');
  });
  document.querySelectorAll('.note-menu-pop').forEach((menu) => {
    (menu as HTMLElement).hidden = true;
  });
  document.querySelectorAll('.note-more').forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
  });
}

function closeConfirm(): void {
  pendingDelete = null;
  $('confirmDialog').hidden = true;
}

function openDeleteConfirm(note: Note): void {
  setMainError('');
  if (note.status === 'processing' || note.status === 'listening' || note.status === 'paused') {
    setMainError(t.errorNoteProcessing);
    closeNoteMenu();
    return;
  }
  pendingDelete = note;
  closeNoteMenu();
  $('confirmTitle').textContent = t.confirmDeleteNoteTitle;
  $('confirmBody').textContent = t.confirmDeleteNoteBody;
  $('confirmCancel').textContent = t.cancel;
  $('confirmOk').textContent = t.deletePermanently;
  $('confirmDialog').hidden = false;
}

function confirmDeleteNote(): void {
  if (!pendingDelete) {
    return;
  }
  const workspaceId = pendingDelete.workspaceId;
  notes = notes.filter((item) => item.id !== pendingDelete?.id);
  closeConfirm();
  view = { name: 'workspace', id: workspaceId };
  render();
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
    return label(workspace.name, workspace.nameKey).toLowerCase().includes(query);
  });
  if (query && visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = t.searchNoMatch;
    list.append(empty);
    return;
  }
  for (const workspace of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.textContent = label(workspace.name, workspace.nameKey);
    const selected =
      (view.name === 'workspace' && view.id === workspace.id) ||
      (view.name === 'note' && view.workspaceId === workspace.id) ||
      (view.name === 'listen' && view.workspaceId === workspace.id);
    if (selected) {
      button.classList.add('active');
    }
    button.addEventListener('click', () => {
      view = { name: 'workspace', id: workspace.id };
      render();
    });
    list.append(button);
  }
}

function renderHome(): void {
  $('mainTitle').textContent = t.home;
  $('view').innerHTML = `
    <p class="hint">${t.homeLead}</p>
    <div class="notes" id="homeWorkspaces"></div>
  `;
  const host = document.getElementById('homeWorkspaces') as HTMLElement;
  for (const workspace of workspaces) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'note-row';
    const count = notesIn(workspace.id).length;
    const name = document.createElement('span');
    name.textContent = label(workspace.name, workspace.nameKey);
    const meta = document.createElement('span');
    meta.className = 'note-meta';
    meta.textContent = t.noteCount.replace('{count}', String(count));
    row.append(name, meta);
    row.addEventListener('click', () => {
      view = { name: 'workspace', id: workspace.id };
      render();
    });
    host.append(row);
  }
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
  $('mainTitle').textContent = label(workspace.name, workspace.nameKey);
  const items = notesIn(id);
  if (items.length === 0) {
    $('view').innerHTML = `<p class="empty">${t.emptyNotes}</p>
      <div class="detail-actions">
        <button type="button" class="danger" id="deleteWorkspace"></button>
      </div>`;
    ($('deleteWorkspace') as HTMLButtonElement).textContent = t.deleteWorkspace;
    $('deleteWorkspace').addEventListener('click', () => deleteWorkspace(id));
    return;
  }
  $('view').innerHTML = `<div class="note-feed" id="noteList"></div>
    <div class="detail-actions">
      <button type="button" class="danger" id="deleteWorkspace"></button>
    </div>`;
  ($('deleteWorkspace') as HTMLButtonElement).textContent = t.deleteWorkspace;
  $('deleteWorkspace').addEventListener('click', () => deleteWorkspace(id));
  const list = document.getElementById('noteList') as HTMLElement;
  const ordered = [...items].sort((a, b) => b.at.getTime() - a.at.getTime());
  const groups = new Map<string, Note[]>();
  for (const note of ordered) {
    const key = `${note.at.getFullYear()}-${note.at.getMonth()}-${note.at.getDate()}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(note);
    groups.set(key, bucket);
  }
  for (const group of groups.values()) {
    const heading = document.createElement('p');
    heading.className = 'note-day';
    heading.textContent = formatDayHeader(group[0].at);
    list.append(heading);
    for (const note of group) {
      const row = document.createElement('div');
      row.className = 'note-entry';
      row.tabIndex = 0;
      const copy = document.createElement('span');
      copy.className = 'note-copy';
      const name = document.createElement('span');
      name.className = 'note-title';
      name.textContent = label(note.title, note.titleKey);
      copy.append(name);
      const end = document.createElement('span');
      end.className = 'note-end';
      const time = document.createElement('span');
      time.className = 'note-time';
      time.textContent = formatNoteTime(note);
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
      del.textContent = t.deleteNote;
      pop.append(del);
      menu.append(more, pop);
      end.append(time, menu);
      row.append(noteIcon(), copy, end);
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        const willOpen = pop.hidden;
        closeNoteMenu();
        if (willOpen) {
          pop.hidden = false;
          more.setAttribute('aria-expanded', 'true');
          row.classList.add('menu-open');
        }
      });
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        openDeleteConfirm(note);
      });
      menu.addEventListener('click', (event) => event.stopPropagation());
      row.addEventListener('click', () => {
        view =
          note.status === 'listening' ||
          note.status === 'paused' ||
          note.status === 'idle'
            ? { name: 'listen', workspaceId: id, noteId: note.id }
            : { name: 'note', workspaceId: id, noteId: note.id };
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
  $('mainTitle').textContent = label(note.title, note.titleKey);
  const bullets = (note.summaryKeys ?? []).map((key) => t[key] || key);
  const extra = note.summary ?? [];
  const lines = [...bullets, ...extra];
  const options = workspaces
    .map(
      (workspace) =>
        `<option value="${escapeHtml(workspace.id)}" ${workspace.id === note.workspaceId ? 'selected' : ''}>${escapeHtml(label(workspace.name, workspace.nameKey))}</option>`,
    )
    .join('');
  $('view').innerHTML = `
    <div class="detail">
      <label class="title-label" for="noteTitle">${t.noteTitleLabel}</label>
      <input id="noteTitle" class="title-field" maxlength="120" />
      <span class="status-pill ${note.status}">${statusLabel(note.status)}</span>
      ${lines.length ? `<ol>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ol>` : `<p class="empty">${t.noSummaryYet}</p>`}
      <div class="detail-actions">
        <label for="moveNote">${t.moveNote}</label>
        <select id="moveNote">${options}</select>
        ${note.status === 'failed' ? `<button type="button" id="retryNote"></button>` : ''}
      </div>
    </div>
  `;
  const titleInput = document.getElementById('noteTitle') as HTMLInputElement;
  titleInput.placeholder = t.noteTitlePlaceholder;
  titleInput.value = note.titleKey ? t[note.titleKey] || '' : (note.title ?? '');
  titleInput.addEventListener('input', () => {
    note.title = titleInput.value;
    note.titleKey = undefined;
  });
  const retry = document.getElementById('retryNote');
  if (retry) {
    retry.textContent = t.retry;
    retry.addEventListener('click', () => {
      note.status = 'ready';
      note.summaryKeys = ['mockBullet1', 'mockBullet2', 'mockBullet3'];
      render();
    });
  }
  (document.getElementById('moveNote') as HTMLSelectElement).addEventListener(
    'change',
    (event) => {
      note.workspaceId = (event.target as HTMLSelectElement).value;
      view = { name: 'note', workspaceId: note.workspaceId, noteId: note.id };
      render();
    },
  );
}

function renderListen(workspaceId: string, noteId: string): void {
  const note = notes.find((item) => item.id === noteId);
  if (!note) {
    view = { name: 'workspace', id: workspaceId };
    render();
    return;
  }
  $('mainTitle').textContent = label(note.title, note.titleKey) || t.untitled;
  const listening = note.status === 'listening';
  $('view').innerHTML = `
    <div class="listen">
      <p class="hint">${t.listeningMockHint}</p>
      <label class="title-label" for="noteTitle">${t.noteTitleLabel}</label>
      <input id="noteTitle" class="title-field" maxlength="120" />
      <div class="clock" id="listenClock">${formatClock(listenSeconds)}</div>
      <p id="listenStatus">${statusLabel(note.status)}</p>
      <p class="hint" id="listenQuota"></p>
      <div class="detail-actions">
        <button type="button" class="primary" id="listenStart" ${listening || note.status === 'paused' ? 'disabled' : ''}></button>
        <button type="button" id="listenPause" ${listening ? '' : 'disabled'}></button>
        <button type="button" id="listenResume" ${note.status === 'paused' ? '' : 'disabled'}></button>
        <button type="button" id="listenStop" ${listening || note.status === 'paused' ? '' : 'disabled'}></button>
        <button type="button" class="danger" id="listenCancel"></button>
      </div>
    </div>
  `;
  const titleInput = document.getElementById('noteTitle') as HTMLInputElement;
  titleInput.placeholder = t.noteTitlePlaceholder;
  titleInput.value = note.titleKey ? t[note.titleKey] || '' : (note.title ?? '');
  titleInput.addEventListener('input', () => {
    note.title = titleInput.value;
    note.titleKey = undefined;
  });
  if (me) {
    const minutes = Math.floor(me.remainingSeconds / 60);
    $('listenQuota').textContent = t.remainingTime.replace('{minutes}', String(minutes));
  }
  if (note.status === 'listening' && listenTimer == null) {
    startListenClock();
  }
  $('listenStart').textContent = t.start;
  $('listenPause').textContent = t.pause;
  $('listenResume').textContent = t.resume;
  $('listenStop').textContent = t.stop;
  $('listenCancel').textContent = t.cancel;
  $('listenStart').addEventListener('click', () => {
    note.status = 'listening';
    listenSeconds = 0;
    startListenClock();
    render();
  });
  $('listenPause').addEventListener('click', () => {
    note.status = 'paused';
    stopListenClock();
    render();
  });
  $('listenResume').addEventListener('click', () => {
    note.status = 'listening';
    startListenClock();
    render();
  });
  $('listenStop').addEventListener('click', () => {
    stopListenClock();
    note.status = 'ready';
    note.summaryKeys = ['mockBullet1', 'mockBullet2', 'mockBullet3'];
    const typed = (note.title ?? '').trim();
    if (!typed && !note.titleKey) {
      note.title = t.mockBullet1;
    }
    view = { name: 'note', workspaceId, noteId };
    render();
  });
  $('listenCancel').addEventListener('click', () => {
    if (!window.confirm(t.confirmCancelListen)) {
      return;
    }
    stopListenClock();
    notes = notes.filter((item) => item.id !== note.id);
    view = { name: 'workspace', id: workspaceId };
    render();
  });
}

function deleteWorkspace(id: string): void {
  setSideError('');
  if (workspaces.length <= 1) {
    setSideError(t.errorLastWorkspace);
    return;
  }
  if (notesIn(id).length > 0) {
    setSideError(t.errorWorkspaceNotEmpty);
    return;
  }
  if (!window.confirm(t.confirmDeleteWorkspace)) {
    return;
  }
  workspaces = workspaces.filter((item) => item.id !== id);
  view = { name: 'home' };
  render();
}

function deleteNote(note: Note): void {
  openDeleteConfirm(note);
}

function render(): void {
  setMainError('');
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
  $('mockBanner').textContent = t.mockBanner;
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
  });
  $('signOut').addEventListener('click', async () => {
    await pith.auth.logout();
    await refreshMe();
  });
  $('homeBtn').addEventListener('click', () => {
    view = { name: 'home' };
    render();
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
      closeNoteMenu();
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
  $('openSpike').addEventListener('click', () => pith.shell.openSpike());
  $('confirmCancel').addEventListener('click', () => closeConfirm());
  $('confirmOk').addEventListener('click', () => confirmDeleteNote());
  $('confirmDialog').addEventListener('click', (event) => {
    if (event.target === $('confirmDialog')) {
      closeConfirm();
    }
  });
  document.addEventListener('click', () => closeNoteMenu());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void refreshMe();
    }
  });
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
