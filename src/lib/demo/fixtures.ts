/**
 * The fictional machine the demo connects to.
 *
 * Everything here is invented. The shapes are herdr's, so the real decoders in
 * `models.ts` accept them without a special case — if herdr's shape changes,
 * this fails the same way a real host would, which is the point of using the
 * real path rather than a mock.
 */

import { splitImages } from '../transcript/images';

export interface DemoWorkspace {
  workspaceId: string;
  label: string;
  number: number;
  paneId: string;
  cwd: string;
  agentStatus: 'idle' | 'working' | 'blocked' | 'done';
  /** Claude unless named; OMP reports a journal path, Hermes reports a native session id. */
  agent?: 'claude' | 'omp' | 'hermes';
}

export const DEMO_WORKSPACES: readonly DemoWorkspace[] = [
  {
    workspaceId: 'w1',
    label: 'herdrchat',
    number: 1,
    paneId: 'w1:p1',
    cwd: '/home/demo/herdrchat',
    agentStatus: 'blocked',
  },
  {
    workspaceId: 'w2',
    label: 'notes',
    number: 2,
    paneId: 'w2:p1',
    cwd: '/home/demo/notes',
    agentStatus: 'idle',
  },
  {
    workspaceId: 'w3',
    label: 'scratch',
    number: 3,
    paneId: 'w3:p1',
    cwd: '/home/demo/scratch',
    agentStatus: 'done',
  },
  {
    workspaceId: 'w4',
    label: 'ledger',
    number: 4,
    paneId: 'w4:p1',
    cwd: '/home/demo/ledger',
    agentStatus: 'idle',
    agent: 'omp',
  },
  {
    workspaceId: 'w5',
    label: 'hermes',
    number: 5,
    paneId: 'w5:p1',
    cwd: '/home/demo/hermes',
    agentStatus: 'idle',
    agent: 'hermes',
  },
];

/** Where the OMP demo agent keeps its journal, which herdr reports as its session. */
export const DEMO_OMP_PATHS: Readonly<Record<string, string>> = {
  'w4:p1': '/home/demo/.omp/agent/sessions/--home-demo-ledger--/2026-09-28T09-00-00_44444444-4444-4444-8444-444444444444.jsonl',
};

export const DEMO_HERMES_DB = '/home/demo/.hermes/state.db';

/** The Hermes native session id herdr reports. */
export const DEMO_HERMES_SESSION_IDS: Readonly<Record<string, string>> = {
  'w5:p1': 'session_hermes-demo',
};

/** The Claude session id each demo workspace reports, and therefore its transcript filename. */
export const DEMO_SESSION_IDS: Readonly<Record<string, string>> = {
  'w1:p1': '11111111-1111-4111-8111-111111111111',
  'w2:p1': '22222222-2222-4222-8222-222222222222',
  'w3:p1': '33333333-3333-4333-8333-333333333333',
};

export const DEMO_HOME = '/home/demo';

// MARK: - Transcripts
//
// Claude Code's own JSONL, one object per line, so the real parser handles it
// with no special case. The emoji is deliberate: byte offsets are UTF-8 bytes
// and `String.length` is UTF-16 units, and a demo that quietly used only ASCII
// would skip the one rule most likely to break a reader.

interface Line {
  type: 'user' | 'assistant';
  uuid: string;
  timestamp: string;
  content: unknown;
  model?: string;
}

function line({ type, uuid, timestamp, content, model }: Line): string {
  const message: Record<string, unknown> = { role: type, content };
  if (model !== undefined) {
    message.model = model;
    message.usage = { input_tokens: 18_420, cache_read_input_tokens: 61_300 };
  }
  // Claude records the turn's effort beside the message; the header shows it.
  return JSON.stringify(model === undefined ? { type, uuid, timestamp, message } : { type, uuid, timestamp, effort: 'high', message });
}

const MODEL = 'claude-opus-5';

