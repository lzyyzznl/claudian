import type { StreamChunk } from '@/core/types';

import {
  extractOmpToolTextContent,
  getOmpToolId,
  getOmpToolName,
  normalizeOmpToolInput,
} from './ompToolNormalization';

export interface OmpEventNormalizationState {
  emittedToolIds: Set<string>;
  toolOutputs: Map<string, string>;
}

export function createOmpEventNormalizationState(): OmpEventNormalizationState {
  return {
    emittedToolIds: new Set<string>(),
    toolOutputs: new Map<string, string>(),
  };
}

/**
 * Frames this normalizer handles for omp 18.2.1 `--mode rpc-ui`:
 *
 * - `agent_start`, `agent_end`: agent run boundaries.
 * - `turn_start`, `turn_end`: turn boundaries; `turn_end` carries the terminal assistant message.
 * - `message_start`, `message_update`, `message_end`: assistant message stream.
 * - `tool_execution_start`, `tool_execution_update`, `tool_execution_end`: tool lifecycle.
 * - `auto_compaction_start`, `auto_compaction_end`: automatic context compaction.
 * - `auto_retry_start`, `auto_retry_end`: automatic turn retry.
 * - `model_changed`, `thinking_level_changed`: session model/thinking notifications.
 * - `notice`: session-level notice carrying `level` and `message`.
 * - `compaction_end`, `extension_error`: retained from the pi vocabulary.
 *
 * `message_update` sub-discriminators (from omp's `assistantMessageEvent`):
 * `text_start`, `text_delta`, `thinking_start`, `thinking_delta`, `toolcall_start`,
 * `toolcall_delta`, `toolcall_end`. Deltas own the text/thinking stream; start
 * frames only carry the accumulated `partial` message and must not re-render it.
 *
 * Frames outside this vocabulary are ignored, never fatal.
 */
export function normalizeOmpRpcEvent(
  event: Record<string, unknown>,
  state: OmpEventNormalizationState,
): StreamChunk[] {
  switch (event.type) {
    case 'agent_start':
      // A new agent run owns a fresh tool-use/output lifetime; upstream recreates
      // the state per run, so clearing here only matters for standalone callers.
      state.emittedToolIds.clear();
      state.toolOutputs.clear();
      return [];
    case 'agent_end':
      // Async background work may still deliver tool output into a later run, so
      // agent_end must not drop the pending tool-output fallback.
      return [];
    case 'turn_start':
      return [];
    case 'message_start':
      // Carries the whole partial message; the text stream is owned by deltas.
      return [];
    case 'message_update':
      return normalizeMessageUpdate(event, state);
    case 'toolcall_end':
      return normalizeToolUse(getNestedRecord(event, 'toolCall') ?? event, state);
    case 'tool_execution_start':
      return normalizeToolUse(getNestedRecord(event, 'toolCall') ?? event, state);
    case 'tool_execution_update':
      return normalizeToolOutput(event, state);
    case 'tool_execution_end':
      return normalizeToolResult(event, state);
    case 'message_end':
    case 'turn_end':
      return normalizeTerminalError(event);
    case 'compaction_end':
      return [{ type: 'context_compacted' }];
    case 'auto_compaction_start':
      // Compaction is invisible until it lands; there is nothing to render yet.
      return [];
    case 'auto_compaction_end':
      // An aborted compaction left the context untouched, so it did not compact.
      return event.aborted === true ? [] : [{ type: 'context_compacted' }];
    case 'auto_retry_start':
      return [{ type: 'notice', content: 'OMP is retrying the turn.', level: 'warning' }];
    case 'auto_retry_end': {
      if (event.success !== false) {
        return [{ type: 'notice', content: 'OMP retry finished.', level: 'info' }];
      }
      const finalError = getString(event.finalError) ?? getString(event.final_error);
      return [{
        type: 'notice',
        content: finalError ? `OMP retry failed: ${finalError}` : 'OMP retry failed.',
        level: 'warning',
      }];
    }
    case 'model_changed':
    case 'thinking_level_changed':
      // The session binding is re-read from `get_state`; no stream chunk.
      return [];
    case 'notice': {
      const content = getString(event.message);
      if (!content) {
        return [];
      }
      // The stream contract carries only `info`/`warning`; an `error` notice is a
      // session-level message, not a terminal turn failure, so it stays non-fatal.
      const level = getString(event.level) === 'info' ? 'info' : 'warning';
      return [{ type: 'notice', content, level }];
    }
    case 'extension_error':
      return [{ type: 'notice', content: getString(event.error) ?? 'OMP extension error.', level: 'warning' }];
    default:
      return [];
  }
}

