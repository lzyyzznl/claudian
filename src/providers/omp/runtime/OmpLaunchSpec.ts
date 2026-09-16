import { decodeOmpModelId, normalizeOmpThinkingLevel } from '@/providers/omp/models';
import type { OmpProviderSettings } from '@/providers/omp/settings';
import type { OmpProviderState } from '@/providers/omp/types';

export interface BuildOmpLaunchSpecParams {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  envText?: string;
  model?: string | null;
  noSession?: boolean;
  noTools?: boolean;
  tools?: readonly string[];
  providerState?: OmpProviderState | null;
  settings: OmpProviderSettings;
  systemPrompt?: string;
  thinkingLevel?: string | null;
}

export interface OmpLaunchSpec {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  processKey: string;
  sessionTarget: string | null;
}

/**
 * `rpc-ui` sets omp's `hasUI`, which turns tool approvals and dialogs into
 * `extension_ui_request` frames instead of failing closed. Plain `rpc` only emits them.
 */
const OMP_RPC_MODE = 'rpc-ui';

/** pi's set (`read,grep,find,ls`) is rejected by omp: it has no `ls`, and `find` is a legacy alias of `glob`. */
const OMP_READONLY_TOOLS = 'read,grep,glob';

export function buildOmpLaunchSpec(params: BuildOmpLaunchSpecParams): OmpLaunchSpec {
  const args = ['--mode', OMP_RPC_MODE];
  let sessionFlagIndex: number | null = null;
  const sessionTarget = params.providerState?.sessionFile
    ?? params.providerState?.sessionId
    ?? null;
  const systemPrompt = params.systemPrompt?.trim();
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  if (params.noSession) {
    args.push('--no-session');
  } else if (sessionTarget) {
    sessionFlagIndex = args.length;
    args.push('--session', sessionTarget);
  }

  if (params.noTools) {
    args.push('--no-tools');
  } else if (params.tools) {
    args.push('--tools', params.tools.join(','));
  } else if (params.settings.toolMode === 'readonly') {
    args.push('--tools', OMP_READONLY_TOOLS);
  }

  const decodedModel = typeof params.model === 'string' ? decodeOmpModelId(params.model) : null;
  if (decodedModel) {
    args.push('--provider', decodedModel.provider, '--model', decodedModel.modelId);
  }

  const thinkingLevel = normalizeOmpThinkingLevel(params.thinkingLevel);
  if (thinkingLevel && thinkingLevel !== 'off') {
    args.push('--thinking', thinkingLevel);
  }

  return {
    args,
    command: params.command,
    cwd: params.cwd,
    env: params.env ?? process.env,
    processKey: JSON.stringify({
      args: withoutSessionTarget(args, sessionFlagIndex),
      command: params.command,
      cwd: params.cwd,
      envText: params.envText ?? params.settings.environmentVariables,
    }),
    sessionTarget: params.noSession ? null : sessionTarget,
  };
}

function withoutSessionTarget(
  args: readonly string[],
  sessionFlagIndex: number | null,
): string[] {
  if (sessionFlagIndex === null) return [...args];
  return [
    ...args.slice(0, sessionFlagIndex),
    ...args.slice(sessionFlagIndex + 2),
  ];
}
