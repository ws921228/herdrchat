import { splitImages } from './images';
import type { MessageSegment } from './message';
import type { TranscriptEntry } from './parser';
import type { SessionMeta } from './sessionMeta';

const JSON_PREFIX = '\0json:';
const PREVIEW_CHARS = 2_000;
const RESULT_CHARS = 4_000;

export function hermesEntry(
  raw: Record<string, unknown>,
  agentLabel: string | null
): TranscriptEntry {
  if (raw.type !== 'hermes_message') return { message: null, meta: null };
  const sessionId = stringValue(raw.session_id);
  const rowId = finiteNumber(raw.row_id);
  if (sessionId === null || rowId === null) return { message: null, meta: null };

  const role = stringValue(raw.role);
  const content = decodeContent(raw.content);
  const segments = segmentsFrom(role, content, raw);
  const meta = metaFrom(raw);
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return { message: null, meta };
  if (segments.length === 0) return { message: null, meta };

  return {
    message: {
      id: `hermes:${sessionId}:${rowId}`,
      role: role === 'assistant' ? 'assistant' : 'user',
      segments,
      timestamp: timestampFrom(raw.timestamp),
      agentLabel,
      isSidechain: false,
    },
    meta,
  };
}

function segmentsFrom(role: string | null, content: unknown, raw: Record<string, unknown>): MessageSegment[] {
  if (role === 'tool') {
    return [{
      kind: 'toolResult',
      text: capped(contentText(content)),
      ...(stringValue(raw.tool_call_id) !== null ? { toolUseId: stringValue(raw.tool_call_id) as string } : {}),
      ...(stringValue(raw.effect_disposition) === 'error' ? { isError: true } : {}),
    }];
  }
  if (role === 'assistant') {
    const segments: MessageSegment[] = [];
    const reasoning = stringValue(raw.reasoning_content) ?? stringValue(raw.reasoning);
    if (reasoning !== null && reasoning.length > 0) segments.push({ kind: 'thinking', text: reasoning });
    const text = contentText(content);
    if (text.length > 0) segments.push({ kind: 'text', text });
    for (const call of toolCalls(raw.tool_calls)) {
      segments.push({
        kind: 'toolUse',
        name: call.name,
        input: preview(call.input),
        ...(call.id !== null ? { id: call.id } : {}),
      });
    }
    return segments;
  }
  if (role !== 'user') return [];
  const { text, paths } = splitImages(contentText(content));
  return [
    ...(text.length === 0 ? [] : [{ kind: 'text' as const, text }]),
    ...paths.map(path => ({ kind: 'image' as const, path })),
  ];
}

function toolCalls(value: unknown): { id: string | null; name: string; input: unknown }[] {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): { id: string | null; name: string; input: unknown }[] => {
    const call = record(item);
    if (call === null) return [];
    const fn = record(call.function);
    return [{
      id: stringValue(call.id),
      name: stringValue(fn?.name) ?? stringValue(call.name) ?? 'tool',
      input: fn?.arguments ?? call.arguments ?? call.input ?? null,
    }];
  });
}

function metaFrom(raw: Record<string, unknown>): SessionMeta | null {
  if (raw.role !== 'assistant') return null;
  const model = stringValue(raw.model);
  const contextTokens = null;
  return model === null && contextTokens === null ? null : { model, contextTokens };
}

function decodeContent(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(JSON_PREFIX)) {
    const parsed = parseJson(value.slice(JSON_PREFIX.length));
    return parsed ?? value;
  }
  return value;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.flatMap(block => {
      const value = record(block);
      const type = stringValue(value?.type);
      if (['text', 'input_text', 'output_text'].includes(type ?? '')) {
        return typeof value?.text === 'string' ? [value.text] : [];
      }
      if (typeof value?.content === 'string') return [value.content];
      return [];
    }).join('\n');
  }
  if (content === null || content === undefined) return '';
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

function preview(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return null;
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

function capped(text: string): string {
  return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}…` : text;
}

function timestampFrom(value: unknown): number | null {
  const numeric = finiteNumber(value);
  return numeric === null ? null : Math.round(numeric * 1000);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
