import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ExecResult } from '../../../modules/herdr-ssh/src';
import type { HerdrTransport } from '../herdr/transport';
import { displayText } from '../transcript/message';
import { HermesTranscriptStore } from '../transcript/hermesStore';

let home: string;
let store: HermesTranscriptStore;

const sessionId = 'session_hermes-1';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'herdrchat-hermes-'));
  store = new HermesTranscriptStore(new LocalTransport(() => ({ HERMES_HOME: home })));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

class LocalTransport implements HerdrTransport {
  constructor(private readonly env: () => Record<string, string>) {}

  async exec(command: string): Promise<ExecResult> {
    const result = spawnSync('sh', ['-c', command], {
      encoding: 'utf8',
      env: { ...process.env, ...this.env() },
    });
    if (result.error) throw result.error;
    return { ok: true, exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }

  async *streamLines(command: string, _startTimeoutMs: number, signal?: AbortSignal): AsyncIterable<string> {
    if (signal?.aborted) return;
    const result = spawnSync('sh', ['-c', command], {
      encoding: 'utf8',
      env: { ...process.env, ...this.env() },
      timeout: 1_500,
    });
    for (const line of result.stdout.split('\n')) {
      if (line.length > 0) yield line;
    }
  }
}

function createDb(path: string, id = sessionId): void {
  mkdirSync(dirname(path), { recursive: true });
  const script = `
import sqlite3
db = sqlite3.connect(${JSON.stringify(path)})
db.executescript("""
CREATE TABLE sessions(id TEXT PRIMARY KEY, model TEXT);
CREATE TABLE messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  effect_disposition TEXT,
  timestamp REAL NOT NULL,
  token_count INTEGER,
  reasoning TEXT,
  reasoning_content TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  compacted INTEGER NOT NULL DEFAULT 0
);
""")
db.execute("INSERT INTO sessions(id, model) VALUES (?, ?)", (${JSON.stringify(id)}, "openai/gpt-5.6"))
db.commit()
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function createLegacyDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const script = `
import sqlite3
db = sqlite3.connect(${JSON.stringify(path)})
db.executescript("""
CREATE TABLE sessions(id TEXT PRIMARY KEY);
CREATE TABLE messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  timestamp REAL NOT NULL,
  token_count INTEGER,
  reasoning TEXT,
  reasoning_content TEXT
);
""")
db.execute("INSERT INTO sessions(id) VALUES (?)", (${JSON.stringify(sessionId)},))
db.execute("INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, 'assistant', 'legacy ok', 1)", (${JSON.stringify(sessionId)},))
db.commit()
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function createMissingSessionsDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const script = `
import sqlite3
db = sqlite3.connect(${JSON.stringify(path)})
db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)")
db.commit()
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function createCorruptDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'this is not sqlite');
}

function insert(path: string, values: {
  session?: string;
  role: string;
  content: string;
  toolCalls?: string | null;
  toolCallId?: string | null;
  reasoning?: string | null;
  timestamp?: number;
}): void {
  const script = `
import sqlite3
db = sqlite3.connect(${JSON.stringify(path)})
db.execute("INSERT INTO messages(session_id, role, content, tool_call_id, tool_calls, timestamp, token_count, reasoning_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (
  ${JSON.stringify(values.session ?? sessionId)},
  ${JSON.stringify(values.role)},
  ${JSON.stringify(values.content)},
  ${pythonValue(values.toolCallId ?? null)},
  ${pythonValue(values.toolCalls ?? null)},
  ${JSON.stringify(values.timestamp ?? 1)},
  99,
  ${pythonValue(values.reasoning ?? null)}
))
db.commit()
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function pythonValue(value: string | null): string {
  return value === null ? 'None' : JSON.stringify(value);
}

it('resolves the exact session in HERMES_HOME and reads recent UTF-8 history', async () => {
  const path = join(home, 'state.db');
  createDb(path);
  insert(path, { role: 'user', content: '안녕 👋' });
  insert(path, {
    role: 'assistant',
    content: '\0json:' + JSON.stringify([{ type: 'text', text: '반가워요 ✅' }]),
    toolCalls: JSON.stringify([{ id: 'call-1', function: { name: 'bash', arguments: { cmd: 'pwd' } } }]),
    reasoning: '생각',
    timestamp: 2,
  });

  expect(await store.resolveSession(sessionId)).toBe(path);
  const recent = await store.recent(path, sessionId, 'hermes');
  expect(recent.meta).toEqual({ model: 'openai/gpt-5.6', contextTokens: null });
  expect(recent.messages.map(displayText)).toEqual(['안녕 👋', '반가워요 ✅']);
  expect(recent.firstId).toBe(1);
  expect(recent.lastId).toBe(2);
  expect(recent.reachedStart).toBe(true);
  expect(recent.messages[1]?.segments[0]).toEqual({ kind: 'thinking', text: '생각' });
});

it('searches profile databases, returns missing as null, and rejects ambiguity', async () => {
  const profile = join(home, 'profiles', 'work', 'state.db');
  createDb(profile);
  expect(await store.resolveSession(sessionId)).toBe(profile);
  expect(await store.resolveSession('missing')).toBeNull();

  createDb(join(home, 'state.db'));
  await expect(store.resolveSession(sessionId)).rejects.toMatchObject({ code: 'hermes_session_ambiguous' });
});

it('rejects resolution when any candidate database cannot be inspected', async () => {
  const profile = join(home, 'profiles', 'work', 'state.db');
  createDb(profile);
  createCorruptDb(join(home, 'state.db'));
  await expect(store.resolveSession(sessionId)).rejects.toMatchObject({ code: 'hermes_database_unreadable' });
});

it('rejects resolution when a candidate is missing the sessions schema', async () => {
  const profile = join(home, 'profiles', 'work', 'state.db');
  createDb(profile);
  createMissingSessionsDb(join(home, 'state.db'));
  await expect(store.resolveSession(sessionId)).rejects.toMatchObject({ code: 'hermes_database_unreadable' });
});

it('uses row ids for older windows and never includes another session', async () => {
  const path = join(home, 'state.db');
  createDb(path);
  insert(path, { role: 'user', content: 'first', timestamp: 1 });
  insert(path, { role: 'assistant', content: 'second', timestamp: 2 });
  insert(path, { session: 'foreign', role: 'assistant', content: 'secret', timestamp: 3 });
  const older = await store.older(path, sessionId, null, 2, 50);
  expect(older.messages.map(displayText)).toEqual(['first']);
  expect(older.lastId).toBe(1);
  expect(older.reachedStart).toBe(true);
});

it('batches latest messages best-effort and filters missing or foreign sessions', async () => {
  const path = join(home, 'state.db');
  createDb(path);
  insert(path, { role: 'user', content: 'hi', timestamp: 1 });
  insert(path, { role: 'assistant', content: 'latest', timestamp: 2 });
  insert(path, { role: 'tool', content: 'machinery', toolCallId: 'call-1', timestamp: 3 });
  const latest = await store.latestMessages([
    { workspaceId: 'w1', sessionId },
    { workspaceId: 'w2', sessionId: 'missing' },
    { workspaceId: 'bad id', sessionId },
  ]);
  expect([...latest].map(([id, message]) => [id, displayText(message)])).toEqual([['w1', 'latest']]);
});

it('rejects batched previews instead of falling back past an unreadable candidate', async () => {
  const profile = join(home, 'profiles', 'work', 'state.db');
  createDb(profile);
  insert(profile, { role: 'assistant', content: 'profile latest', timestamp: 1 });
  createCorruptDb(join(home, 'state.db'));
  await expect(store.latestMessages([{ workspaceId: 'w1', sessionId }]))
    .rejects.toMatchObject({ code: 'hermes_database_unreadable' });
});

it('reads legacy Hermes schemas without optional active, compacted, effect, or model columns', async () => {
  const path = join(home, 'state.db');
  createLegacyDb(path);
  const recent = await store.recent(path, sessionId, null);
  expect(recent.meta).toBeNull();
  expect(recent.messages.map(displayText)).toEqual(['legacy ok']);
});

it('refuses unsafe ids and paths before shelling into SQLite', async () => {
  expect(await store.resolveSession('../secret')).toBeNull();
  expect(await store.recent('/tmp/../state.db', sessionId, null)).toMatchObject({ messages: [] });
});

it('tails rows after an explicit row cursor and yields heartbeats', async () => {
  const path = join(home, 'state.db');
  createDb(path);
  insert(path, { role: 'user', content: 'old', timestamp: 1 });
  insert(path, { role: 'assistant', content: 'new', timestamp: 2 });
  const controller = new AbortController();
  const seen: string[] = [];
  try {
    for await (const chunk of store.tail(path, sessionId, 'hermes', 1, controller.signal)) {
      if (chunk.message !== null) seen.push(displayText(chunk.message));
      if (seen.length === 1) break;
    }
  } catch {
    // The SSH transport can report a killed stream differently across platforms;
    // the cursor assertion above is the contract this test cares about.
  }
  expect(seen).toEqual(['new']);
});
