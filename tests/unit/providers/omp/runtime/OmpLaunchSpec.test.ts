import { buildOmpLaunchSpec } from '@/providers/omp/runtime/OmpLaunchSpec';
import type { OmpProviderSettings } from '@/providers/omp/settings';

const baseSettings: OmpProviderSettings = {
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: true,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  toolMode: 'all',
  visibleModels: [],
};

describe('OmpLaunchSpec', () => {
  it('builds main launch args with replacement system prompt and model flags', () => {
    expect(buildOmpLaunchSpec({
      command: '/bin/omp',
      cwd: '/vault',
      model: 'omp:anthropic/claude/sonnet',
      providerState: { sessionFile: '/tmp/session.jsonl' },
      settings: baseSettings,
      systemPrompt: 'System prompt',
      thinkingLevel: 'high',
    }).args).toEqual([
      '--mode',
      'rpc-ui',
      '--system-prompt',
      'System prompt',
      '--session',
      '/tmp/session.jsonl',
      '--provider',
      'anthropic',
      '--model',
      'claude/sonnet',
      '--thinking',
      'high',
    ]);
  });

  it('adds no-session and read-only tools when requested', () => {
    expect(buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      noSession: true,
      settings: {
        ...baseSettings,
        toolMode: 'readonly',
      },
    }).args).toEqual([
      '--mode',
      'rpc-ui',
      '--no-session',
      '--tools',
      'read,grep,glob',
    ]);
  });

  it('does not resume from detached previous sessions', () => {
    expect(buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      providerState: {
        previousSessions: [{
          leafEntryId: 'assistant-1',
          sessionFile: '/tmp/previous.jsonl',
          sessionId: 'previous-session',
        }],
      },
      settings: baseSettings,
    }).args).toEqual(['--mode', 'rpc-ui']);
  });

  it('passes the extended omp thinking ladder through to the CLI', () => {
    expect(buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      noSession: true,
      settings: baseSettings,
      thinkingLevel: 'max',
    }).args).toEqual([
      '--mode',
      'rpc-ui',
      '--no-session',
      '--thinking',
      'max',
    ]);

    expect(buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      noSession: true,
      settings: baseSettings,
      thinkingLevel: 'auto',
    }).args).toEqual([
      '--mode',
      'rpc-ui',
      '--no-session',
      '--thinking',
      'auto',
    ]);
  });

  it('omits the thinking flag for the off level', () => {
    expect(buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      noSession: true,
      settings: baseSettings,
      thinkingLevel: 'off',
    }).args).toEqual([
      '--mode',
      'rpc-ui',
      '--no-session',
    ]);
  });

  it('uses no-tools for passive auxiliary launches', () => {
    expect(buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      noSession: true,
      noTools: true,
      settings: baseSettings,
    }).args).toEqual([
      '--mode',
      'rpc-ui',
      '--no-session',
      '--no-tools',
    ]);
  });

  it('includes full runtime environment text in the process key', () => {
    const first = buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      envText: 'PATH=/first',
      settings: baseSettings,
    });
    const second = buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      envText: 'PATH=/second',
      settings: baseSettings,
    });

    expect(first.processKey).not.toBe(second.processKey);
  });

  it('keeps session identity separate from process compatibility', () => {
    const first = buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      providerState: { sessionFile: '/tmp/first.jsonl' },
      settings: baseSettings,
      systemPrompt: '--session',
    });
    const second = buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      providerState: { sessionFile: '/tmp/second.jsonl' },
      settings: baseSettings,
      systemPrompt: '--session',
    });

    expect(first.processKey).toBe(second.processKey);
    expect(JSON.parse(first.processKey).args).toEqual([
      '--mode',
      'rpc-ui',
      '--system-prompt',
      '--session',
    ]);
    expect(first.sessionTarget).toBe('/tmp/first.jsonl');
    expect(second.sessionTarget).toBe('/tmp/second.jsonl');
  });
});
