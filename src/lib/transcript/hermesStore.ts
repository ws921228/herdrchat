import { exitCodeError } from '../herdr/client';
import { HerdrError, transportError } from '../herdr/protocol';
import { shellQuote, withPath } from '../herdr/shell';
import { STREAM_START_TIMEOUT_MS, TRANSCRIPT_TIMEOUT_MS } from '../herdr/timeouts';
import type { HerdrTransport } from '../herdr/transport';
import type { ChatMessage } from './message';
import { isToolOnly } from './message';
import { parseTranscriptEntry } from './parser';
import type { SessionMeta } from './sessionMeta';

export interface HermesWindow {
  messages: ChatMessage[];
  meta: SessionMeta | null;
  firstId: number;
  lastId: number;
  reachedStart: boolean;
}

export interface HermesChunk {
  message: ChatMessage | null;
  meta: SessionMeta | null;
  lastId: number;
}

export interface HermesPreviewRequest {
  workspaceId: string;
  sessionId: string | null;
}

const CODE = String.raw`
import json, os, sqlite3, sys, time
from pathlib import Path

BASE_FIELDS = {
    "row_id": "m.id",
    "session_id": "m.session_id",
    "role": "m.role",
    "content": "m.content",
    "tool_call_id": "m.tool_call_id",
    "tool_calls": "m.tool_calls",
    "tool_name": "m.tool_name",
    "effect_disposition": "m.effect_disposition",
    "timestamp": "m.timestamp",
    "token_count": "m.token_count",
    "reasoning": "m.reasoning",
    "reasoning_content": "m.reasoning_content",
    "model": "s.model",
}

def out(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)

def home():
    return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes")).expanduser()

def candidates():
    root = home()
    seen = set()
    for path in [root / "state.db", *sorted((root / "profiles").glob("*/state.db"))]:
        text = str(path)
        if text not in seen:
            seen.add(text)
            yield path

def connect(path):
    uri = path.resolve().as_uri() + "?mode=ro"
    db = sqlite3.connect(uri, uri=True, timeout=1.0)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    return db

def columns(db, table):
    return {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}

def fields(db):
    message_columns = columns(db, "messages")
    session_columns = columns(db, "sessions")
    selected = []
    for alias, expression in BASE_FIELDS.items():
        table, column = expression.split(".", 1)
        available = session_columns if table == "s" else message_columns
        selected.append(f"{expression} AS {alias}" if column in available else f"NULL AS {alias}")
    return ", ".join(selected)

def active_clause(db):
    message_columns = columns(db, "messages")
    if "active" in message_columns and "compacted" in message_columns:
        return " AND (m.active = 1 OR m.compacted = 1)"
    if "active" in message_columns:
        return " AND m.active = 1"
    return ""

def has_session(db, session_id):
    return db.execute("SELECT 1 FROM sessions WHERE id = ? LIMIT 1", (session_id,)).fetchone() is not None

def read_failure(path, exc):
    return {"path": str(path), "message": str(exc).splitlines()[0][:200]}

def resolve(session_id):
    matches = []
    failures = []
    for path in candidates():
        if not path.is_file():
            continue
        try:
            with connect(path) as db:
                if has_session(db, session_id):
                    matches.append(str(path))
        except sqlite3.Error as exc:
            failures.append(read_failure(path, exc))
    if failures:
        failure = failures[0]
        out({"ok": False, "error": "read_failed", "path": failure["path"], "message": failure["message"]})
        return 0
    if len(matches) > 1:
        out({"ok": False, "error": "ambiguous"})
        return 0
    out({"ok": True, "path": matches[0] if matches else None})
    return 0

def session_meta(db, session_id):
    model_sql = "model" if "model" in columns(db, "sessions") else "NULL AS model"
    row = db.execute(f"SELECT {model_sql} FROM sessions WHERE id = ? LIMIT 1", (session_id,)).fetchone()
    if row is None:
        return None
    model = row["model"]
    return {"model": model if model else None, "contextTokens": None}

def rows(db, session_id, where, params, limit):
    sql = f"SELECT {fields(db)} FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.session_id = ?{active_clause(db)} {where} ORDER BY m.id DESC LIMIT ?"
    selected = [dict(row) for row in db.execute(sql, (session_id, *params, limit)).fetchall()]
    return list(reversed(selected))

def window(path, session_id, mode, cursor, limit):
    with connect(Path(path)) as db:
        if not has_session(db, session_id):
            out({"ok": True, "messages": [], "meta": None, "firstId": 0, "lastId": 0, "reachedStart": True})
            return 0
        if mode == "recent":
            selected = rows(db, session_id, "", (), limit)
        else:
            selected = rows(db, session_id, "AND m.id < ?", (int(cursor),), limit)
        first_id = int(selected[0]["row_id"]) if selected else 0
        last_id = int(selected[-1]["row_id"]) if selected else (int(cursor) if cursor is not None else 0)
        earlier_sql = "SELECT 1 FROM messages m WHERE m.session_id = ?" + active_clause(db) + " AND m.id < ? LIMIT 1"
        earlier = db.execute(earlier_sql, (session_id, first_id)).fetchone() if selected else None
        out({"ok": True, "messages": selected, "meta": session_meta(db, session_id), "firstId": first_id, "lastId": last_id, "reachedStart": earlier is None})
    return 0

def latest(requests):
    results = {}
    failures = []
    for req in requests:
        workspace_id = req.get("workspaceId")
        session_id = req.get("sessionId")
        if not isinstance(workspace_id, str) or not isinstance(session_id, str):
            continue
        matches = []
        for path in candidates():
            if not path.is_file():
                continue
            try:
                with connect(path) as db:
                    if has_session(db, session_id):
                        sql = f"SELECT {fields(db)} FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.session_id = ?{active_clause(db)} ORDER BY m.id DESC LIMIT 50"
                        matches.append((path, db.execute(sql, (session_id,)).fetchall()))
            except sqlite3.Error as exc:
                failures.append(read_failure(path, exc))
        if len(matches) != 1:
            continue
        results[workspace_id] = [dict(row) for row in matches[0][1]]
    if failures:
        failure = failures[0]
        out({"ok": False, "error": "read_failed", "path": failure["path"], "message": failure["message"]})
        return 0
    out({"ok": True, "messages": results})
    return 0

def tail(path, session_id, after_id):
    last_id = int(after_id)
    while True:
        try:
            with connect(Path(path)) as db:
                sql = f"SELECT {fields(db)} FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.session_id = ?{active_clause(db)} AND m.id > ? ORDER BY m.id ASC LIMIT 100"
                selected = [dict(row) for row in db.execute(sql, (session_id, last_id)).fetchall()]
                meta = session_meta(db, session_id)
                if selected:
                    for row in selected:
                        last_id = int(row["row_id"])
                        out({"ok": True, "message": row, "meta": meta, "lastId": last_id})
                else:
                    out({"ok": True, "message": None, "meta": meta, "lastId": last_id})
        except sqlite3.Error as exc:
            out({"ok": False, "error": str(exc), "lastId": last_id})
        time.sleep(1.0)

def main(argv):
    mode = argv[1]
    if mode == "resolve":
        return resolve(argv[2])
    if mode == "recent":
        return window(argv[2], argv[3], "recent", None, int(argv[4]))
    if mode == "older":
        return window(argv[2], argv[3], "older", int(argv[4]), int(argv[5]))
    if mode == "latest":
        return latest(json.loads(argv[2]))
    if mode == "tail":
        tail(argv[2], argv[3], int(argv[4]))
        return 0
    return 64

raise SystemExit(main(sys.argv))
`;