const SEEDS: Readonly<Record<string, readonly string[]>> = {
  'w1:p1': [
    line({
      type: 'user',
      uuid: 'd1-1',
      timestamp: '2026-08-19T09:12:04.000Z',
      content: 'the folder picker shows "No subfolders here" even when the read failed. can you look?',
    }),
    line({
      type: 'assistant',
      uuid: 'd1-2',
      timestamp: '2026-08-19T09:12:19.000Z',
      model: MODEL,
      content: [
        {
          type: 'text',
          text: "Found it. `listDirectories` appended `; true`, so an unreadable path exits 0 and an empty directory, a wrong path and a dropped connection all arrive looking identical.\n\nI'll split error from empty and give the error state a Retry.",
        },
      ],
    }),
    line({
      type: 'assistant',
      uuid: 'd1-3',
      timestamp: '2026-08-19T09:12:41.000Z',
      model: MODEL,
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/lib/herdr/client.ts' } },
      ],
    }),
    line({
      type: 'user',
      uuid: 'd1-4',
      timestamp: '2026-08-19T09:13:02.000Z',
      content: 'nice 🎯 ship it',
    }),
    line({
      type: 'assistant',
      uuid: 'd1-5',
      timestamp: '2026-08-19T09:13:30.000Z',
      model: MODEL,
      content: [
        {
          type: 'text',
          text: 'Before I write to `client.ts`: this changes what every caller of `listDirectories` sees on failure. Want me to go ahead?',
        },
      ],
    }),
  ],
  'w2:p1': [
    line({
      type: 'user',
      uuid: 'd2-1',
      timestamp: '2026-08-19T08:40:00.000Z',
      content: 'summarise the release notes into three bullets',
    }),
    line({
      type: 'assistant',
      uuid: 'd2-2',
      timestamp: '2026-08-19T08:40:22.000Z',
      model: MODEL,
      content: [
        {
          type: 'text',
          text: '- Host keys are pinned on first contact and shown as `SHA256:…`\n- The transcript cursor no longer skips a message on a lossy decode\n- Blocked prompts disable their options while a reply is in flight',
        },
      ],
    }),
  ],
  'w3:p1': [
    line({
      type: 'user',
      uuid: 'd3-1',
      timestamp: '2026-08-19T07:05:00.000Z',
      content: 'scratch pad — nothing running here',
    }),
  ],
};

// MARK: - OMP
//
// OMP's own journal (oh-my-pi), as the OMP parser reads it: a session header,
// then one record per message, tool results naming their call.

const OMP_MODEL = 'anthropic/claude-sonnet-5';

function ompRecord(id: string, timestamp: string, message: Record<string, unknown>): string {
  return JSON.stringify({ type: 'message', id, parentId: null, timestamp, message: { timestamp: Date.parse(timestamp), ...message } });
}

const OMP_SEED: readonly string[] = [
  JSON.stringify({ type: 'session', version: 3, id: '44444444-4444-4444-8444-444444444444', timestamp: '2026-08-19T08:00:00.000Z', cwd: '/home/demo/ledger' }),
  ompRecord('o-1', '2026-08-19T08:01:00.000Z', { role: 'user', content: 'why does the monthly total skip the last day?' }),
  ompRecord('o-2', '2026-08-19T08:01:10.000Z', {
    role: 'assistant', model: OMP_MODEL,
    content: [{ type: 'toolCall', id: 'o-call-1', name: 'read', arguments: { path: 'src/totals.ts' } }],
  }),
  ompRecord('o-3', '2026-08-19T08:01:11.000Z', { role: 'toolResult', toolCallId: 'o-call-1', toolName: 'read', content: [{ type: 'text', text: 'export function monthTotal(…)' }] }),
  ompRecord('o-4', '2026-08-19T08:01:20.000Z', {
    role: 'assistant', model: OMP_MODEL,
    content: [{ type: 'text', text: 'The range ends with `<` on the first of the month, so the last day is never counted. Changing it to `<=` on the last day fixes it.' }],
  }),
];

/** One more OMP user or assistant record, for when the demo is used. */
export function ompLine(role: 'user' | 'assistant', text: string, id: string, timestamp: string): string {
  return ompRecord(id, timestamp, role === 'user'
    ? { role, content: text }
    : { role, model: OMP_MODEL, content: [{ type: 'text', text }] });
}

// MARK: - Hermes
//
// Hermes persists messages in SQLite. The demo host does not fake a JSONL file:
// it answers the small read-only helper protocol used by HermesTranscriptStore.

export const HERMES_MODEL = 'openai/gpt-5.6';

export interface HermesDemoRow {
  row_id: number;
  session_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  effect_disposition: string | null;
  timestamp: number;
  token_count: number | null;
  reasoning: string | null;
  reasoning_content: string | null;
  model: string | null;
}

const HERMES_JSON_PREFIX = '\0json:';

function hermesTimestamp(timestamp: string): number {
  return Date.parse(timestamp) / 1000;
}

function hermesText(text: string): string {
  return `${HERMES_JSON_PREFIX}${JSON.stringify([{ type: 'text', text }])}`;
}

export function hermesRowsFor(paneId: string): readonly HermesDemoRow[] {
  const session = DEMO_HERMES_SESSION_IDS[paneId];
  if (session === undefined) return [];
  return [
    hermesUserRow(session, 1, 'summarise this Hermes session source', '2026-08-19T08:30:00.000Z'),
    hermesAssistantRow(
      session,
      2,
      'Hermes history is coming from the demo SQLite transport, not a Claude JSONL transcript.',
      '2026-08-19T08:30:14.000Z',
      'Reading rows from state.db.'
    ),
  ];
}