export function getOmpTerminalErrorMessage(event: Record<string, unknown>): string | null {
  if (event.type !== 'message_end' && event.type !== 'turn_end') {
    return null;
  }

  const terminalEvent = getNestedRecord(event, 'assistantMessageEvent')
    ?? getNestedRecord(event, 'assistant_message_event')
    ?? getNestedRecord(event, 'message')
    ?? event;
  const records = terminalEvent === event ? [event] : [terminalEvent, event];
  const stopReason = getStringField(records, ['stopReason', 'stop_reason']);
  if (stopReason?.toLowerCase() !== 'error') {
    return null;
  }

  return getStringField(records, ['errorMessage', 'error_message', 'error', 'message'])
    ?? getNestedStringField(records, 'error', ['message'])
    ?? 'OMP turn failed.';
}

function normalizeMessageUpdate(
  event: Record<string, unknown>,
  state: OmpEventNormalizationState,
): StreamChunk[] {
  const assistantEvent = getNestedRecord(event, 'assistantMessageEvent')
    ?? getNestedRecord(event, 'assistant_message_event')
    ?? event;

  switch (getString(assistantEvent.type)) {
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start':
      // omp emits `<block>_start` before its `_delta` frames. A start frame carries
      // only the accumulated `partial` message, so rendering from it would duplicate
      // text that the deltas already streamed.
      return [];
    case 'text_end':
    case 'thinking_end':
      // End frames carry the whole block `content`, which the deltas already emitted.
      return [];
    case 'toolcall_delta':
      // Argument fragments are not renderable; the tool card lands at `toolcall_end`.
      return [];
    case 'toolcall_end':
      return normalizeToolUse(getNestedRecord(assistantEvent, 'toolCall') ?? assistantEvent, state);
    default:
      break;
  }

  const textDelta = getString(assistantEvent.text_delta)
    ?? getString(assistantEvent.textDelta)
    ?? (
      assistantEvent.type === 'text_delta'
        ? getString(assistantEvent.delta)
        : null
    );
  if (textDelta) {
    return [{ type: 'text', content: textDelta }];
  }

  const thinkingDelta = getString(assistantEvent.thinking_delta)
    ?? getString(assistantEvent.thinkingDelta)
    ?? (
      assistantEvent.type === 'thinking_delta'
        ? getString(assistantEvent.delta)
        : null
    );
  if (thinkingDelta) {
    return [{ type: 'thinking', content: thinkingDelta }];
  }

  return [];
}

function normalizeTerminalError(event: Record<string, unknown>): StreamChunk[] {
  const message = getOmpTerminalErrorMessage(event);
  return message ? [{ type: 'error', content: message }] : [];
}

function normalizeToolUse(
  event: Record<string, unknown>,
  state: OmpEventNormalizationState,
): StreamChunk[] {
  const id = getOmpToolId(event);
  if (!id || state.emittedToolIds.has(id)) {
    return [];
  }

  state.emittedToolIds.add(id);
  const name = getOmpToolName(event);
  return [{
    type: 'tool_use',
    id,
    input: normalizeOmpToolInput(event.input ?? event.arguments ?? event.args, name),
    name,
  }];
}

function normalizeToolOutput(
  event: Record<string, unknown>,
  state: OmpEventNormalizationState,
): StreamChunk[] {
  const id = getOmpToolId(event);
  if (!id) {
    return [];
  }

  const content = extractOmpToolTextContent(event.partialResult ?? event.output ?? event.result ?? event.content);
  if (!content) {
    return [];
  }

  state.toolOutputs.set(id, content);
  return [{ type: 'tool_output', id, content }];
}

function normalizeToolResult(
  event: Record<string, unknown>,
  state: OmpEventNormalizationState,
): StreamChunk[] {
  const id = getOmpToolId(event);
  if (!id) {
    return [];
  }

  const content = extractOmpToolTextContent(event.result ?? event.output ?? event.content)
    || state.toolOutputs.get(id)
    || '';
  const toolUseResult = getNestedRecord(event, 'result');
  return [{
    type: 'tool_result',
    content,
    id,
    isError: event.isError === true || event.error === true || event.success === false,
    ...(toolUseResult ? { toolUseResult } : {}),
  }];
}

function getNestedRecord(
  event: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = event[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function getStringField(
  records: Array<Record<string, unknown>>,
  keys: string[],
): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = getString(record[key]);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

function getNestedStringField(
  records: Array<Record<string, unknown>>,
  parentKey: string,
  keys: string[],
): string | null {
  for (const record of records) {
    const nested = getNestedRecord(record, parentKey);
    if (!nested) {
      continue;
    }
    const value = getStringField([nested], keys);
    if (value) {
      return value;
    }
  }
  return null;
}