export class HermesTranscriptStore {
  private readonly transport: HerdrTransport;

  constructor(transport: HerdrTransport) {
    this.transport = transport;
  }

  async resolveSession(sessionId: string): Promise<string | null> {
    if (!safeSessionId(sessionId)) return null;
    const response = await this.run(['resolve', sessionId]);
    if (response.ok !== true) throw hermesResponseError(response);
    return typeof response.path === 'string' && response.path.startsWith('/') ? response.path : null;
  }

  async recent(path: string, sessionId: string, label: string | null, limit = 200): Promise<HermesWindow> {
    return this.window(['recent', path, sessionId, String(limit)], sessionId, label);
  }

  async older(path: string, sessionId: string, label: string | null, beforeId: number, limit = 200): Promise<HermesWindow> {
    return this.window(['older', path, sessionId, String(beforeId), String(limit)], sessionId, label);
  }

  async *tail(path: string, sessionId: string, label: string | null, afterId: number, signal?: AbortSignal): AsyncIterable<HermesChunk> {
    if (!safePath(path) || !safeSessionId(sessionId) || !Number.isFinite(afterId) || afterId < 0) return;
    const command = this.command(['tail', path, sessionId, String(afterId)]);
    for await (const line of this.transport.streamLines(command, STREAM_START_TIMEOUT_MS, signal)) {
      const raw = record(parseJson(line));
      if (raw === null) continue;
      if (raw.ok !== true) {
        throw new HerdrError('hermes_tail_failed', typeof raw.error === 'string' ? raw.error : 'Hermes transcript tail failed.');
      }
      const row = record(raw.message);
      const parsed = row === null ? { message: null, meta: null } : parseTranscriptEntry(JSON.stringify({ type: 'hermes_message', ...row }), label);
      const meta = parsed.meta ?? metaFromValue(raw.meta);
      const lastId = numberValue(raw.lastId) ?? afterId;
      yield { message: parsed.message, meta, lastId };
      afterId = lastId;
    }
  }