export function hermesUserRow(sessionId: string, rowId: number, text: string, timestamp: string): HermesDemoRow {
  return {
    row_id: rowId,
    session_id: sessionId,
    role: 'user',
    content: text,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    effect_disposition: null,
    timestamp: hermesTimestamp(timestamp),
    token_count: null,
    reasoning: null,
    reasoning_content: null,
    model: null,
  };
}

export function hermesAssistantRow(
  sessionId: string,
  rowId: number,
  text: string,
  timestamp: string,
  reasoning: string | null = null
): HermesDemoRow {
  return {
    row_id: rowId,
    session_id: sessionId,
    role: 'assistant',
    content: hermesText(text),
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    effect_disposition: null,
    timestamp: hermesTimestamp(timestamp),
    token_count: 42_000,
    reasoning,
    reasoning_content: reasoning,
    model: HERMES_MODEL,
  };
}

/** The transcript a demo pane starts with, as the file's contents. */
export function transcriptFor(paneId: string): string {
  if (DEMO_OMP_PATHS[paneId] !== undefined) return `${OMP_SEED.join('\n')}\n`;
  const lines = SEEDS[paneId] ?? [];
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** One more assistant turn, for when the demo agent "replies". */
export function replyLine(text: string, uuid: string, timestamp: string): string {
  return line({ type: 'assistant', uuid, timestamp, model: MODEL, content: [{ type: 'text', text }] });
}

/** The user's own turn, appended when they send from the composer. */
export function userLine(text: string, uuid: string, timestamp: string): string {
  return line({ type: 'user', uuid, timestamp, content: text });
}

/**
 * What the demo agent says back.
 *
 * Deliberately not a canned sentence: it quotes the person, so it is obvious
 * the message travelled rather than a fixture being revealed on a timer.
 */
export function replyFor(prompt: string): string {
  // Pictures travel as paths; the demo talks about them as pictures.
  const { text, paths } = splitImages(prompt);
  const quoted = text.slice(0, 80);
  const pictures = paths.length === 0 ? '' : paths.length === 1 ? 'a picture' : `${paths.length} pictures`;
  const said = quoted && pictures ? `You said “${quoted}” and sent ${pictures}.` : quoted ? `You said “${quoted}”.` : `You sent ${pictures}.`;
  return `${said}\n\nThis is the demo host, so nothing actually ran, but everything above this line is the real app: the transcript reader, the live tail and the byte cursor all did their normal work to put this on your screen.`;
}

/** What the demo agent says once a menu choice has been tapped. */
export function answeredReply(choice: string): string {
  return choice === '1'
    ? 'Going ahead. Split the error state from the empty one and gave the error a Retry, so a failed read stops looking like an empty folder.'
    : 'Holding off. The change would alter what every caller of listDirectories sees on failure. Say the word when you want it.';
}

/**
 * Claude's visible screen on the blocked pane.
 *
 * The shape the real parser expects: the question, then a numbered menu, with
 * the selection marker Claude draws on the focused row.
 */
export const DEMO_BLOCKED_SCREEN = [
  '╭──────────────────────────────────────────────╮',
  '│ Edit file                                    │',
  '╰──────────────────────────────────────────────╯',
  '',
  'src/lib/herdr/client.ts',
  '',
  'Before I write to client.ts: this changes what every caller of',
  'listDirectories sees on failure. Want me to go ahead?',
  '',
  '❯ 1. Yes, go ahead',
  '  2. No, tell me more first',
  '',
].join('\n');

/**
 * What Claude records for a slash command once it has run: the command as
 * typed, then what it printed. Both are `user` turns, as in a real transcript.
 */
export function commandLines(command: string, printed: string, uuids: [string, string], timestamp: string): string[] {
  const [name = '', ...args] = command.trim().split(/\s+/);
  const typed = `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args.join(' ')}</command-args>`;
  return [
    line({ type: 'user', uuid: uuids[0], timestamp, content: typed }),
    line({ type: 'user', uuid: uuids[1], timestamp, content: `<local-command-stdout>${printed}</local-command-stdout>` }),
  ];
}

/** An assistant turn that is one tool call. */
export function toolUseLine(name: string, input: Record<string, unknown>, id: string, uuid: string, timestamp: string): string {
  return line({ type: 'assistant', uuid, timestamp, model: MODEL, content: [{ type: 'tool_use', id, name, input }] });
}

/** A tool's result, which Claude writes as a `user` turn. */
export function toolResultLine(id: string, text: string, isError: boolean, uuid: string, timestamp: string): string {
  return line({
    type: 'user',
    uuid,
    timestamp,
    content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }],
  });
}
