import { buildOmpUsageInfo } from '@/providers/omp/runtime/buildOmpUsageInfo';

describe('buildOmpUsageInfo', () => {
  it('maps a live get_session_stats payload onto the core usage contract', () => {
    const usage = buildOmpUsageInfo({
      assistantMessages: 0,
      contextUsage: {
        contextWindow: 1_000_000,
        percent: 1.7433,
        tokens: 17_433,
      },
      cost: 0,
      premiumRequests: 0,
      sessionId: '01a0a91b-e2a5-701a-bb53-73dc2e7ba7eb',
      tokens: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        total: 0,
      },
    }, 'omp:openai/gpt-5');

    expect(usage).toEqual({
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: 17_433,
      contextWindow: 1_000_000,
      contextWindowIsAuthoritative: true,
      inputTokens: 0,
      model: 'omp:openai/gpt-5',
      percentage: 2,
    });
  });

  it('treats the provider percent as a whole percentage instead of a fraction', () => {
    const usage = buildOmpUsageInfo({
      contextUsage: {
        contextWindow: 200_000,
        percent: 1,
        tokens: 2_000,
      },
      tokens: { input: 1_400 },
    }, null);

    expect(usage?.percentage).toBe(1);
  });

  it('maps cumulative token counters onto the input and cache fields', () => {
    const usage = buildOmpUsageInfo({
      contextUsage: {
        contextWindow: 200_000,
        percent: 12.3456789,
        tokens: 24_691,
      },
      tokens: {
        cacheRead: 900,
        cacheWrite: 300,
        input: 1_200,
        total: 2_400,
      },
    }, null);

    expect(usage).toMatchObject({
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 900,
      contextTokens: 24_691,
      inputTokens: 1_200,
      percentage: 12,
    });
  });

  it('rounds derived percentages to match the shared context meter contract', () => {
    const usage = buildOmpUsageInfo({
      contextUsage: {
        contextWindow: 200_000,
        tokens: 11_830,
      },
    }, null);

    expect(usage?.percentage).toBe(6);
  });

  it('uses a fallback context window without marking it provider-authoritative', () => {
    const usage = buildOmpUsageInfo({
      contextUsage: {
        tokens: 50_000,
      },
    }, 'omp:anthropic/claude-sonnet-4', 1_000_000);

    expect(usage).toMatchObject({
      contextWindow: 1_000_000,
      contextWindowIsAuthoritative: false,
      percentage: 5,
    });
  });

  it('keeps usage when only the cumulative input counter is present', () => {
    const usage = buildOmpUsageInfo({
      contextUsage: {
        contextWindow: 200_000,
        tokens: 0,
      },
      tokens: { input: 400 },
    }, null);

    expect(usage).toMatchObject({
      contextTokens: 0,
      inputTokens: 400,
      percentage: 0,
    });
  });

  it('returns null when the payload carries no usage counters', () => {
    expect(buildOmpUsageInfo({ sessionId: 'session-1' }, 'omp:openai/gpt-5')).toBeNull();
    expect(buildOmpUsageInfo(undefined, null)).toBeNull();
  });
});
