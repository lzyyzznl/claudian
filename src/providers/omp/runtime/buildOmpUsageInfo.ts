import type { UsageInfo } from '@/core/types';

/**
 * Maps omp's `get_session_stats` payload onto the core context-meter contract.
 *
 * omp reports `contextUsage.percent` as a whole percentage (`tokens / contextWindow * 100`), so it
 * is rounded and clamped rather than scaled. `tokens` carries the cumulative session counters used
 * for the optional cache fields; the payload's `cost` and `premiumRequests` have no core
 * counterpart. Missing fields degrade to zero or to the local fallbacks.
 */
export function buildOmpUsageInfo(
  response: unknown,
  model: string | null,
  fallbackContextWindow = 200_000,
): UsageInfo | null {
  const stats = getRecord(response);
  const tokens = getRecord(stats.tokens);
  const contextUsage = getRecord(stats.contextUsage ?? stats.context_usage ?? stats);
  const providerContextWindow = getNumber(contextUsage.contextWindow)
    ?? getNumber(contextUsage.context_window)
    ?? getNumber(contextUsage.window);
  const contextWindow = providerContextWindow ?? fallbackContextWindow;
  const contextTokens = getNumber(contextUsage.tokens)
    ?? getNumber(contextUsage.contextTokens)
    ?? getNumber(contextUsage.context_tokens)
    ?? getNumber(contextUsage.used)
    ?? 0;
  const inputTokens = getNumber(tokens.input)
    ?? getNumber(contextUsage.inputTokens)
    ?? getNumber(contextUsage.input_tokens)
    ?? contextTokens;

  if (contextTokens === 0 && inputTokens === 0) {
    return null;
  }

  return {
    cacheCreationInputTokens: getNumber(tokens.cacheWrite)
      ?? getNumber(contextUsage.cacheCreationInputTokens)
      ?? getNumber(contextUsage.cache_creation_input_tokens)
      ?? 0,
    cacheReadInputTokens: getNumber(tokens.cacheRead)
      ?? getNumber(contextUsage.cacheReadInputTokens)
      ?? getNumber(contextUsage.cache_read_input_tokens)
      ?? 0,
    contextTokens,
    contextWindow,
    contextWindowIsAuthoritative: providerContextWindow !== null,
    inputTokens,
    ...(model ? { model } : {}),
    percentage: normalizeOmpUsagePercentage(
      getNumber(contextUsage.percent),
      contextTokens,
      contextWindow,
    ),
  };
}

function normalizeOmpUsagePercentage(
  providerPercentage: number | null,
  contextTokens: number,
  contextWindow: number,
): number {
  const percentage = providerPercentage
    ?? (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0);
  return Math.min(100, Math.max(0, Math.round(percentage)));
}

function getRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