  async latestMessages(requests: readonly HermesPreviewRequest[]): Promise<Map<string, ChatMessage>> {
    const usable = requests.filter(request => request.sessionId !== null && safeWorkspaceId(request.workspaceId) && safeSessionId(request.sessionId));
    if (usable.length === 0) return new Map();
    const response = await this.run(['latest', JSON.stringify(usable)]);
    if (response.ok !== true) throw hermesResponseError(response);
    const messages = record(response.messages);
    const result = new Map<string, ChatMessage>();
    if (messages === null) return result;
    for (const [workspaceId, value] of Object.entries(messages)) {
      const rows = Array.isArray(value) ? value : [value];
      for (const rowValue of rows) {
        const row = record(rowValue);
        if (row === null) continue;
        const parsed = parseTranscriptEntry(JSON.stringify({ type: 'hermes_message', ...row }), null).message;
        if (parsed !== null && !parsed.isSidechain && !isToolOnly(parsed)) {
          result.set(workspaceId, parsed);
          break;
        }
      }
    }
    return result;
  }

  private async window(args: string[], sessionId: string, label: string | null): Promise<HermesWindow> {
    if (!safePath(args[1] ?? '') || !safeSessionId(sessionId)) return emptyWindow();
    const response = await this.run(args);
    const rawMessages = Array.isArray(response.messages) ? response.messages : [];
    const messages = rawMessages.flatMap((row): ChatMessage[] => {
      const parsed = parseTranscriptEntry(JSON.stringify({ type: 'hermes_message', ...record(row) }), label).message;
      return parsed === null ? [] : [parsed];
    });
    return {
      messages,
      meta: metaFromValue(response.meta),
      firstId: numberValue(response.firstId) ?? 0,
      lastId: numberValue(response.lastId) ?? 0,
      reachedStart: response.reachedStart === true,
    };
  }

  private async run(args: readonly string[]): Promise<Record<string, unknown>> {
    const text = await this.shell(this.command(args));
    const parsed = record(parseJson(text.trim()));
    if (parsed === null) throw new HerdrError('hermes_invalid_response', 'The host returned an invalid Hermes transcript response.');
    return parsed;
  }

  private command(args: readonly string[]): string {
    return withPath(['python3', '-c', CODE, ...args].map(shellQuote).join(' '));
  }

  private async shell(command: string): Promise<string> {
    const result = await this.transport.exec(command, TRANSCRIPT_TIMEOUT_MS);
    if (!result.ok) throw transportError(result);
    if (result.exitCode !== 0) throw exitCodeError(result.exitCode, result.stderr);
    return result.stdout;
  }
}

function emptyWindow(): HermesWindow {
  return { messages: [], meta: null, firstId: 0, lastId: 0, reachedStart: true };
}

function hermesResponseError(response: Record<string, unknown>): HerdrError {
  if (response.error === 'read_failed') {
    const detail = typeof response.message === 'string' && response.message.length > 0 ? ` ${response.message}` : '';
    return new HerdrError('hermes_database_unreadable', `A Hermes database could not be inspected.${detail}`);
  }
  return new HerdrError('hermes_session_ambiguous', 'More than one Hermes database has this session id.');
}

function metaFromValue(value: unknown): SessionMeta | null {
  const raw = record(value);
  if (raw === null) return null;
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  const contextTokens = numberValue(raw.contextTokens);
  return model === null && contextTokens === null ? null : { model, contextTokens };
}

function safeSessionId(value: string | null): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]+$/.test(value);
}

function safeWorkspaceId(value: string): boolean {
  return /^[A-Za-z0-9:_-]+$/.test(value);
}

function safePath(value: string): boolean {
  return value.startsWith('/') && !/[\0\r\n]/.test(value) && !value.split('/').includes('..');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
