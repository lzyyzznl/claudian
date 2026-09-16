import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { isWriteEditTool } from '../../../core/tools/toolNames';
import type { ChatMessage, ContentBlock, ImageAttachment, ToolCallInfo } from '../../../core/types';
import { extractUserQuery } from '../../../utils/context';
import { extractDiffData } from '../../../utils/diff';
import { buildImageAttachmentFromBase64 } from '../../../utils/imageAttachment';
import { encodeOmpModelId } from '../models';
import {
  extractOmpToolTextContent,
  normalizeOmpToolInput,
  normalizeOmpToolName,
} from '../normalizations/ompToolNormalization';
import { decodeOmpRecoveryPrompt } from './OmpRecoveryPromptCodec';

export interface OmpSessionEntry {
  id?: string;
  message?: Record<string, unknown>;
  parentId?: string;
  raw: Record<string, unknown>;
  type: string;
}

export interface ParsedOmpSessionEntries {
  entries: OmpSessionEntry[];
  header: Record<string, unknown> | null;
}

export interface ParseOmpSessionContentOptions {
  leafEntryId?: string;
  requireLeafEntryId?: boolean;
  syntheticIdNamespace?: string;
}

export interface CreateOmpForkSessionFileOptions {
  now?: Date;
  sessionDir?: string;
  sessionId?: string;
  targetCwd?: string;
}

export interface CreatedOmpForkSessionFile {
  leafEntryId: string;
  parentSession: string;
  sessionFile: string;
  sessionId: string;
}

interface OmpForkRollbackOwnership {
  flight: Promise<void> | null;
  readonly parentSession: string;
  readonly sessionFile: string;
}

const rollbackEligibleForkTargets = new WeakMap<
  CreatedOmpForkSessionFile,
  OmpForkRollbackOwnership
>();

export function parseOmpSessionContent(
  content: string,
  options: ParseOmpSessionContentOptions = {},
): ChatMessage[] {
  const parsed = parseOmpSessionEntries(content);
  const leafEntryId = options.leafEntryId?.trim();
  if (
    options.requireLeafEntryId
    && (!leafEntryId || !parsed.entries.some(entry => entry.id === leafEntryId))
  ) {
    return [];
  }

  return mapOmpSessionEntries(
    resolveOmpActivePath(parsed.entries, leafEntryId),
    options.syntheticIdNamespace,
  );
}

export function parseOmpSessionModel(
  content: string,
  leafEntryId?: string,
): string | null {
  const parsed = parseOmpSessionEntries(content);
  const persistedLeafEntryId = leafEntryId?.trim();
  if (
    persistedLeafEntryId
    && !parsed.entries.some(entry => entry.id === persistedLeafEntryId)
  ) {
    return null;
  }
  const entries = resolveOmpActivePath(parsed.entries, persistedLeafEntryId);
  let selection: string | null = null;
  for (const entry of entries) {
    const changedModel = entry.type === 'model_change' ? getString(entry.raw.model) : null;
    if (changedModel) {
      const separatorIndex = changedModel.indexOf('/');
      if (separatorIndex > 0 && separatorIndex < changedModel.length - 1) {
        selection = encodeOmpModelId(
          changedModel.slice(0, separatorIndex),
          changedModel.slice(separatorIndex + 1),
        );
        continue;
      }
    }

    const provider = getString(entry.raw.provider)
      ?? getString(entry.message?.provider);
    const modelId = getString(entry.raw.modelId)
      ?? getString(entry.message?.model);
    if (provider && modelId) {
      selection = encodeOmpModelId(provider, modelId);
    }
  }
  return selection;
}

export function parseOmpSessionEntries(content: string): ParsedOmpSessionEntries {
  const entries: OmpSessionEntry[] = [];
  let header: Record<string, unknown> | null = null;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isPlainObject(parsed)) {
        continue;
      }
      record = parsed;
    } catch {
      continue;
    }

    const type = getString(record.type) ?? getString(record.kind) ?? '';
    if (type === 'session') {
      header = record;
      continue;
    }
    if (type === 'title') {
      // Omp writes a fixed-width title slot as line 1; legacy files start at the header.
      continue;
    }

    const message = getRecord(record.message) ?? getRecord(record.data) ?? inferMessageRecord(record);
    entries.push({
      ...(getString(record.id) ? { id: getString(record.id)! } : {}),
      ...(message ? { message } : {}),
      ...(getString(record.parentId) ?? getString(record.parent_id)
        ? { parentId: (getString(record.parentId) ?? getString(record.parent_id))! }
        : {}),
      raw: record,
      type,
    });
  }

  return { entries, header };
}

