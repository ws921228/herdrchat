import { displayText, imagePaths } from '../transcript/message';
import { assistantMeta, parseTranscript, parseTranscriptEntry } from '../transcript/parser';

const sessionId = 'hermes-session-1';
const row = {
  type: 'hermes_message',
  row_id: 7,
  session_id: sessionId,
  role: 'assistant',
  content: [{ type: 'text', text: '완료 ✅' }],
  tool_calls: JSON.stringify([{ id: 'call-1', function: { name: 'bash', arguments: '{"cmd":"pwd"}' } }]),
  timestamp: 1_790_694_401,
  token_count: 1234,
  reasoning_content: 'Checking state',
  model: 'openai/gpt-5.6',
};

it('parses Hermes DB message rows with namespaced ids, reasoning, tools, and metadata', () => {
  const entry = parseTranscriptEntry(JSON.stringify(row), 'hermes');
  expect(entry.meta).toEqual({ model: 'openai/gpt-5.6', contextTokens: null });
  expect(entry.message?.id).toBe(`hermes:${sessionId}:7`);
  expect(entry.message?.timestamp).toBe(1_790_694_401_000);
  expect(entry.message?.agentLabel).toBe('hermes');
  expect(entry.message?.segments).toEqual([
    { kind: 'thinking', text: 'Checking state' },
    { kind: 'text', text: '완료 ✅' },
    { kind: 'toolUse', name: 'bash', input: '{"cmd":"pwd"}', id: 'call-1' },
  ]);
  expect(assistantMeta(JSON.stringify(row))).toEqual({ model: 'openai/gpt-5.6', contextTokens: null });
});

it('keeps Hermes user input typed and splits uploaded images', () => {
  const upload = '/home/ws9212/.cache/herdrchat/uploads/pic.png';
  const parsed = parseTranscript(JSON.stringify({
    type: 'hermes_message',
    row_id: 8,
    session_id: sessionId,
    role: 'user',
    content: `# AGENTS.md instructions\n안녕 👋\n${upload}`,
    timestamp: 1,
  }));
  expect(displayText(parsed[0]!)).toBe('# AGENTS.md instructions\n안녕 👋');
  expect(imagePaths(parsed[0]!)).toEqual([upload]);
});

it('maps Hermes tool rows to paired tool results without colliding with OMP message records', () => {
  const tool = parseTranscript(JSON.stringify({
    type: 'hermes_message',
    row_id: 9,
    session_id: sessionId,
    role: 'tool',
    tool_call_id: 'call-1',
    tool_name: 'bash',
    content: 'exit 1',
    effect_disposition: 'error',
    timestamp: 2,
  }));
  expect(tool[0]?.role).toBe('user');
  expect(tool[0]?.segments).toEqual([{ kind: 'toolResult', text: 'exit 1', toolUseId: 'call-1', isError: true }]);
  expect(parseTranscript(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [] } }))).toEqual([]);
});
