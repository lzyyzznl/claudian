import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createOmpForkSessionFile,
  type OmpSessionEntry,
  parseOmpSessionContent,
  parseOmpSessionEntries,
  parseOmpSessionModel,
  readOmpSessionHeader,
  resolveOmpActivePath,
  resolveOmpEntryPath,
  rollbackCreatedOmpForkSessionFile,
} from '@/providers/omp/history/OmpHistoryStore';

/** Builds Omp's fixed-width 256-byte title slot, which is always file line 1. */
function createTitleSlot(title: string): string {
  const base = {
    type: 'title',
    v: 1,
    title,
    source: 'auto',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const padLength = 256 - Buffer.byteLength(JSON.stringify({ ...base, pad: '' }));
  if (padLength < 1) {
    throw new Error('Test title is too long for the fixed-width title slot.');
  }
  return JSON.stringify({ ...base, pad: ' '.repeat(padLength) });
}

describe('OmpHistoryStore', () => {
  it('parses linear user and assistant messages', () => {
    const content = [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ id: 'u1', type: 'entry', message: { role: 'user', content: 'Hello' } }),
      JSON.stringify({
        id: 'a1',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'Thinking' },
            { type: 'text', text: 'Hi' },
          ],
        },
      }),
    ].join('\n');

    const messages = parseOmpSessionContent(content);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      content: 'Hello',
      role: 'user',
      userMessageId: 'u1',
    });
    expect(messages[1]).toMatchObject({
      assistantMessageId: 'a1',
      content: 'Hi',
      contentBlocks: [
        { type: 'thinking', content: 'Thinking' },
        { type: 'text', content: 'Hi' },
      ],
      role: 'assistant',
    });
  });

  it('restores turn duration through tool calls using the final entry timestamp', () => {
    const content = [
      { type: 'message', id: 'u1', timestamp: '2026-09-07T10:00:00.010Z',
        message: { role: 'user', timestamp: 1788775200000, content: 'Inspect' } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-09-07T10:00:04Z',
        message: { role: 'assistant', timestamp: 1788775200010, stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'README.md' } }] } },
      { type: 'message', id: 'tr1', parentId: 'a1', timestamp: '2026-09-07T10:00:05Z',
        message: { role: 'toolResult', toolCallId: 'read', content: [{ type: 'text', text: 'Details' }] } },
      { type: 'message', id: 'a2', parentId: 'tr1', timestamp: '2026-09-07T10:01:05.900Z',
        message: { role: 'assistant', timestamp: 1788775205000, stopReason: 'stop',
          content: [{ type: 'text', text: 'Complete.' }] } },
    ].map(entry => JSON.stringify(entry)).join('\n');

    expect(parseOmpSessionContent(content)).toMatchObject([
      { role: 'user', content: 'Inspect' },
      { role: 'assistant', assistantMessageId: 'a2', content: 'Complete.', durationSeconds: 65, completedAt: Date.parse('2026-09-07T10:01:05.900Z') },
    ]);
    expect(parseOmpSessionContent(content, { leafEntryId: 'a1' })[1].durationSeconds).toBeUndefined();
  });

  it.each([
    ['stop', '2026-09-07T10:00:00.900Z', 0],
    ['length', '2026-09-07T10:00:05Z', 5],
    ['aborted', '2026-09-07T10:00:05Z', undefined],
    ['error', '2026-09-07T10:00:05Z', undefined],
    ['toolUse', '2026-09-07T10:00:05Z', undefined],
    ['stop', undefined, undefined],
    ['stop', 'invalid', undefined],
    ['stop', '2026-09-07T09:59:59Z', undefined],
  ])('restores only completed durations with valid timing (%s, %s)', (stopReason, timestamp, expected) => {
    const content = [
      { id: 'u1', type: 'message', timestamp: '2026-09-07T10:00:00Z',
        message: { role: 'user', content: 'Inspect' } },
      { id: 'a1', parentId: 'u1', type: 'message', timestamp,
        message: { role: 'assistant', timestamp: 1788775200010, stopReason, content: 'Reply' } },
    ].map(entry => JSON.stringify(entry)).join('\n');

    expect(parseOmpSessionContent(content)[1].durationSeconds).toBe(expected);
  });

  it('starts timing again at the next user prompt', () => {
    const content = [
      { id: 'u1', type: 'message', timestamp: '2026-09-07T10:00:00Z',
        message: { role: 'user', content: 'First' } },
      { id: 'a1', parentId: 'u1', type: 'message', timestamp: '2026-09-07T10:00:05Z',
        message: { role: 'assistant', stopReason: 'stop', content: 'First reply' } },
      { id: 'u2', parentId: 'a1', type: 'message', timestamp: '2026-09-07T12:00:00Z',
        message: { role: 'user', content: 'Second' } },
      { id: 'a2', parentId: 'u2', type: 'message', timestamp: '2026-09-07T12:00:03Z',
        message: { role: 'assistant', stopReason: 'stop', content: 'Second reply' } },
    ].map(entry => JSON.stringify(entry)).join('\n');

    expect(parseOmpSessionContent(content).filter(message => message.role === 'assistant')).toMatchObject([
      { content: 'First reply', durationSeconds: 5 },
      { content: 'Second reply', durationSeconds: 3 },
    ]);
  });

  it('preserves hidden XML context wrappers in raw user content', () => {
    const content = [
      JSON.stringify({
        id: 'u1',
        type: 'entry',
        message: {
          role: 'user',
          content: 'Summarize this\n\n<current_note>\nnotes/today.md\n</current_note>',
        },
      }),
    ].join('\n');

    const messages = parseOmpSessionContent(content);

    expect(messages[0]).toMatchObject({
      content: 'Summarize this\n\n<current_note>\nnotes/today.md\n</current_note>',
      role: 'user',
    });
    expect(messages[0].displayContent).toBeUndefined();
  });

  it.each([
    {
      displayContent: '/skill:commit-push',
      suffix: '',
    },
    {
      displayContent: '/skill:commit-push include untracked files',
      suffix: [
        '',
        '',
        'include untracked files',
        '',
        '<linked_note path="notes/release.md" />',
      ].join('\n'),
    },
  ])('restores $displayContent from Omp-expanded skill prompts', ({
    displayContent,
    suffix,
  }) => {
    const expandedPrompt = [
      '<skill name="commit-push" location="/Users/test/.agents/skills/commit-push/SKILL.md">',
      'References are relative to /Users/test/.agents/skills/commit-push.',
      '',
      'Commit all uncommitted changes, then push to remote.',
      '</skill>',
    ].join('\n') + suffix;
    const content = JSON.stringify({
      id: 'u1',
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: expandedPrompt }],
      },
    });

    const messages = parseOmpSessionContent(content);

    expect(messages[0]).toMatchObject({
      content: expandedPrompt,
      displayContent,
      role: 'user',
    });
  });

  it('rehydrates user image content parts', () => {
    const content = [
      JSON.stringify({
        id: 'u1',
        type: 'entry',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'aGVsbG8=',
            },
          ],
        },
      }),
    ].join('\n');

    const messages = parseOmpSessionContent(content);

    expect(messages[0]).toMatchObject({
      content: 'What is in this image?',
      images: [{
        data: 'aGVsbG8=',
        id: 'omp-img-u1-0',
        mediaType: 'image/png',
        name: 'image-1.png',
        size: 5,
        source: 'paste',
      }],
      role: 'user',
    });
  });

  it('attaches tool results to the previous assistant tool call', () => {
    const content = [
      JSON.stringify({
        id: 'a1',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { id: 'tool-1', input: { path: 'a.md' }, name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        result: { content: [{ text: 'file contents', type: 'text' }] },
        toolCallId: 'tool-1',
        type: 'toolResult',
      }),
    ].join('\n');

    const messages = parseOmpSessionContent(content);

    expect(messages[0].toolCalls).toEqual([{
      id: 'tool-1',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      result: 'file contents',
      status: 'completed',
    }]);
  });

  it('attaches real Omp message-role tool results to shared renderer tool calls', () => {
    const content = [
      JSON.stringify({
        id: 'a1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { arguments: { path: 'a.md' }, id: 'tool-1', name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr1',
        parentId: 'a1',
        type: 'message',
        message: {
          content: [{ text: 'file contents', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'tool-1',
          toolName: 'read',
        },
      }),
    ].join('\n');

    const messages = parseOmpSessionContent(content);

    expect(messages[0].toolCalls).toEqual([{
      id: 'tool-1',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      result: 'file contents',
      status: 'completed',
    }]);
    expect(messages[0].contentBlocks).toEqual([{ toolId: 'tool-1', type: 'tool_use' }]);
  });

  it('rehydrates Omp web extension tools with shared renderer names', () => {
    const content = [
      JSON.stringify({
        id: 'assistant-web',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              arguments: { count: 5, query: 'provider protocol' },
              id: 'web-search-1',
              name: 'web_search',
              type: 'toolCall',
            },
            {
              arguments: { url: 'https://example.com/reference' },
              id: 'web-fetch-1',
              name: 'web_fetch',
              type: 'toolCall',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          content: [{ text: 'Search result', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'web-search-1',
          toolName: 'web_search',
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          content: [{ text: 'Fetched page', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'web-fetch-1',
          toolName: 'web_fetch',
        },
      }),
    ].join('\n');

    const toolCalls = parseOmpSessionContent(content)[0].toolCalls ?? [];

    expect(toolCalls).toEqual([
      expect.objectContaining({
        input: { count: 5, query: 'provider protocol' },
        name: 'WebSearch',
        result: 'Search result',
      }),
      expect.objectContaining({
        input: { url: 'https://example.com/reference' },
        name: 'WebFetch',
        result: 'Fetched page',
      }),
    ]);
  });

  it('merges Omp assistant continuations split by tool results into one chat message', () => {
    const content = [
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'Hide scrollbars' } }),
      JSON.stringify({
        id: 'a1',
        parentId: 'u1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Inspecting snippets' },
            { arguments: { path: '.obsidian' }, id: 'ls-1', name: 'ls', type: 'toolCall' },
            { arguments: { path: '.obsidian/snippets' }, id: 'ls-2', name: 'ls', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr1',
        parentId: 'a1',
        type: 'message',
        message: {
          content: [{ text: 'appearance.json\nsnippets/', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'ls-1',
          toolName: 'ls',
        },
      }),
      JSON.stringify({
        id: 'tr2',
        parentId: 'tr1',
        type: 'message',
        message: {
          content: [{ text: 'existing.css', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'ls-2',
          toolName: 'ls',
        },
      }),
      JSON.stringify({
        id: 'a2',
        parentId: 'tr2',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { arguments: { path: '.obsidian/appearance.json' }, id: 'read-1', name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr3',
        parentId: 'a2',
        type: 'message',
        message: {
          content: [{ text: '{"enabledCssSnippets":[]}', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'read-1',
          toolName: 'read',
        },
      }),
      JSON.stringify({
        id: 'a3',
        parentId: 'tr3',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Creating snippet' },
            { arguments: { path: '.obsidian/snippets/hide-scrollbars.css', content: 'css' }, id: 'write-1', name: 'write', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr4',
        parentId: 'a3',
        type: 'message',
        message: {
          content: [{ text: 'Successfully wrote file', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'write-1',
          toolName: 'write',
        },
      }),
      JSON.stringify({
        id: 'a4',
        parentId: 'tr4',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
        },
      }),
    ].join('\n');

    const messages = parseOmpSessionContent(content);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      assistantMessageId: 'a4',
      content: 'Done.',
      role: 'assistant',
    });
    expect(messages[1].contentBlocks).toEqual([
      { type: 'thinking', content: 'Inspecting snippets' },
      { type: 'tool_use', toolId: 'ls-1' },
      { type: 'tool_use', toolId: 'ls-2' },
      { type: 'tool_use', toolId: 'read-1' },
      { type: 'thinking', content: 'Creating snippet' },
      { type: 'tool_use', toolId: 'write-1' },
      { type: 'text', content: 'Done.' },
    ]);
    expect(messages[1].toolCalls?.map(toolCall => ({
      id: toolCall.id,
      result: toolCall.result,
      status: toolCall.status,
    }))).toEqual([
      { id: 'ls-1', result: 'appearance.json\nsnippets/', status: 'completed' },
      { id: 'ls-2', result: 'existing.css', status: 'completed' },
      { id: 'read-1', result: '{"enabledCssSnippets":[]}', status: 'completed' },
      { id: 'write-1', result: 'Successfully wrote file', status: 'completed' },
    ]);
  });

  it('hydrates Omp write/edit tool calls with diff data for stored rendering', () => {
    const content = [
      JSON.stringify({
        id: 'a1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              arguments: {
                edits: [{ oldText: 'old', newText: 'new' }],
                path: 'notes/a.md',
              },
              id: 'edit-1',
              name: 'edit',
              type: 'toolCall',
            },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr1',
        parentId: 'a1',
        type: 'message',
        message: {
          content: [{ text: 'Edited notes/a.md', type: 'text' }],
          details: {
            diff: '--- a/notes/a.md\n+++ b/notes/a.md\n@@ -1 +1 @@\n-old\n+new',
          },
          isError: false,
          role: 'toolResult',
          toolCallId: 'edit-1',
          toolName: 'edit',
        },
      }),
    ].join('\n');

    const messages = parseOmpSessionContent(content);

    expect(messages[0].toolCalls?.[0]).toMatchObject({
      id: 'edit-1',
      input: {
        edits: [{ oldText: 'old', newText: 'new' }],
        file_path: 'notes/a.md',
        path: 'notes/a.md',
      },
      name: 'Edit',
      result: 'Edited notes/a.md',
      status: 'completed',
    });
    expect(messages[0].toolCalls?.[0].diffData).toMatchObject({
      filePath: 'notes/a.md',
      stats: { added: 1, removed: 1 },
    });
    expect(messages[0].toolCalls?.[0].diffData?.diffLines.map(line => line.text)).toEqual(['old', 'new']);
  });

  it('resolves only the active branch path', () => {
    const entries: OmpSessionEntry[] = [
      { id: 'root', raw: {}, type: 'entry' },
      { id: 'left', parentId: 'root', raw: {}, type: 'entry' },
      { id: 'right', parentId: 'root', raw: {}, type: 'entry' },
    ];

    expect(resolveOmpActivePath(entries, 'left').map(entry => entry.id)).toEqual(['root', 'left']);
    expect(resolveOmpActivePath(entries).map(entry => entry.id)).toEqual(['root', 'right']);
  });

  it('keeps id-less tool results attached to the active branch', () => {
    const content = [
      JSON.stringify({
        id: 'root',
        type: 'entry',
        message: { role: 'user', content: 'Read the active file' },
      }),
      JSON.stringify({
        id: 'left',
        parentId: 'root',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { id: 'tool-left', input: { path: 'left.md' }, name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        result: { content: [{ text: 'left contents', type: 'text' }] },
        toolCallId: 'tool-left',
        type: 'toolResult',
      }),
      JSON.stringify({
        id: 'right',
        parentId: 'root',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { id: 'tool-right', input: { path: 'right.md' }, name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        result: { content: [{ text: 'right contents', type: 'text' }] },
        toolCallId: 'tool-right',
        type: 'toolResult',
      }),
    ].join('\n');

    const messages = parseOmpSessionContent(content, { leafEntryId: 'left' });

    expect(messages[1].toolCalls).toEqual([{
      id: 'tool-left',
      input: { file_path: 'left.md', path: 'left.md' },
      name: 'Read',
      result: 'left contents',
      status: 'completed',
    }]);
  });

  it('resolves a strict entry path for fork checkpoints without sibling branches', () => {
    const entries = parseOmpSessionEntries([
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', content: 'Next branch' } }),
      JSON.stringify({ id: 'a2', parentId: 'u2', type: 'message', message: { role: 'assistant', content: 'Later' } }),
    ].join('\n')).entries;

    expect(resolveOmpEntryPath(entries, 'a1').map(entry => entry.id)).toEqual(['u1', 'a1']);
  });

  it('truncates linear Omp sessions through the requested checkpoint', () => {
    const content = [
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', type: 'message', message: { role: 'user', content: 'Later' } }),
      JSON.stringify({ id: 'a2', type: 'message', message: { role: 'assistant', content: 'Do not include' } }),
    ].join('\n');
    const entries = parseOmpSessionEntries(content).entries;

    expect(resolveOmpEntryPath(entries, 'a1').map(entry => entry.id)).toEqual(['u1', 'a1']);
    expect(parseOmpSessionContent(content, { leafEntryId: 'a1' }).map(message => message.content)).toEqual([
      'First',
      'Done',
    ]);
  });

  it('keeps id-less trailing entries during normal linear hydration', () => {
    const content = [
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ type: 'custom_message', content: 'Trailing notice' }),
    ].join('\n');

    expect(parseOmpSessionContent(content).map(message => message.content)).toEqual([
      'First',
      'Done',
      'Trailing notice',
    ]);
    expect(parseOmpSessionContent(content, { leafEntryId: 'a1' }).map(message => message.content)).toEqual([
      'First',
      'Done',
    ]);
  });

  it('creates a self-contained Omp fork session file at the assistant checkpoint', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-fork-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'source-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/source-cwd' }),
      JSON.stringify({ id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', content: 'Do not copy' } }),
    ].join('\n'));

    const forked = await createOmpForkSessionFile(sourceFile, 'a1', {
      now: new Date('2026-02-03T04:05:06.789Z'),
      sessionId: 'fork-session',
      targetCwd: '/target-cwd',
    });
    const forkedContent = await fs.readFile(forked.sessionFile, 'utf-8');
    const forkedLines = forkedContent.trim().split('\n').map(line => JSON.parse(line));

    expect(forked).toEqual({
      leafEntryId: 'a1',
      parentSession: sourceFile,
      sessionFile: path.join(dir, '2026-02-03T04-05-06-789Z_fork-session.jsonl'),
      sessionId: 'fork-session',
    });
    expect(forkedLines).toEqual([
      {
        cwd: '/target-cwd',
        id: 'fork-session',
        parentSession: sourceFile,
        timestamp: '2026-02-03T04:05:06.789Z',
        type: 'session',
        version: 3,
      },
      { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'First' } },
      { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } },
    ]);
  });

  it('rolls back only the exact newly created fork target and joins duplicate cleanup', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-fork-rollback-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ id: 'source', type: 'session', version: 3 }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
    ].join('\n'));
    const forked = await createOmpForkSessionFile(sourceFile, 'a1', {
      sessionId: 'fork-session',
    });
    const createdTarget = forked.sessionFile;

    forked.sessionFile = sourceFile;
    forked.parentSession = createdTarget;
    await Promise.all([
      rollbackCreatedOmpForkSessionFile(forked),
      rollbackCreatedOmpForkSessionFile(forked),
    ]);

    await expect(fs.access(sourceFile)).resolves.toBeUndefined();
    await expect(fs.access(createdTarget)).rejects.toThrow();
    await expect(rollbackCreatedOmpForkSessionFile(forked)).rejects.toThrow(
      'not owned by this process',
    );
    await fs.rm(dir, { force: true, recursive: true });
  });

  it('includes active id-less tool results when creating linear Omp fork files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-fork-linear-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'source-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/source-cwd' }),
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'Read a file' } }),
      JSON.stringify({
        id: 'a1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { id: 'tool-1', input: { path: 'a.md' }, name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        result: { content: [{ text: 'file contents', type: 'text' }] },
        toolCallId: 'tool-1',
        type: 'toolResult',
      }),
      JSON.stringify({ id: 'u2', type: 'message', message: { role: 'user', content: 'Do not copy' } }),
    ].join('\n'));

    const forked = await createOmpForkSessionFile(sourceFile, 'a1', {
      now: new Date('2026-02-03T04:05:06.789Z'),
      sessionId: 'fork-session',
    });
    const forkedContent = await fs.readFile(forked.sessionFile, 'utf-8');
    const forkedLines = forkedContent.trim().split('\n').map(line => JSON.parse(line));

    expect(forkedLines.map(line => line.id)).toEqual(['fork-session', 'u1', 'a1', undefined]);
    expect(forkedLines[3]).toMatchObject({
      toolCallId: 'tool-1',
      type: 'toolResult',
    });
    expect(parseOmpSessionContent(forkedContent)[1].toolCalls).toEqual([{
      id: 'tool-1',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      result: 'file contents',
      status: 'completed',
    }]);
  });

  it('ignores malformed lines and maps compaction boundaries', () => {
    const content = [
      'not-json',
      JSON.stringify({ id: 'c1', type: 'compaction' }),
    ].join('\n');

    expect(parseOmpSessionContent(content)[0].contentBlocks).toEqual([{ type: 'context_compacted' }]);
  });

  it('parses the fixed-width title slot Omp writes before the header', () => {
    const titleSlot = createTitleSlot('Forked session');
    const content = [
      titleSlot,
      JSON.stringify({ type: 'session', id: 's1', cwd: '/vault', timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'Hello' } }),
      JSON.stringify({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Hi' } }),
    ].join('\n');

    const parsed = parseOmpSessionEntries(content);

    expect(Buffer.byteLength(titleSlot)).toBe(256);
    expect(parsed.header).toMatchObject({ id: 's1', type: 'session' });
    expect(parsed.entries.map(entry => entry.id)).toEqual(['u1', 'a1']);
    expect(parsed.entries.some(entry => entry.type === 'title')).toBe(false);
    expect(parseOmpSessionContent(content).map(message => message.content)).toEqual(['Hello', 'Hi']);
  });

  it('parses legacy titless files whose header carries no version', async () => {
    const legacyLines = [
      JSON.stringify({ type: 'session', id: 'legacy-session' }),
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'Hello' } }),
    ];
    const titledLines = [createTitleSlot('Titled session'), ...legacyLines];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-title-'));
    const legacyFile = path.join(dir, 'legacy.jsonl');
    const titledFile = path.join(dir, 'titled.jsonl');
    await fs.writeFile(legacyFile, legacyLines.join('\n'));
    await fs.writeFile(titledFile, titledLines.join('\n'));

    const legacyHeader = parseOmpSessionEntries(legacyLines.join('\n')).header;

    expect(legacyHeader).toEqual({ type: 'session', id: 'legacy-session' });
    await expect(readOmpSessionHeader(legacyFile)).resolves.toEqual(legacyHeader);
    await expect(readOmpSessionHeader(titledFile)).resolves.toEqual(legacyHeader);
    expect(parseOmpSessionContent(titledLines.join('\n')).map(message => message.content)).toEqual(['Hello']);
    await fs.rm(dir, { force: true, recursive: true });
  });

  it('recovers the model from model_change entries on the active branch', () => {
    const content = [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ id: 'm1', parentId: 'u1', type: 'model_change', model: 'openai-codex/gpt-5.4-mini' }),
      JSON.stringify({ id: 'm2', parentId: 'm1', type: 'model_change', model: 'openai-codex/gpt-5.5' }),
      JSON.stringify({ id: 'other', parentId: 'u1', type: 'model_change', model: 'openrouter/anthropic/claude-3.5' }),
    ].join('\n');

    expect(parseOmpSessionModel(content, 'm2')).toBe('omp:openai-codex/gpt-5.5');
    expect(parseOmpSessionModel(content)).toBe('omp:openrouter/anthropic/claude-3.5');
    expect(parseOmpSessionModel(content, 'missing-leaf')).toBeNull();
  });

  it('ignores unknown entry types instead of failing the replay', () => {
    const content = [
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'Hello' } }),
      JSON.stringify({ id: 'x1', parentId: 'u1', type: 'service_tier_change', tier: 'priority' }),
      JSON.stringify({ id: 'x2', parentId: 'x1', type: 'future_entry_kind', payload: { note: 1 } }),
      JSON.stringify({ id: 'a1', parentId: 'x2', type: 'message', message: { role: 'assistant', content: 'Hi' } }),
    ].join('\n');

    expect(parseOmpSessionContent(content).map(message => message.content)).toEqual(['Hello', 'Hi']);
  });

  it('copies the source title slot into the fork file without touching the source', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-fork-title-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    const titleSlot = createTitleSlot('Source session');
    const sourceContent = [
      titleSlot,
      JSON.stringify({ type: 'session', version: 3, id: 'source-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/source-cwd' }),
      JSON.stringify({ id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', content: 'Do not copy' } }),
    ].join('\n');
    await fs.writeFile(sourceFile, sourceContent);

    const forked = await createOmpForkSessionFile(sourceFile, 'a1', {
      now: new Date('2026-02-03T04:05:06.789Z'),
      sessionId: 'fork-session',
    });
    const forkedLines = (await fs.readFile(forked.sessionFile, 'utf-8')).trim().split('\n');

    expect(forkedLines[0]).toBe(titleSlot);
    expect(JSON.parse(forkedLines[1])).toMatchObject({
      id: 'fork-session',
      parentSession: sourceFile,
      type: 'session',
    });
    expect(forkedLines.slice(2).map(line => JSON.parse(line).id)).toEqual(['u1', 'a1']);
    await expect(fs.readFile(sourceFile, 'utf-8')).resolves.toBe(sourceContent);
    await fs.rm(dir, { force: true, recursive: true });
  });

  it('writes a titless fork for legacy sources so the legacy shape stays valid', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-fork-legacy-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ type: 'session', id: 'legacy-session', cwd: '/legacy-cwd' }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
    ].join('\n'));

    const forked = await createOmpForkSessionFile(sourceFile, 'a1', {
      now: new Date('2026-02-03T04:05:06.789Z'),
      sessionId: 'fork-session',
    });
    const forkedRecords = (await fs.readFile(forked.sessionFile, 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    expect(forkedRecords.map(record => record.type)).toEqual(['session', 'message']);
    await expect(readOmpSessionHeader(forked.sessionFile)).resolves.toMatchObject({
      id: 'fork-session',
      parentSession: sourceFile,
    });
    await fs.rm(dir, { force: true, recursive: true });
  });
});
