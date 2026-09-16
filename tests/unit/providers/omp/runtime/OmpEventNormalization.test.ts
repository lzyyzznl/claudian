import {
  createOmpEventNormalizationState,
  getOmpTerminalErrorMessage,
  normalizeOmpRpcEvent,
} from '@/providers/omp/normalizations/ompEventNormalization';

/** The accumulated partial message omp attaches to every `message_update` frame. */
const partialWithText = {
  content: [{ text: 'hello', type: 'text' }],
  role: 'assistant',
};

describe('OMP event normalization', () => {
  it('normalizes text and thinking deltas', () => {
    const state = createOmpEventNormalizationState();
    expect(normalizeOmpRpcEvent({
      assistantMessageEvent: { text_delta: 'hello' },
      type: 'message_update',
    }, state)).toEqual([{ type: 'text', content: 'hello' }]);
    expect(normalizeOmpRpcEvent({
      assistantMessageEvent: { thinking_delta: 'hmm' },
      type: 'message_update',
    }, state)).toEqual([{ type: 'thinking', content: 'hmm' }]);
  });

  it('dedupes tool use and maps output/result chunks', () => {
    const state = createOmpEventNormalizationState();
    expect(normalizeOmpRpcEvent({
      id: 'tool-1',
      input: { path: 'a.md' },
      name: 'read',
      type: 'toolcall_end',
    }, state)).toEqual([{
      id: 'tool-1',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      type: 'tool_use',
    }]);
    expect(normalizeOmpRpcEvent({
      id: 'tool-1',
      input: { path: 'a.md' },
      name: 'read',
      type: 'tool_execution_start',
    }, state)).toEqual([]);
    expect(normalizeOmpRpcEvent({
      id: 'tool-1',
      partialResult: { content: [{ text: 'partial', type: 'text' }] },
      type: 'tool_execution_update',
    }, state)).toEqual([{ id: 'tool-1', content: 'partial', type: 'tool_output' }]);
    expect(normalizeOmpRpcEvent({
      id: 'tool-1',
      result: { content: [{ text: 'done', type: 'text' }] },
      type: 'tool_execution_end',
    }, state)).toEqual([{
      id: 'tool-1',
      content: 'done',
      isError: false,
      toolUseResult: { content: [{ text: 'done', type: 'text' }] },
      type: 'tool_result',
    }]);
  });

  it('normalizes OMP RPC toolName and args to shared renderer tool shapes', () => {
    const state = createOmpEventNormalizationState();

    expect(normalizeOmpRpcEvent({
      args: { command: 'pwd' },
      toolCallId: 'bash-1',
      toolName: 'bash',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'bash-1',
      input: { command: 'pwd' },
      name: 'Bash',
      type: 'tool_use',
    }]);

    expect(normalizeOmpRpcEvent({
      args: { pattern: 'src/**/*.ts' },
      toolCallId: 'glob-1',
      toolName: 'glob',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'glob-1',
      input: { pattern: 'src/**/*.ts' },
      name: 'Glob',
      type: 'tool_use',
    }]);

    expect(normalizeOmpRpcEvent({
      args: { pattern: 'src/**/*.ts' },
      toolCallId: 'find-1',
      toolName: 'find',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'find-1',
      input: { pattern: 'src/**/*.ts' },
      name: 'Glob',
      type: 'tool_use',
    }]);

    expect(normalizeOmpRpcEvent({
      args: { pattern: 'normalizeOmpRpcEvent' },
      toolCallId: 'search-1',
      toolName: 'search',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'search-1',
      input: { pattern: 'normalizeOmpRpcEvent' },
      name: 'Grep',
      type: 'tool_use',
    }]);

    expect(normalizeOmpRpcEvent({
      args: { pattern: 'foo', rewrite: 'bar' },
      toolCallId: 'ast-edit-1',
      toolName: 'ast_edit',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'ast-edit-1',
      input: { pattern: 'foo', rewrite: 'bar' },
      name: 'ast_edit',
      type: 'tool_use',
    }]);
  });

  it('maps OMP web extension tools to shared renderer names', () => {
    const state = createOmpEventNormalizationState();

    expect(normalizeOmpRpcEvent({
      args: { count: 5, query: 'provider protocol' },
      toolCallId: 'web-search-1',
      toolName: 'web_search',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'web-search-1',
      input: { count: 5, query: 'provider protocol' },
      name: 'WebSearch',
      type: 'tool_use',
    }]);

    expect(normalizeOmpRpcEvent({
      args: { url: 'https://example.com/reference' },
      toolCallId: 'web-fetch-1',
      toolName: 'web_fetch',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'web-fetch-1',
      input: { url: 'https://example.com/reference' },
      name: 'WebFetch',
      type: 'tool_use',
    }]);
  });

  it('preserves OMP write/edit result payloads for diff extraction', () => {
    const state = createOmpEventNormalizationState();

    expect(normalizeOmpRpcEvent({
      args: { content: 'new text', path: 'notes/a.md' },
      toolCallId: 'write-1',
      toolName: 'write',
      type: 'tool_execution_start',
    }, state)).toEqual([{
      id: 'write-1',
      input: { content: 'new text', file_path: 'notes/a.md', path: 'notes/a.md' },
      name: 'Write',
      type: 'tool_use',
    }]);

    expect(normalizeOmpRpcEvent({
      isError: false,
      result: {
        content: [{ text: 'Edited notes/a.md', type: 'text' }],
        details: { diff: '--- a/notes/a.md\n+++ b/notes/a.md\n@@ -1 +1 @@\n-old\n+new' },
      },
      toolCallId: 'write-1',
      toolName: 'write',
      type: 'tool_execution_end',
    }, state)).toEqual([{
      id: 'write-1',
      content: 'Edited notes/a.md',
      isError: false,
      toolUseResult: {
        content: [{ text: 'Edited notes/a.md', type: 'text' }],
        details: { diff: '--- a/notes/a.md\n+++ b/notes/a.md\n@@ -1 +1 @@\n-old\n+new' },
      },
      type: 'tool_result',
    }]);
  });

  it('maps compaction and extension errors', () => {
    const state = createOmpEventNormalizationState();
    expect(normalizeOmpRpcEvent({ type: 'compaction_end' }, state)).toEqual([{ type: 'context_compacted' }]);
    expect(normalizeOmpRpcEvent({ error: 'extension failed', type: 'extension_error' }, state)).toEqual([{
      content: 'extension failed',
      level: 'warning',
      type: 'notice',
    }]);
  });

  it('surfaces terminal OMP stop-reason errors', () => {
    const state = createOmpEventNormalizationState();

    expect(normalizeOmpRpcEvent({
      errorMessage: 'Invalid image',
      stopReason: 'error',
      type: 'message_end',
    }, state)).toEqual([{ type: 'error', content: 'Invalid image' }]);

    expect(normalizeOmpRpcEvent({
      assistant_message_event: {
        error_message: 'Authentication failed',
        stop_reason: 'error',
      },
      type: 'turn_end',
    }, state)).toEqual([{ type: 'error', content: 'Authentication failed' }]);
  });

  it('reads terminal errors from the native OMP message payload', () => {
    expect(getOmpTerminalErrorMessage({
      message: {
        content: [],
        errorMessage: 'OpenRouter quota exceeded',
        role: 'assistant',
        stopReason: 'error',
      },
      type: 'message_end',
    })).toBe('OpenRouter quota exceeded');
  });

  it('consumes OMP run, turn, and message boundary frames without chunks', () => {
    const state = createOmpEventNormalizationState();

    expect(normalizeOmpRpcEvent({ type: 'agent_start' }, state)).toEqual([]);
    expect(normalizeOmpRpcEvent({ timestamp: 1, turnIndex: 0, type: 'turn_start' }, state)).toEqual([]);
    expect(normalizeOmpRpcEvent({
      message: { content: [{ text: 'already streamed', type: 'text' }], role: 'assistant' },
      type: 'message_start',
    }, state)).toEqual([]);
    expect(normalizeOmpRpcEvent({ messages: [], type: 'agent_end' }, state)).toEqual([]);
  });

  it('resets tool-use deduplication when a new agent run starts', () => {
    const state = createOmpEventNormalizationState();
    const toolExecutionStart = {
      args: { path: 'a.md' },
      toolCallId: 'tool-9',
      toolName: 'read',
      type: 'tool_execution_start',
    };

    expect(normalizeOmpRpcEvent(toolExecutionStart, state)).toHaveLength(1);
    expect(normalizeOmpRpcEvent(toolExecutionStart, state)).toEqual([]);
    normalizeOmpRpcEvent({ type: 'agent_start' }, state);
    expect(normalizeOmpRpcEvent(toolExecutionStart, state)).toHaveLength(1);
  });

  it('emits each OMP message_update sub-event exactly once', () => {
    const state = createOmpEventNormalizationState();

    expect(normalizeOmpRpcEvent({
      assistantMessageEvent: { contentIndex: 0, delta: 'hello', partial: partialWithText, type: 'text_delta' },
      type: 'message_update',
    }, state)).toEqual([{ type: 'text', content: 'hello' }]);

    // Re-delivering the same text through a `<block>_start` partial must not re-render it.
    expect(normalizeOmpRpcEvent({
      assistantMessageEvent: { contentIndex: 0, partial: partialWithText, type: 'text_start' },
      type: 'message_update',
    }, state)).toEqual([]);

    expect(normalizeOmpRpcEvent({
      assistantMessageEvent: { contentIndex: 0, delta: 'hmm', partial: partialWithText, type: 'thinking_delta' },
      type: 'message_update',
    }, state)).toEqual([{ type: 'thinking', content: 'hmm' }]);
    expect(normalizeOmpRpcEvent({
      assistantMessageEvent: { contentIndex: 0, partial: partialWithText, type: 'thinking_start' },
      type: 'message_update',
    }, state)).toEqual([]);

    expect(normalizeOmpRpcEvent({
      assistantMessageEvent: { contentIndex: 1, partial: partialWithText, type: 'toolcall_start' },
      type: 'message_update',
    }, state)).toEqual([]);
    expect(normalizeOmpRpcEvent({
      assistantMessageEvent: {
        contentIndex: 1,
        delta: '{"path":"a.md"',
        partial: partialWithText,
        type: 'toolcall_delta',
      },
      type: 'message_update',
    }, state)).toEqual([]);

    expect(normalizeOmpRpcEvent({
      assistantMessageEvent: {
        contentIndex: 1,
        partial: partialWithText,
        toolCall: { arguments: { path: 'a.md' }, id: 'tool-2', name: 'read', type: 'toolCall' },
        type: 'toolcall_end',
      },
      type: 'message_update',
    }, state)).toEqual([{
      id: 'tool-2',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      type: 'tool_use',
    }]);

    // The lifecycle frame for the same call must not render a second card.
    expect(normalizeOmpRpcEvent({
      args: { path: 'a.md' },
      toolCallId: 'tool-2',
      toolName: 'read',
      type: 'tool_execution_start',
    }, state)).toEqual([]);
  });

  it('maps OMP compaction, retry, and session notice frames', () => {
    const state = createOmpEventNormalizationState();

    expect(normalizeOmpRpcEvent({
      action: 'context-full',
      reason: 'threshold',
      type: 'auto_compaction_start',
    }, state)).toEqual([]);
    expect(normalizeOmpRpcEvent({
      aborted: false,
      action: 'context-full',
      result: {},
      type: 'auto_compaction_end',
    }, state)).toEqual([{ type: 'context_compacted' }]);
    expect(normalizeOmpRpcEvent({
      aborted: true,
      action: 'context-full',
      type: 'auto_compaction_end',
    }, state)).toEqual([]);

    expect(normalizeOmpRpcEvent({
      attempt: 1,
      delayMs: 500,
      maxAttempts: 3,
      type: 'auto_retry_start',
    }, state)).toEqual([{ content: 'OMP is retrying the turn.', level: 'warning', type: 'notice' }]);
    expect(normalizeOmpRpcEvent({
      attempt: 1,
      success: true,
      type: 'auto_retry_end',
    }, state)).toEqual([{ content: 'OMP retry finished.', level: 'info', type: 'notice' }]);
    expect(normalizeOmpRpcEvent({
      attempt: 3,
      finalError: 'Provider unavailable',
      success: false,
      type: 'auto_retry_end',
    }, state)).toEqual([{
      content: 'OMP retry failed: Provider unavailable',
      level: 'warning',
      type: 'notice',
    }]);

    expect(normalizeOmpRpcEvent({ type: 'model_changed' }, state)).toEqual([]);
    expect(normalizeOmpRpcEvent({ thinkingLevel: 'high', type: 'thinking_level_changed' }, state)).toEqual([]);

    expect(normalizeOmpRpcEvent({
      level: 'info',
      message: 'Session compacted',
      type: 'notice',
    }, state)).toEqual([{ content: 'Session compacted', level: 'info', type: 'notice' }]);
    expect(normalizeOmpRpcEvent({
      level: 'error',
      message: 'Session persistence failed',
      source: 'session-persistence',
      type: 'notice',
    }, state)).toEqual([{
      content: 'Session persistence failed',
      level: 'warning',
      type: 'notice',
    }]);
  });
});
