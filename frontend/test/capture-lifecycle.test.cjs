const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const NOTE = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';

function load(relative, overrides = {}, extra = '', globals = {}, skipInit = false) {
  const filename = path.join(root, relative);
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  let source = fs.readFileSync(filename, 'utf8');
  if (skipInit) source = source.replace('void init();', '');
  const code = ts.transpileModule(source + extra, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const requireLocal = (name) => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    const next = path.resolve(path.dirname(filename), name + '.ts');
    return name.startsWith('.') && fs.existsSync(next) ? load(path.relative(root, next)) : nativeRequire(name);
  };
  vm.runInNewContext(code, { require: requireLocal, module, exports: module.exports,
    __dirname: path.dirname(filename), Buffer, process, console, Error, Promise, URL, AbortSignal,
    Uint8Array, setInterval, clearInterval, setTimeout, clearTimeout, ...globals }, { filename });
  return module.exports;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'pith-lifecycle-test-'));
  const handlers = new Map();
  let state = 'listening';
  let stopCalls = 0;
  const api = { uploadSlice: async () => {}, sealNote: async () => {},
    getNote: async () => ({ status: 'ready', summaryText: ['Summary'] }) };
  class Capture {
    subscribeHelperLog() {} subscribeLevels() {} subscribeDevice() {}
    getState() { return state; }
    async start() { state = 'listening'; return {}; }
    async stop() { stopCalls++; state = 'idle'; return { filePath: path.join(home, 'tail.wav'), durationSeconds: 300 }; }
    async cancel() { state = 'idle'; }
  }
  const main = load('src/main.ts', {
    electron: { app: { getPath: () => home, on() {}, whenReady: () => ({ then() {} }) },
      ipcMain: { handle: (key, fn) => handlers.set(key, fn) } },
    './capture/native-capture.service': { NativeCaptureService: Capture },
    './auth/auth.service': { AuthService: class {} },
    './capture/helper-client': {},
    './env': { loadFrontendEnv() {}, backendUrl: () => '', captureSpikeKey: () => '' },
    './debug/session-trace': { trace() {}, resetSessionTrace() {} },
    './ask/ask-api': { createAskApi: () => ({}) },
    './notes/notes-api': { createNotesApi: () => api },
    './spike/spike-client': { SpikeClient: class {} },
    './i18n/en.json': {}, './i18n/es.json': {},
    './capture/segment-tracks': { segmentTracks: () => [{ source: 'mic', startSec: 0, endSec: 300, wav: Buffer.from('piece') }], splitLongSegments: (x) => x },
  }, '\nmodule.exports.test = { uploadQueue, stopExportTimer };', {
    process: { ...process, stderr: { write() {} }, on() {} },
    console: { log() {}, error() {} },
    fetch: async () => ({ ok: true, json: async () => ({ minListenSeconds: 15, pauseAutoCancelSeconds: 60, uploadRetrySeconds: 600, wavChunkSeconds: 600 }) }),
  });
  const call = async (channel, ...args) => {
    const result = await handlers.get(channel)(null, ...args);
    if (!result.ok) throw new Error(result.error.code);
    return result.data;
  };
  t.after(async () => {
    main.test.stopExportTimer();
    await fsp.rm(home, { recursive: true, force: true });
  });
  await fsp.writeFile(path.join(home, 'tail.wav'), 'tail');
  await call('capture:arm', NOTE);
  return { api, call, home, queue: main.test.uploadQueue,
    idle: () => { state = 'idle'; }, stopCalls: () => stopCalls };
}

test('old Generate cannot arm/reset a new note until seal accepts; summary polling can overlap', async (t) => {
  const f = await fixture(t);
  const entered = deferred(), seal = deferred(), polled = deferred(), summary = deferred();
  f.api.sealNote = async () => { entered.resolve(); await seal.promise; };
  f.api.getNote = async () => { polled.resolve(); return summary.promise; };
  const generation = f.call('debug:stopAndTranscribe', NOTE, 'Typed notes');
  await entered.promise;
  await assert.rejects(f.call('capture:arm', NEXT), /capture_finishing/);
  await assert.rejects(f.call('capture:start'), /capture_finishing/);
  assert.equal(f.queue.noteId, NOTE);
  seal.resolve();
  await polled.promise;
  await f.call('capture:arm', NEXT);
  assert.equal(f.queue.noteId, NEXT);
  summary.resolve({ status: 'ready', summaryText: ['Result'] });
  await generation;
  assert.equal(f.queue.noteId, NEXT);
  assert.equal(f.stopCalls(), 1);
});