export async function readOmpSessionHeader(
  sessionFile: string,
): Promise<Record<string, unknown> | null> {
  const maxHeaderBytes = 64 * 1024;
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(sessionFile, 'r');
    const buffer = Buffer.alloc(maxHeaderBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = content.split(/\r?\n/);
    if (lines.length === 1 && bytesRead === maxHeaderBytes) {
      return null;
    }

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let record: Record<string, unknown>;
      try {
        const raw = JSON.parse(line) as unknown;
        if (!isPlainObject(raw)) {
          return null;
        }
        record = raw;
      } catch {
        return null;
      }
      const type = getString(record.type);
      if (type === 'title') {
        // The fixed-width title slot precedes the header; legacy files omit it.
        continue;
      }
      return type === 'session' ? record : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function resolveOmpActivePath(entries: OmpSessionEntry[], leafId?: string): OmpSessionEntry[] {
  const entriesWithIds = entries.filter((entry): entry is OmpSessionEntry & { id: string } => !!entry.id);
  if (entriesWithIds.length === 0) {
    return entries;
  }

  const hasBranchGraph = hasOmpBranchGraph(entriesWithIds);
  if (!leafId && !hasBranchGraph) {
    return entries;
  }

  const byId = new Map(entriesWithIds.map(entry => [entry.id, entry] as const));
  const targetLeafId = leafId && byId.has(leafId)
    ? leafId
    : entriesWithIds[entriesWithIds.length - 1]?.id;
  if (!targetLeafId) {
    return entries;
  }

  const activePath = hasBranchGraph
    ? resolveOmpGraphEntryPath(byId, targetLeafId)
    : resolveOmpLinearEntryPath(entries, targetLeafId);
  if (activePath.length === 0) {
    return entries;
  }

  return hasBranchGraph
    ? includeOmpGraphPathEntries(entries, activePath)
    : includeOmpLinearPathEntries(entries, activePath);
}

export function resolveOmpEntryPath(entries: OmpSessionEntry[], leafId: string): OmpSessionEntry[] {
  const entriesWithIds = entries.filter((entry): entry is OmpSessionEntry & { id: string } => !!entry.id);
  const byId = new Map(entriesWithIds.map(entry => [entry.id, entry] as const));
  if (!byId.has(leafId)) {
    return [];
  }

  const hasBranchGraph = hasOmpBranchGraph(entriesWithIds);
  const activePath = hasBranchGraph
    ? resolveOmpGraphEntryPath(byId, leafId)
    : resolveOmpLinearEntryPath(entries, leafId);
  if (activePath.length === 0) {
    return [];
  }

  return hasBranchGraph
    ? includeOmpGraphPathEntries(entries, activePath)
    : includeOmpLinearPathEntries(entries, activePath);
}

function hasOmpBranchGraph(entriesWithIds: OmpSessionEntry[]): boolean {
  return entriesWithIds.some(entry => !!entry.parentId && !isToolResultEntry(entry));
}

function resolveOmpGraphEntryPath(
  byId: Map<string, OmpSessionEntry>,
  targetLeafId: string,
): OmpSessionEntry[] {
  const activePath: OmpSessionEntry[] = [];
  const seen = new Set<string>();
  let current: OmpSessionEntry | undefined = byId.get(targetLeafId);
  while (current) {
    if (!current.id || seen.has(current.id)) {
      break;
    }
    seen.add(current.id);
    activePath.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return activePath;
}

function resolveOmpLinearEntryPath(entries: OmpSessionEntry[], targetLeafId: string): OmpSessionEntry[] {
  const leafIndex = entries.findIndex(entry => entry.id === targetLeafId);
  if (leafIndex < 0) {
    return [];
  }
  return entries.slice(0, leafIndex + 1);
}

function includeOmpGraphPathEntries(
  entries: OmpSessionEntry[],
  activePath: OmpSessionEntry[],
): OmpSessionEntry[] {
  const activeIds = new Set(activePath.map(entry => entry.id).filter((id): id is string => !!id));
  const activeToolCallIds = collectToolCallIds(activePath);
  return entries.filter((entry) => {
    if (isToolResultEntry(entry)) {
      const toolCallId = getToolResultCallId(entry);
      return (!!toolCallId && activeToolCallIds.has(toolCallId))
        || (!!entry.id && activeIds.has(entry.id))
        || (!!entry.parentId && activeIds.has(entry.parentId));
    }
    if (entry.id) {
      return activeIds.has(entry.id);
    }
    if (entry.parentId && activeIds.has(entry.parentId)) {
      return true;
    }
    return false;
  });
}

function includeOmpLinearPathEntries(
  entries: OmpSessionEntry[],
  activePath: OmpSessionEntry[],
): OmpSessionEntry[] {
  const activeEntries = new Set(activePath);
  const activeToolCallIds = collectToolCallIds(activePath);
  return entries.filter((entry) => {
    if (activeEntries.has(entry)) {
      return true;
    }
    if (!isToolResultEntry(entry)) {
      return false;
    }
    const toolCallId = getToolResultCallId(entry);
    return !!toolCallId && activeToolCallIds.has(toolCallId);
  });
}

export async function createOmpForkSessionFile(
  sourceSessionFile: string,
  resumeAt: string,
  options: CreateOmpForkSessionFileOptions = {},
): Promise<CreatedOmpForkSessionFile> {
  const sourceContent = await fsp.readFile(sourceSessionFile, 'utf-8');
  const parsed = parseOmpSessionEntries(sourceContent);
  const branchEntries = resolveOmpEntryPath(parsed.entries, resumeAt);
  if (branchEntries.length === 0) {
    throw new Error(`Omp fork checkpoint not found: ${resumeAt}`);
  }

  const timestamp = options.now ?? new Date();
  const timestampText = timestamp.toISOString();
  const sessionId = options.sessionId ?? randomUUID();
  const sessionDir = options.sessionDir ?? path.dirname(sourceSessionFile);
  const sessionFile = path.join(
    sessionDir,
    `${timestampText.replace(/[:.]/g, '-')}_${sessionId}.jsonl`,
  );
  const sourceCwd = typeof parsed.header?.cwd === 'string' && parsed.header.cwd.trim()
    ? parsed.header.cwd.trim()
    : process.cwd();
  const header = {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: timestampText,
    cwd: options.targetCwd ?? sourceCwd,
    parentSession: sourceSessionFile,
  };
  const titleLine = extractTitleSlotLine(sourceContent);
  const lines = [
    ...(titleLine ? [titleLine] : []),
    JSON.stringify(header),
    ...branchEntries.map(entry => JSON.stringify(entry.raw)),
  ];

  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.writeFile(sessionFile, `${lines.join('\n')}\n`, { flag: 'wx' });

  const created = {
    leafEntryId: resumeAt,
    parentSession: sourceSessionFile,
    sessionFile,
    sessionId,
  };
  rollbackEligibleForkTargets.set(created, {
    flight: null,
    parentSession: sourceSessionFile,
    sessionFile,
  });
  return created;
}

export async function rollbackCreatedOmpForkSessionFile(
  created: CreatedOmpForkSessionFile,
): Promise<void> {
  const ownership = rollbackEligibleForkTargets.get(created);
  if (!ownership) {
    throw new Error('Omp fork rollback target is not owned by this process.');
  }
  if (!ownership.flight) {
    ownership.flight = (async () => {
      if (path.resolve(ownership.sessionFile) === path.resolve(ownership.parentSession)) {
        throw new Error('Omp fork rollback cannot remove the source session.');
      }
      await fsp.unlink(ownership.sessionFile);
      rollbackEligibleForkTargets.delete(created);
    })();
  }
  return ownership.flight;
}

export function findOmpSessionFile(
  sessionIdOrFile: string,
  cwd?: string | null,
  sessionDir?: string | null,
): string | null {
  const trimmed = sessionIdOrFile.trim();
  if (!trimmed) {
    return null;
  }

  if (path.isAbsolute(trimmed) && fileExists(trimmed)) {
    return trimmed;
  }

  const roots = [
    sessionDir,
    cwd ? path.join(cwd, '.omp', 'agent', 'sessions') : null,
    path.join(os.homedir(), '.omp', 'agent', 'sessions'),
  ].filter((root): root is string => !!root);

  for (const root of roots) {
    const direct = path.join(root, trimmed.endsWith('.jsonl') ? trimmed : `${trimmed}.jsonl`);
    if (fileExists(direct)) {
      return direct;
    }

    const found = findSessionFileInRoot(root, trimmed);
    if (found) {
      return found;
    }
  }

  return null;
}

/** Searches exactly one caller-owned root without adding implicit fallback roots. */
export function findOmpSessionFileInRoot(
  sessionId: string,
  root: string,
): string | null {
  const trimmed = sessionId.trim();
  if (!trimmed || path.isAbsolute(trimmed) || /[\\/]/.test(trimmed)) {
    return null;
  }

  const direct = path.join(root, trimmed.endsWith('.jsonl') ? trimmed : `${trimmed}.jsonl`);
  if (fileExists(direct)) {
    return direct;
  }
  return findSessionFileInRoot(root, trimmed);
}

export function deriveOmpSessionsRootFromSessionPath(sessionPath: string): string | null {
  const normalized = sessionPath.trim();
  if (!normalized) {
    return null;
  }

  return path.dirname(normalized);
}

function mapOmpSessionEntries(
  entries: OmpSessionEntry[],
  syntheticIdNamespace?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let turnStartedAt: number | undefined;

  for (const entry of entries) {
    const mapped = mapOmpSessionEntry(entry, messages, syntheticIdNamespace);
    if (mapped) {
      const previous = messages[messages.length - 1];
      if (isAssistantMessageEntry(entry) && canMergeAssistantContinuation(previous, mapped)) {
        mergeAssistantContinuation(previous, mapped);
      } else {
        messages.push(mapped);
      }

      const nativeMessage = entry.message ?? entry.raw;
      if (mapped.role === 'user') {
        turnStartedAt = parseTimestamp(nativeMessage.timestamp) ?? parseTimestamp(entry.raw.timestamp);
      } else if (isBoundaryMessage(mapped)) {
        turnStartedAt = undefined;
      } else if (isAssistantMessageEntry(entry)) {
        const stopReason = getString(nativeMessage.stopReason);
        // Omp's inner assistant timestamp is generation start; the entry is written on completion.
        const completedAt = parseTimestamp(entry.raw.timestamp);
        if ((stopReason === 'stop' || stopReason === 'length')
          && turnStartedAt !== undefined && completedAt !== undefined && completedAt >= turnStartedAt) {
          messages[messages.length - 1].completedAt = completedAt;
          messages[messages.length - 1].durationSeconds = Math.floor((completedAt - turnStartedAt) / 1_000);
        }
        if (stopReason && stopReason !== 'toolUse') turnStartedAt = undefined;
      }
    }
  }

  return messages;
}

function isAssistantMessageEntry(entry: OmpSessionEntry): boolean {
  const message = entry.message ?? entry.raw;
  return (getString(message.role) ?? inferRole(entry.type)) === 'assistant';
}

function isBoundaryMessage(message: ChatMessage): boolean {
  return message.contentBlocks?.some(block => block.type === 'context_compacted') === true;
}

function canMergeAssistantContinuation(
  previous: ChatMessage | undefined,
  next: ChatMessage,
): previous is ChatMessage {
  return previous?.role === 'assistant'
    && next.role === 'assistant'
    && !isBoundaryMessage(previous)
    && !isBoundaryMessage(next);
}

function mergeAssistantContinuation(target: ChatMessage, source: ChatMessage): void {
  target.content += source.content;
  target.assistantMessageId = source.assistantMessageId ?? target.assistantMessageId;

  if (source.contentBlocks && source.contentBlocks.length > 0) {
    target.contentBlocks = [
      ...(target.contentBlocks ?? []),
      ...source.contentBlocks,
    ];
  }

  if (source.toolCalls && source.toolCalls.length > 0) {
    const existingToolIds = new Set(target.toolCalls?.map(toolCall => toolCall.id) ?? []);
    const newToolCalls = source.toolCalls.filter(toolCall => !existingToolIds.has(toolCall.id));
    if (newToolCalls.length > 0) {
      target.toolCalls = [
        ...(target.toolCalls ?? []),
        ...newToolCalls,
      ];
    }
  }
}

function mapOmpSessionEntry(
  entry: OmpSessionEntry,
  messages: ChatMessage[],
  syntheticIdNamespace?: string,
): ChatMessage | null {
  const message = entry.message ?? entry.raw;
  const role = getString(message.role) ?? inferRole(entry.type);
  const timestamp = getTimestamp(message.timestamp ?? entry.raw.timestamp);

  if (role === 'user') {
    const rawContent = extractTextContent(message.content ?? message.text ?? message.message);
    const recoveryPrompt = decodeOmpRecoveryPrompt(rawContent);
    const content = recoveryPrompt?.currentInput ?? (recoveryPrompt ? '' : rawContent);
    const displayContent = extractOmpSkillDisplayContent(content);
    const messageId = entry.id ?? createSyntheticOmpMessageId(
      'user',
      messages.length,
      syntheticIdNamespace,
    );
    const images = extractUserImages(
      message.content ?? message.parts ?? message.blocks,
      messageId,
    );
    if (recoveryPrompt?.currentInput === null && images.length === 0) {
      return null;
    }
    return {
      content,
      ...(displayContent ? { displayContent } : {}),
      id: messageId,
      ...(images.length > 0 ? { images } : {}),
      role: 'user',
      timestamp,
      userMessageId: entry.id,
    };
  }

  if (role === 'assistant') {
    const contentBlocks = extractAssistantContentBlocks(message.content ?? message.parts ?? message.blocks);
    const toolCalls = extractAssistantToolCalls(message.content ?? message.parts ?? message.blocks);
    const text = contentBlocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.content)
      .join('');

    return {
      assistantMessageId: entry.id,
      content: text,
      ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
      id: entry.id ?? createSyntheticOmpMessageId(
        'assistant',
        messages.length,
        syntheticIdNamespace,
      ),
      role: 'assistant',
      timestamp,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  if (isToolResultEntry(entry)) {
    applyToolResult(messages, entry);
    return null;
  }

  if (entry.type === 'compaction') {
    return {
      content: '',
      contentBlocks: [{ type: 'context_compacted' }],
      id: entry.id ?? createSyntheticOmpMessageId(
        'compaction',
        messages.length,
        syntheticIdNamespace,
      ),
      role: 'assistant',
      timestamp,
    };
  }

  if (
    (entry.type === 'branch_summary' || entry.type === 'compactionSummary' || entry.type === 'custom_message')
    && entry.raw.display !== false
  ) {
    const content = extractTextContent(entry.raw.content ?? entry.raw.summary ?? entry.raw.message);
    if (!content) {
      return null;
    }
    return {
      content,
      contentBlocks: [{ type: 'text', content }],
      id: entry.id ?? createSyntheticOmpMessageId(
        'notice',
        messages.length,
        syntheticIdNamespace,
      ),
      role: 'assistant',
      timestamp,
    };
  }

  return null;
}

function createSyntheticOmpMessageId(
  kind: string,
  index: number,
  namespace?: string,
): string {
  const localId = `omp-${kind}-${index}`;
  return namespace ? `${namespace}:${localId}` : localId;
}

function extractOmpSkillDisplayContent(content: string): string | undefined {
  const match = content.match(
    /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/,
  );
  if (!match) return undefined;

  const visibleArguments = match[2] ? extractUserQuery(match[2]) : '';
  return `/skill:${match[1]}${visibleArguments ? ` ${visibleArguments}` : ''}`;
}

function extractAssistantContentBlocks(value: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const parts = Array.isArray(value) ? value : [{ type: 'text', text: extractTextContent(value) }];

  for (const part of parts) {
    if (!isPlainObject(part)) {
      continue;
    }

    const type = getString(part.type);
    if (type === 'thinking' || type === 'reasoning') {
      const content = extractTextContent(part.thinking ?? part.text ?? part.content);
      if (content) {
        blocks.push({ type: 'thinking', content });
      }
      continue;
    }

    if (type === 'toolCall' || type === 'tool_call' || type === 'toolUse' || type === 'tool_use') {
      const toolId = getString(part.id) ?? getString(part.toolCallId) ?? getString(part.callId);
      if (toolId) {
        blocks.push({ type: 'tool_use', toolId });
      }
      continue;
    }

    const content = extractTextContent(part.text ?? part.content);
    if (content) {
      blocks.push({ type: 'text', content });
    }
  }

  return blocks;
}

function extractUserImages(value: unknown, messageId: string): ImageAttachment[] {
  const parts = Array.isArray(value) ? value : [];
  const images: ImageAttachment[] = [];

  for (const part of parts) {
    if (!isPlainObject(part)) {
      continue;
    }

    const type = getString(part.type);
    if (type !== 'image') {
      continue;
    }

    const data = getString(part.data);
    const mediaType = getString(part.mimeType) ?? getString(part.mime_type) ?? getString(part.mediaType);
    if (!data || !mediaType) {
      continue;
    }

    const image = buildImageAttachmentFromBase64({
      data,
      id: `omp-img-${messageId}-${images.length}`,
      mediaType,
      name: getString(part.name) ?? getString(part.filename) ?? `image-${images.length + 1}.${mediaType.split('/')[1] ?? 'img'}`,
    });
    if (image) {
      images.push(image);
    }
  }

  return images;
}

function extractAssistantToolCalls(value: unknown): ToolCallInfo[] {
  const parts = Array.isArray(value) ? value : [];
  return parts.flatMap((part): ToolCallInfo[] => {
    if (!isPlainObject(part)) {
      return [];
    }

    const type = getString(part.type);
    if (type !== 'toolCall' && type !== 'tool_call' && type !== 'toolUse' && type !== 'tool_use') {
      return [];
    }

    const id = getString(part.id) ?? getString(part.toolCallId) ?? getString(part.callId);
    const rawName = getString(part.name) ?? getString(part.tool) ?? getString(part.toolName);
    if (!id || !rawName) {
      return [];
    }
    const name = normalizeOmpToolName(rawName);

    return [{
      id,
      input: normalizeOmpToolInput(part.input ?? part.arguments ?? part.args, name),
      name,
      status: 'running',
    }];
  });
}

function collectToolCallIds(entries: OmpSessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const message = entry.message ?? entry.raw;
    const parts = message.content ?? message.parts ?? message.blocks;
    for (const toolCall of extractAssistantToolCalls(parts)) {
      ids.add(toolCall.id);
    }
  }
  return ids;
}

function isToolResultEntry(entry: OmpSessionEntry): boolean {
  const message = entry.message ?? entry.raw;
  return entry.type === 'toolResult'
    || entry.type === 'tool_result'
    || getString(message.role) === 'toolResult'
    || getString(message.role) === 'tool_result';
}

function getToolResultCallId(entry: OmpSessionEntry): string | null {
  const message = entry.message ?? entry.raw;
  return getString(message.toolCallId)
    ?? getString(message.tool_call_id)
    ?? getString(message.id)
    ?? getString(entry.raw.toolCallId)
    ?? getString(entry.raw.tool_call_id)
    ?? getString(entry.raw.id);
}

function applyToolResult(messages: ChatMessage[], entry: OmpSessionEntry): void {
  const toolCallId = getToolResultCallId(entry);
  if (!toolCallId) {
    return;
  }

  for (let index = messages.length - 1; index >= 0; index--) {
    const chatMessage = messages[index];
    const toolCall = chatMessage.toolCalls?.find(call => call.id === toolCallId);
    if (!toolCall) {
      continue;
    }

    const resultMessage = entry.message ?? entry.raw;
    toolCall.status = resultMessage.error === true || resultMessage.isError === true ? 'error' : 'completed';
    toolCall.result = extractOmpToolTextContent(resultMessage.result ?? resultMessage.content ?? resultMessage.output);
    if (toolCall.status === 'completed' && isWriteEditTool(toolCall.name)) {
      const diffData = extractDiffData(resultMessage, toolCall);
      if (diffData) {
        toolCall.diffData = diffData;
      }
    }
    return;
  }
}

function inferMessageRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return getString(record.role) ? record : undefined;
}

function inferRole(type: string): string | null {
  if (type === 'user' || type === 'assistant') {
    return type;
  }
  return null;
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractTextContent).filter(Boolean).join('');
  }

  if (!isPlainObject(value)) {
    return '';
  }

  if (typeof value.text === 'string') {
    return value.text;
  }

  if (typeof value.content === 'string') {
    return value.content;
  }

  return '';
}

function findSessionFileInRoot(root: string, sessionId: string): string | null {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = findSessionFileInRoot(candidate, sessionId);
        if (nested) {
          return nested;
        }
      } else if (
        entry.isFile()
        && entry.name.endsWith('.jsonl')
        && entry.name.includes(sessionId)
      ) {
        return candidate;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getTimestamp(value: unknown): number {
  return parseTimestamp(value) ?? Date.now();
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Returns Omp's fixed-width title slot verbatim when the session file starts with one. */
function extractTitleSlotLine(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const record = JSON.parse(line) as unknown;
      return isPlainObject(record) && getString(record.type) === 'title' ? line : null;
    } catch {
      return null;
    }
  }

  return null;
}
