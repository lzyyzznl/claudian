import {
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_READ,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from '@/core/tools/toolNames';

/**
 * omp builtin tool names mapped onto the shared renderer names. Only names with a
 * shared equivalent are listed; everything else passes through unchanged. `omp`
 * has no `ls`, `glob` is canonical, and `find`/`search` are its legacy aliases.
 */
const OMP_BUILT_IN_TOOL_NAMES: Record<string, string> = {
  bash: TOOL_BASH,
  edit: TOOL_EDIT,
  find: TOOL_GLOB,
  glob: TOOL_GLOB,
  grep: TOOL_GREP,
  read: TOOL_READ,
  search: TOOL_GREP,
  web_fetch: TOOL_WEB_FETCH,
  web_search: TOOL_WEB_SEARCH,
  write: TOOL_WRITE,
};

export function extractOmpToolTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(extractOmpToolTextContent)
      .filter(Boolean)
      .join('\n');
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
  if (Array.isArray(value.content)) {
    return extractOmpToolTextContent(value.content);
  }
  if (isPlainObject(value.partialResult)) {
    return extractOmpToolTextContent(value.partialResult.content);
  }
  if (isPlainObject(value.result)) {
    return extractOmpToolTextContent(value.result.content ?? value.result);
  }

  return '';
}

export function normalizeOmpToolInput(value: unknown, toolName?: string): Record<string, unknown> {
  const input = isPlainObject(value) ? { ...value } : {};
  const normalizedToolName = toolName ? normalizeOmpToolName(toolName) : '';

  if (
    (normalizedToolName === TOOL_READ || normalizedToolName === TOOL_WRITE || normalizedToolName === TOOL_EDIT)
    && typeof input.path === 'string'
    && typeof input.file_path !== 'string'
  ) {
    input.file_path = input.path;
  }

  return input;
}

export function getOmpToolId(value: Record<string, unknown>): string {
  return firstString(value.id, value.toolCallId, value.callId, value.call_id) ?? '';
}

export function getOmpToolName(value: Record<string, unknown>): string {
  return normalizeOmpToolName(firstString(value.name, value.tool, value.toolName, value.tool_name) ?? 'tool');
}

export function normalizeOmpToolName(name: string): string {
  return OMP_BUILT_IN_TOOL_NAMES[name.trim().toLowerCase()] ?? name;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