test('recovered Generate drains and seals without stopping the idle native recorder', async (t) => {
  const f = await fixture(t);
  await f.queue.enqueue(NOTE, { filePath: path.join(f.home, 'tail.wav'), durationSeconds: 300 });
  f.idle();
  let sealed = false;
  f.api.getNote = async () => ({ status: sealed ? 'ready' : 'listening', summaryText: ['Recovered'] });
  f.api.sealNote = async (_id, seq, seconds) => {
    assert.equal(seq, 1); assert.equal(seconds, 300); sealed = true;
  };
  await f.call('debug:stopAndTranscribe', NOTE, 'Recovered typed notes');
  assert.equal(sealed, true);
  assert.equal(f.stopCalls(), 0);
  assert.equal(f.queue.noteId, null);
});

test('a lost seal response is reconciled with the server instead of reported as a failed recording', async (t) => {
  const f = await fixture(t);
  f.api.sealNote = async () => { throw new Error('request_timeout'); };
  const result = await f.call('debug:stopAndTranscribe', NOTE, 'Notes');
  assert.equal(result.status, 'ready');
  assert.equal(f.queue.noteId, null);
});

test('an unconfirmed seal keeps progress and retries without stopping the native recorder twice', async (t) => {
  const f = await fixture(t);
  f.api.sealNote = async () => { throw new Error('request_timeout'); };
  f.api.getNote = async () => { throw new Error('offline'); };
  await assert.rejects(f.call('debug:stopAndTranscribe', NOTE, 'Notes'), /request_timeout/);
  assert.equal(f.queue.noteId, NOTE);
  assert.equal(f.queue.durationSeconds, 300);
  let sealed = false;
  f.api.getNote = async () => ({ status: sealed ? 'ready' : 'listening', summaryText: ['Retried'] });
  f.api.sealNote = async () => { sealed = true; };
  await f.call('debug:stopAndTranscribe', NOTE, 'Notes');
  assert.equal(f.stopCalls(), 1);
});

test('the recovered Generate button invokes generation even though the new window clock is zero', () => {
  const source = ts.createSourceFile('debug.ts', fs.readFileSync(path.join(root, 'src/renderer/debug.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "$('generate').addEventListener") callback = node.arguments[1].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const elements = new Map();
  const debug = load('src/renderer/debug.ts', {}, `
    let invoked = false;
    withBusy = async () => { invoked = true; };
    module.exports.test = () => {
      minListenSeconds = 30; recordedMs = 0; runningSince = null;
      uploadPaused = true; captureState = 'idle';
      applyGenerateEnabled();
      const enabled = !$('generate').disabled;
      (${callback})();
      return { enabled, invoked };
    };
  `, { document: { getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, { classList: { toggle() {} }, setAttribute() {} });
    return elements.get(id);
  } } }, true);
  const result = debug.test();
  assert.equal(result.enabled, true);
  assert.equal(result.invoked, true);
});

test('retry retains a stopped tail when copying it to the local queue failed', async (t) => {
  const f = await fixture(t);
  t.mock.method(fsp, 'copyFile', async () => { throw new Error('temporary disk failure'); });
  await assert.rejects(f.call('debug:stopAndTranscribe', NOTE, 'Notes'), /internal_error/);
  assert.equal(f.stopCalls(), 1);
  t.mock.reset();
  let sealed = false;
  f.api.getNote = async () => ({ status: sealed ? 'ready' : 'listening', summaryText: ['Recovered tail'] });
  f.api.sealNote = async (_id, seq, seconds) => {
    assert.equal(seq, 1); assert.equal(seconds, 300); sealed = true;
  };
  await f.call('debug:stopAndTranscribe', NOTE, 'Notes');
  assert.equal(sealed, true);
  assert.equal(f.stopCalls(), 1);
});
