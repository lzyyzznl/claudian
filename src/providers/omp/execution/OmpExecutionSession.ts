import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { JsonlRpcRecord } from '@/core/rpc/JsonlRpcTransport';

import {
  type ProviderExecutionErrorCategory,
  type ProviderExecutionEvent,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderRequestedEventScope,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionEventScope,
  type ProviderSessionInvalidation,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  type ProviderToolPolicy,
  type SteerableExecutionSession,
} from '../../../core/execution';
import {
  buildSystemPrompt,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  ChatMessage,
  StreamChunk,
} from '../../../core/types';
import { appendBrowserContext } from '../../../utils/browser';
import { appendCanvasContext } from '../../../utils/canvas';
import {
  appendLinkedContent,
} from '../../../utils/context';
import { appendEditorContext } from '../../../utils/editor';
import { parseEnvironmentVariables } from '../../../utils/env';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '../../../utils/session';
import type { OmpWorkspaceServices } from '../app/OmpWorkspaceServices';
import {
  isOmpSessionPathReference,
  resolveOmpSessionFileHint,
} from '../history/OmpHistoryPathResolver';
import {
  type CreatedOmpForkSessionFile,
  type createOmpForkSessionFile,
  findOmpSessionFile,
  parseOmpSessionEntries,
  resolveOmpActivePath,
  type rollbackCreatedOmpForkSessionFile,
} from '../history/OmpHistoryStore';
import { encodeOmpRecoveryPrompt } from '../history/OmpRecoveryPromptCodec';
import {
  clampOmpThinkingLevel,
  decodeOmpModelId,
  findOmpModel,
} from '../models';
import {
  createOmpEventNormalizationState,
  getOmpTerminalErrorMessage,
  normalizeOmpRpcEvent,
  type OmpEventNormalizationState,
} from '../normalizations/ompEventNormalization';
import { buildOmpUsageInfo } from '../runtime/buildOmpUsageInfo';
import type { OmpExtensionUiRenderer } from '../runtime/OmpExtensionUiBridge';
import {
  buildOmpLaunchSpec,
  type OmpLaunchSpec,
} from '../runtime/OmpLaunchSpec';
import { buildOmpSetModelPayload } from '../runtime/OmpRpcPayloads';
import {
  getOmpProviderSettings,
  type OmpProviderSettings,
} from '../settings';
import {
  getOmpState,
  type OmpProviderState,
} from '../types';
import { normalizeOmpRuntimeCommands } from './OmpCommandMetadataProbe';
import {
  type OmpExecutionKernel,
  type OmpExecutionKernelFactory,
} from './OmpExecutionKernel';

interface OmpExecutionSessionOptions {
  readonly createForkSessionFile: typeof createOmpForkSessionFile;
  readonly createKernel: OmpExecutionKernelFactory;
  readonly extensionUiRenderer: OmpExtensionUiRenderer | null;
  readonly rollbackForkSessionFile: typeof rollbackCreatedOmpForkSessionFile;
}

type OmpExecutionServices = Pick<OmpWorkspaceServices, 'commandCatalog'>;

interface EncodedOmpRequest {
  readonly images: OmpPromptImage[];
  readonly launchSpec: OmpLaunchSpec;
  readonly model: string;
  readonly prompt: string;
  readonly thinkingLevel: string | null;
}

interface OmpPromptImage {
  readonly data: string;
  readonly mimeType: string;
  readonly type: 'image';
}

interface ActiveRun {
  readonly abortController: AbortController;
  readonly events: AsyncEventQueue<ProviderExecutionEvent>;
  readonly executionId: string;
  readonly inputText: string;
  readonly onRequestAbort: () => void;
  readonly requestSignal: AbortSignal;
  readonly turnId: string;
  accepted: boolean;
  assistantStarted: boolean;
  nativeRequestDispatched: boolean;
  nativeAssistantId?: string;
  nativeUserMessageId?: string;
  pendingTerminalError: Error | null;
  sequence: number;
  terminal: boolean;
  terminalSignal: Deferred<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(error: Error): void;
  resolve(value: T): void;
}

const OMP_NATIVE_PROVIDER_STATE_KEYS = [
  'sessionId',
  'sessionFile',
  'leafEntryId',
  'parentSession',
  'forkSource',
  'forkSourceSessionFile',
] as const satisfies readonly (keyof OmpProviderState)[];

export class OmpExecutionSession
implements ProviderExecutionSession, SteerableExecutionSession {
  readonly providerId = 'omp' as const;
  readonly sessionInstanceId = randomUUID();

  private activeRun: ActiveRun | null = null;
  private disposalPromise: Promise<void> | null = null;
  private disposed = false;
  private forkMaterializationFlight: Promise<void> | null = null;
  private kernel: OmpExecutionKernel | null = null;
  private kernelGeneration = 0;
  private processKey: string | null = null;
  private readonly kernelSessionTargets = new Set<string>();
  private kernelResumeValidationTarget: string | null = null;
  private lifecycleError: Error | null = null;
  private normalizationState: OmpEventNormalizationState =
    createOmpEventNormalizationState();
  private nativeConversationContextEstablished: boolean;
  private providerSessionId: string | null;
  private providerState: Record<string, unknown>;
  private readonly providerStateDeletes = new Set<string>();
  private resumeSeedNeedsValidation: boolean;
  private revision = 0;
  private readonly runFlights = new Set<Promise<void>>();
  private readonly sessionListeners = new Set<
    (event: ProviderSessionEvent) => void
  >();
  private sessionSequence = 0;
  private shutdownPromise: Promise<void> | null = null;
  private snapshotInvalidation: ProviderSessionInvalidation | null = null;
  private status: ProviderSessionStatus = 'idle';

  constructor(
    private readonly host: ProviderHost,
    private readonly services: OmpExecutionServices,
    private readonly config: ProviderSessionConfig,
    private readonly options: OmpExecutionSessionOptions,
  ) {
    const rawState = isRecord(config.resumeSeed?.providerState)
      ? cloneRecord(config.resumeSeed.providerState)
      : {};
    const state = getOmpState(rawState);
    const providerSessionId = state.sessionId
      ?? config.resumeSeed?.providerSessionId
      ?? null;
    const nativePersistenceDisabled = config.lifecycle === 'ephemeral'
      || config.nativePersistence === 'disabled-if-supported';
    this.providerSessionId = nativePersistenceDisabled
      ? null
      : providerSessionId;
    this.nativeConversationContextEstablished = !nativePersistenceDisabled
      && Boolean(state.sessionId || state.sessionFile || providerSessionId);
    this.providerState = {
      ...rawState,
      ...(!nativePersistenceDisabled && providerSessionId
        ? { sessionId: providerSessionId }
        : {}),
    };
    this.resumeSeedNeedsValidation = !nativePersistenceDisabled
      && !state.forkSource
      && Boolean(state.sessionFile || providerSessionId);
    if (nativePersistenceDisabled) {
      this.removeNativeProviderState();
    }
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) {
      throw new Error('OMP execution session is disposed');
    }
    if (this.lifecycleError) {
      throw new Error('OMP execution session cleanup failed and requires disposal.');
    }
    if (this.activeRun) {
      throw new Error('OMP execution session already has an active run');
    }

    const active = this.createActiveRun(request);
    this.activeRun = active;
    this.normalizationState = createOmpEventNormalizationState();
    this.setStatus('executing');
    this.emitRequestedState(active);
    if (request.signal.aborted) {
      this.cancel();
    } else {
      const runFlight = this.run(active, request);
      this.runFlights.add(runFlight);
      runFlight.then(
        () => this.runFlights.delete(runFlight),
        () => this.runFlights.delete(runFlight),
      );
    }
    return {
      executionId: active.executionId,
      turnId: active.turnId,
      events: active.events,
      cancel: () => {
        if (this.activeRun === active) this.cancel();
      },
    };
  }

  cancel(): void {
    const active = this.activeRun;
    if (!active || active.terminal) return;
    this.setStatus('cancelling');
    this.emitRequestedState(active);
    active.abortController.abort();
    active.terminalSignal.reject(new Error('OMP turn cancelled'));
    this.kernel?.send({ type: 'abort' });
    this.setStatus('idle');
    this.emitRequestedState(active);
    this.finishRequested(active, {
      reason: 'Cancelled',
      type: 'cancelled',
    });
    void this.shutdownKernel();
  }

  async steer(request: ProviderExecutionRequest): Promise<boolean> {
    const active = this.activeRun;
    const kernel = this.kernel;
    if (
      this.disposed
      || !active
      || !kernel
      || this.kernelResumeValidationTarget !== null
      || request.signal.aborted
    ) {
      return false;
    }
    const prompt = encodePrompt(request, false);
    await kernel.request('steer', {
      ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
      message: prompt.text,
    }, undefined, request.signal);
    if (this.activeRun === active && !this.disposed && this.kernel === kernel) {
      this.emitRequested(active, {
        content: getInputText(request),
        type: 'user_message_started',
      });
    }
    return true;
  }

  getSnapshot(): ProviderSessionSnapshot {
    const providerStateDeletes = [...this.providerStateDeletes];
    const base = {
      providerId: this.providerId,
      revision: this.revision,
      ...(this.providerSessionId
        ? { providerSessionId: this.providerSessionId }
        : {}),
      ...(Object.keys(this.providerState).length > 0
        ? { providerState: Object.freeze(cloneRecord(this.providerState)) }
        : {}),
      ...(providerStateDeletes.length > 0
        ? { providerStateDeletes: Object.freeze(providerStateDeletes) }
        : {}),
    };
    return Object.freeze(this.status === 'invalidated'
      ? {
        ...base,
        invalidation: Object.freeze(this.snapshotInvalidation ?? {
          reason: 'provider-error' as const,
          recoverable: true,
        }),
        status: 'invalidated' as const,
      }
      : {
        ...base,
        status: this.status,
      });
  }

  getStatus(): ProviderSessionStatus {
    return this.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    this.disposed = true;
    if (this.activeRun) this.cancel();
    this.disposalPromise = (async () => {
      let lifecycleError = this.lifecycleError;
      const runResults = await Promise.allSettled([...this.runFlights]);
      lifecycleError ??= getFirstRejectedError(runResults);
      try {
        await this.shutdownKernel();
      } catch (error) {
        lifecycleError ??= toError(error);
      }
      this.setStatus('disposed');
      this.emitSession({
        snapshot: this.getSnapshot(),
        type: 'session_state_changed',
      });
      this.sessionListeners.clear();
      if (lifecycleError) throw lifecycleError;
    })();
    return this.disposalPromise;
  }

  private createActiveRun(request: ProviderExecutionRequest): ActiveRun {
    const abortController = new AbortController();
    const onRequestAbort = (): void => this.cancel();
    const events = new AsyncEventQueue<ProviderExecutionEvent>(() => {
      this.cancel();
    });
    request.signal.addEventListener('abort', onRequestAbort, { once: true });
    return {
      abortController,
      events,
      executionId: randomUUID(),
      inputText: getInputText(request),
      onRequestAbort,
      requestSignal: request.signal,
      turnId: randomUUID(),
      accepted: false,
      assistantStarted: false,
      nativeRequestDispatched: false,
      pendingTerminalError: null,
      sequence: 0,
      terminal: false,
      terminalSignal: createDeferred<void>(),
    };
  }

  private async run(
    active: ActiveRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    try {
      const encoded = await this.encodeRequest(active, request);
      if (!this.isActive(active)) return;
      await this.ensureKernel(encoded.launchSpec, active);
      if (!this.isActive(active) || !this.kernel) return;

      await this.validateKernelResume(active.abortController.signal);
      if (!this.isActive(active) || !this.kernel) return;
      await this.applyModelConfiguration(encoded, active.abortController.signal);
      if (!this.isActive(active)) return;
      const previousLeafId = getOmpState(this.providerState).leafEntryId ?? null;
      const compactInstructions = getCompactInstructions(encoded.prompt);
      if (compactInstructions !== null) {
        active.nativeRequestDispatched = true;
        await this.kernel.request(
          'compact',
          { customInstructions: compactInstructions },
          undefined,
          active.abortController.signal,
        );
        this.ensureAccepted(active);
        this.emitRequested(active, { type: 'context_compacted' });
      } else {
        active.nativeRequestDispatched = true;
        const promptRequest = this.kernel.request(
          'prompt',
          {
            ...(encoded.images.length > 0 ? { images: encoded.images } : {}),
            message: encoded.prompt,
          },
          undefined,
          active.abortController.signal,
        );
        await promptRequest;
        this.ensureAccepted(active);
        await active.terminalSignal.promise;
      }
      if (!this.isActive(active)) return;

      await this.refreshState(active.abortController.signal);
      if (!this.isActive(active)) return;
      await this.refreshNativeMessageIds(active, previousLeafId);
      const usage = await this.fetchUsage(
        encoded.model,
        active.abortController.signal,
      ).catch(() => null);
      if (usage) {
        this.emitRequested(active, {
          type: 'usage_updated',
          usage,
        });
      }
      this.setStatus('idle');
      this.emitRequestedState(active);
      this.finishRequested(active, {
        nativeAssistantId: active.nativeAssistantId,
        nativeCheckpointId: getOmpState(this.providerState).leafEntryId,
        reason: 'completed',
        type: 'turn_completed',
      });
    } catch (error) {
      if (error instanceof OmpForkRollbackError) {
        this.lifecycleError ??= error;
        if (!active.terminal) {
          this.invalidateForForkRollback(error);
          this.emitRequestedState(active);
          this.finishRequested(active, {
            category: 'provider',
            message: error.message,
            recoverable: false,
            type: 'execution_error',
          });
        } else if (!this.disposed) {
          if (this.invalidateForForkRollback(error)) {
            this.emitSession({
              snapshot: this.getSnapshot(),
              type: 'session_state_changed',
            });
          }
          this.emitSession({
            category: 'provider',
            message: error.message,
            recoverable: false,
            type: 'session_error',
          });
        }
        throw error;
      }
      if (!active.terminal) {
        this.finishError(active, error);
      }
    }
  }

  private async encodeRequest(
    active: ActiveRun,
    request: ProviderExecutionRequest,
  ): Promise<EncodedOmpRequest> {
    const settings = getOmpProviderSettings(this.host.settings);
    if (!settings.enabled) {
      throw new OmpConfigurationError('OMP is disabled.');
    }
    const model = resolveSelectedModel(request, settings, this.host.settings);
    const thinkingLevel = resolveThinkingLevel(
      request,
      settings,
      model,
      this.host.settings,
    );
    await this.materializePendingFork(active);
    const envText = getRuntimeEnvironmentText(this.host.settings, 'omp');
    const env = {
      ...process.env,
      ...parseEnvironmentVariables(envText),
    };
    this.validateResumeSeed(env);
    const toolProfile = resolveToolProfile(request.toolPolicy, settings);
    const launchSpec = buildOmpLaunchSpec({
      command: await this.host.getResolvedProviderCliPath('omp') ?? 'omp',
      cwd: this.config.vaultWorkingDirectory,
      env,
      envText,
      noSession: this.shouldDisableNativePersistence(),
      noTools: toolProfile.noTools,
      tools: toolProfile.tools,
      providerState: getOmpState(this.providerState),
      settings: {
        ...settings,
        toolMode: toolProfile.toolMode,
      },
      systemPrompt: resolveSystemPrompt(
        request,
        this.host.settings,
        this.config.vaultWorkingDirectory,
      ),
    });
    const state = getOmpState(this.providerState);
    const hasNativeSession = Boolean(state.sessionId || state.sessionFile);
    const hasAcceptedCompatibleLiveContext = Boolean(
      this.nativeConversationContextEstablished
      && !hasNativeSession
      && this.canReuseKernel(launchSpec),
    );
    const prompt = encodePrompt(
      request,
      !hasNativeSession && !hasAcceptedCompatibleLiveContext,
    );
    return {
      images: prompt.images,
      launchSpec,
      model,
      prompt: prompt.text,
      thinkingLevel,
    };
  }

  private validateResumeSeed(environment: NodeJS.ProcessEnv): void {
    if (!this.resumeSeedNeedsValidation) return;
    this.resumeSeedNeedsValidation = false;
    const state = getOmpState(this.providerState);
    const currentTarget = state.sessionFile ?? state.sessionId;
    if (!currentTarget) return;

    const resolvedSessionFile = resolveOmpSessionFileHint(
      state.sessionFile,
      state.sessionId,
      this.config.vaultWorkingDirectory,
      { environment },
    );
    if (resolvedSessionFile) {
      let changed = false;
      if (resolvedSessionFile !== state.sessionFile) {
        this.setProviderStateValue('sessionFile', resolvedSessionFile);
        changed = true;
      }
      if (isOmpSessionPathReference(state.sessionId)) {
        this.deleteProviderStateValue('sessionId');
        if (this.providerSessionId === state.sessionId) {
          this.providerSessionId = null;
        }
        changed = true;
      }
      if (changed) this.bumpRevision();
      return;
    }

    const pathTarget = state.sessionFile
      ?? (isOmpSessionPathReference(state.sessionId) ? state.sessionId : null);
    if (pathTarget) {
      const fallbackSessionId = state.sessionId
        && !isOmpSessionPathReference(state.sessionId)
        ? state.sessionId
        : null;
      if (fallbackSessionId) {
        if (state.sessionFile === pathTarget) {
          this.deleteProviderStateValue('sessionFile');
        }
        if (this.providerSessionId === pathTarget) {
          this.providerSessionId = fallbackSessionId;
        }
        this.bumpRevision();
        return;
      }
      this.nativeConversationContextEstablished = false;
      throw new OmpProviderSessionMissingError(pathTarget);
    }
  }

  private async ensureKernel(
    launchSpec: OmpLaunchSpec,
    active: ActiveRun,
  ): Promise<void> {
    await this.shutdownPromise;
    if (!this.isActive(active) || active.abortController.signal.aborted) {
      return;
    }
    if (
      this.canReuseKernel(launchSpec)
    ) {
      return;
    }
    await this.shutdownKernel();
    if (!this.isActive(active) || active.abortController.signal.aborted) {
      return;
    }
    const generation = ++this.kernelGeneration;
    const kernel = this.options.createKernel(
      launchSpec,
      {
        onClose: error => this.handleKernelClose(kernel, generation, error),
        onEvent: event => this.handleRpcEvent(kernel, generation, event),
        onExtensionChunk: chunk =>
          this.handleStreamChunk(kernel, generation, chunk),
        onExtensionRequest: () => {
          const currentActive = this.activeRun;
          if (
            !this.isCurrentKernel(kernel, generation)
            || !currentActive
            || this.kernelResumeValidationTarget !== null
          ) return false;
          this.ensureAccepted(currentActive);
          return true;
        },
      },
      this.config.lifecycle === 'persistent'
        ? this.options.extensionUiRenderer
        : null,
    );
    if (!this.isActive(active) || active.abortController.signal.aborted) {
      await kernel.shutdown().catch(() => undefined);
      return;
    }
    this.kernel = kernel;
    this.processKey = launchSpec.processKey;
    this.kernelResumeValidationTarget = launchSpec.sessionTarget;
    this.replaceKernelSessionTargets(launchSpec.sessionTarget);
    if (
      !this.isActive(active)
      || active.abortController.signal.aborted
      || !this.isCurrentKernel(kernel, generation)
    ) {
      await this.shutdownAcquiredKernel(kernel, generation);
      return;
    }
    try {
      kernel.start();
    } catch (error) {
      await this.shutdownAcquiredKernel(kernel, generation);
      throw error;
    }
    if (
      !this.isActive(active)
      || active.abortController.signal.aborted
      || !this.isCurrentKernel(kernel, generation)
    ) {
      await this.shutdownAcquiredKernel(kernel, generation);
      return;
    }
    void this.publishCommands(kernel, generation);
  }

  private async validateKernelResume(signal: AbortSignal): Promise<void> {
    const expectedTarget = this.kernelResumeValidationTarget;
    const kernel = this.kernel;
    if (!expectedTarget || !kernel) return;

    const response = await kernel.request<unknown>(
      'get_state',
      {},
      10_000,
      signal,
    );
    if (
      this.kernel !== kernel
      || this.kernelResumeValidationTarget !== expectedTarget
    ) return;
    const reportedIdentity = extractReportedOmpSessionIdentity(response);
    if (matchesExpectedOmpSession(
      expectedTarget,
      getOmpState(this.providerState),
      reportedIdentity,
    )) {
      this.kernelResumeValidationTarget = null;
      return;
    }

    const error = new OmpProviderSessionMismatchError(
      expectedTarget,
      reportedIdentity.sessionFile ?? reportedIdentity.sessionId,
    );
    await this.shutdownKernel().catch(() => undefined);
    throw error;
  }

  private async applyModelConfiguration(
    encoded: EncodedOmpRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const modelPayload = buildOmpSetModelPayload(encoded.model);
    if (!modelPayload || !this.kernel) {
      throw new OmpConfigurationError('The selected Omp model is invalid.');
    }
    await this.kernel.request('set_model', modelPayload, undefined, signal);
    if (encoded.thinkingLevel) {
      await this.kernel.request(
        'set_thinking_level',
        { level: encoded.thinkingLevel },
        undefined,
        signal,
      );
    }
  }

  private handleRpcEvent(
    kernel: OmpExecutionKernel,
    generation: number,
    event: JsonlRpcRecord,
  ): void {
    if (!this.isCurrentKernel(kernel, generation)) return;
    const active = this.activeRun;
    if (!active || active.terminal) return;
    if (event.type === 'extension_ui_request') {
      const id = getString(event.id);
      if (id) {
        kernel.send({
          cancelled: true,
          id,
          type: 'extension_ui_response',
        });
      }
      return;
    }
    if (event.type === 'agent_start') {
      this.ensureAccepted(active);
      return;
    }
    if (event.type === 'agent_end') {
      this.ensureAccepted(active);
      if (event.willRetry === true) {
        active.pendingTerminalError = null;
        return;
      }
      const pendingTerminalError = active.pendingTerminalError;
      active.pendingTerminalError = null;
      if (pendingTerminalError) {
        active.terminalSignal.reject(pendingTerminalError);
        return;
      }
      active.terminalSignal.resolve();
      return;
    }
    if (event.type === 'error') {
      active.terminalSignal.reject(new Error(
        getString(event.error) ?? 'OMP runtime error.',
      ));
      return;
    }

    const terminalError = getOmpTerminalErrorMessage(event);
    if (terminalError) {
      this.ensureAccepted(active);
      active.pendingTerminalError = new Error(terminalError);
      return;
    }

    const chunks = normalizeOmpRpcEvent(event, this.normalizationState);
    if (chunks.length > 0) this.ensureAccepted(active);
    for (const chunk of chunks) {
      this.handleStreamChunk(kernel, generation, chunk);
    }
  }

  private handleStreamChunk(
    kernel: OmpExecutionKernel,
    generation: number,
    chunk: StreamChunk,
  ): void {
    if (!this.isCurrentKernel(kernel, generation)) return;
    const active = this.activeRun;
    if (!active || active.terminal) return;
    if (chunk.type === 'done') return;
    if (chunk.type === 'error') {
      active.terminalSignal.reject(new Error(chunk.content));
      return;
    }
    this.ensureAccepted(active);
    if (isAssistantChunk(chunk) && !active.assistantStarted) {
      active.assistantStarted = true;
      this.emitRequested(active, { type: 'assistant_message_started' });
    }
    switch (chunk.type) {
      case 'user_message_start':
        this.emitRequested(active, {
          content: chunk.content,
          nativeUserMessageId: chunk.itemId,
          type: 'user_message_started',
        });
        break;
      case 'assistant_message_start':
        active.assistantStarted = true;
        active.nativeAssistantId = chunk.itemId;
        this.emitRequested(active, {
          nativeAssistantId: chunk.itemId,
          type: 'assistant_message_started',
        });
        break;
      case 'text':
        this.emitRequested(active, { text: chunk.content, type: 'text_delta' });
        break;
      case 'thinking':
        this.emitRequested(active, {
          text: chunk.content,
          type: 'thinking_delta',
        });
        break;
      case 'citations':
        this.emitRequested(active, {
          citations: chunk.citations,
          type: 'citations',
        });
        break;
      case 'tool_use':
      case 'subagent_tool_use':
        this.emitRequested(active, {
          input: chunk.input,
          name: chunk.name,
          toolCallId: chunk.id,
          toolScope: { kind: 'main' },
          type: 'tool_started',
        });
        break;
      case 'tool_output':
        this.emitRequested(active, {
          content: chunk.content,
          toolCallId: chunk.id,
          toolScope: { kind: 'main' },
          type: 'tool_output',
        });
        break;
      case 'tool_result':
      case 'subagent_tool_result':
        this.emitRequested(active, {
          content: chunk.content,
          isError: chunk.isError,
          isBlocked: chunk.isBlocked,
          toolCallId: chunk.id,
          toolScope: { kind: 'main' },
          toolUseResult: chunk.toolUseResult,
          type: 'tool_completed',
        });
        break;
      case 'usage':
        this.emitRequested(active, {
          type: 'usage_updated',
          usage: chunk.usage,
        });
        break;
      case 'context_compacted':
        this.emitRequested(active, { type: 'context_compacted' });
        break;
      case 'notice':
        this.emitRequested(active, {
          level: chunk.level,
          message: chunk.content,
          type: 'notice',
        });
        break;
    }
  }

  private handleKernelClose(
    kernel: OmpExecutionKernel,
    generation: number,
    error?: Error,
  ): void {
    if (!this.isCurrentKernel(kernel, generation) || this.disposed) return;
    const missingProviderSessionId = getOmpMissingSessionTarget(
      kernel.launchSpec,
      kernel.getStderrSnapshot(),
    );
    this.kernel = null;
    this.processKey = null;
    this.kernelResumeValidationTarget = null;
    this.kernelSessionTargets.clear();
    if (!this.hasNativeSessionState()) {
      this.nativeConversationContextEstablished = false;
    }
    const active = this.activeRun;
    if (active && !active.terminal) {
      const runError = active.pendingTerminalError
        ?? error
        ?? new Error('OMP subprocess exited.');
      active.pendingTerminalError = null;
      active.terminalSignal.reject(runError);
      this.finishError(
        active,
        runError,
        missingProviderSessionId
          ? 'provider-session-missing'
          : 'process-exited',
        missingProviderSessionId ?? undefined,
      );
    } else {
      this.setInvalidated({
        message: error?.message ?? 'OMP subprocess exited.',
        reason: 'process-exited',
        recoverable: true,
      });
      this.emitSession({
        snapshot: this.getSnapshot(),
        type: 'session_state_changed',
      });
      this.emitSession({
        category: 'process-exited',
        message: error?.message ?? 'OMP subprocess exited.',
        recoverable: true,
        type: 'session_error',
      });
    }
    const shutdown = kernel.shutdown()
      .catch(() => undefined)
      .finally(() => {
        if (this.shutdownPromise === shutdown) {
          this.shutdownPromise = null;
        }
      });
    this.shutdownPromise = shutdown;
  }

  private ensureAccepted(active: ActiveRun): void {
    if (!this.isActive(active) || !active.nativeRequestDispatched) return;
    this.nativeConversationContextEstablished = true;
    if (active.accepted) return;
    active.accepted = true;
    this.emitRequested(active, {
      accepted: true,
      nativeUserMessageId: active.nativeUserMessageId,
      type: 'turn_started',
    });
    this.emitRequested(active, {
      content: active.inputText,
      nativeUserMessageId: active.nativeUserMessageId,
      type: 'user_message_started',
    });
  }

  private async refreshState(signal: AbortSignal): Promise<void> {
    if (!this.kernel) throw new Error('OMP execution kernel is unavailable.');
    const response = await this.kernel.request<unknown>(
      'get_state',
      {},
      10_000,
      signal,
    );
    if (this.shouldDisableNativePersistence()) {
      this.providerSessionId = null;
      this.removeNativeProviderState();
      this.kernelSessionTargets.clear();
      this.bumpRevision();
      return;
    }
    const state = extractStateRecord(response);
    const sessionId = getString(state.sessionId)
      ?? getString(state.session_id)
      ?? getString(getRecord(state.session).id)
      ?? getOmpState(this.providerState).sessionId;
    const sessionFile = getString(state.sessionFile)
      ?? getString(state.session_file)
      ?? getString(state.sessionPath)
      ?? getString(state.session_path)
      ?? getString(state.path)
      ?? getOmpState(this.providerState).sessionFile;
    const leafEntryId = getString(state.leafEntryId)
      ?? getString(state.leaf_entry_id)
      ?? getOmpState(this.providerState).leafEntryId;
    const parentSession = getString(state.parentSession)
      ?? getString(state.parent_session)
      ?? getOmpState(this.providerState).parentSession;
    this.providerSessionId = sessionId ?? null;
    this.setOptionalProviderStateValue('sessionId', sessionId);
    this.setOptionalProviderStateValue('sessionFile', sessionFile);
    this.setOptionalProviderStateValue('leafEntryId', leafEntryId);
    this.setOptionalProviderStateValue('parentSession', parentSession);
    this.replaceKernelSessionTargets(sessionFile, sessionId);
    this.deleteProviderStateValue('forkSource');
    this.deleteProviderStateValue('forkSourceSessionFile');
    this.bumpRevision();
  }

  private async refreshNativeMessageIds(
    active: ActiveRun,
    previousLeafId: string | null,
  ): Promise<void> {
    const sessionFile = getOmpState(this.providerState).sessionFile;
    if (!sessionFile) return;
    try {
      const parsed = parseOmpSessionEntries(await fsp.readFile(sessionFile, 'utf8'));
      const path = resolveOmpActivePath(
        parsed.entries,
        getOmpState(this.providerState).leafEntryId,
      );
      const previousIndex = previousLeafId
        ? path.findIndex(entry => entry.id === previousLeafId)
        : -1;
      const entries = previousIndex >= 0 ? path.slice(previousIndex + 1) : path;
      active.nativeUserMessageId = findLastRoleId(entries, 'user') ?? undefined;
      active.nativeAssistantId =
        findLastRoleId(entries, 'assistant')
        ?? getOmpState(this.providerState).leafEntryId;
    } catch {
      active.nativeAssistantId = getOmpState(this.providerState).leafEntryId;
    }
  }

  private async fetchUsage(model: string, signal: AbortSignal) {
    if (!this.kernel) return null;
    const settings = getOmpProviderSettings(this.host.settings);
    const contextWindow = findOmpModel(settings, model)?.contextWindow;
    const response = await this.kernel.request(
      'get_session_stats',
      {},
      10_000,
      signal,
    );
    return buildOmpUsageInfo(response, model, contextWindow);
  }

  private async publishCommands(
    kernel: OmpExecutionKernel,
    generation: number,
  ): Promise<void> {
    try {
      const response = await kernel.request<unknown>('get_available_commands', {}, 10_000);
      if (!this.isCurrentKernel(kernel, generation) || this.disposed) return;
      this.services.commandCatalog.setCommandSnapshot(
        normalizeOmpRuntimeCommands(response),
      );
    } catch {
      // Command metadata is non-blocking; the provider-owned probe can retry.
    }
  }

  private async materializePendingFork(active: ActiveRun): Promise<void> {
    while (this.forkMaterializationFlight) {
      const priorFlight = this.forkMaterializationFlight;
      try {
        await priorFlight;
      } catch (error) {
        if (error instanceof OmpForkRollbackError) throw error;
      }
      if (this.forkMaterializationFlight === priorFlight) {
        this.forkMaterializationFlight = null;
      }
      if (!this.isActive(active) || active.abortController.signal.aborted) {
        throw new OmpExecutionCancelledError();
      }
    }
    const flight = this.materializePendingForkForRun(active);
    this.forkMaterializationFlight = flight;
    try {
      await flight;
    } finally {
      if (this.forkMaterializationFlight === flight) {
        this.forkMaterializationFlight = null;
      }
    }
    if (!this.isActive(active) || active.abortController.signal.aborted) {
      throw new OmpExecutionCancelledError();
    }
  }

  private async materializePendingForkForRun(active: ActiveRun): Promise<void> {
    if (this.shouldDisableNativePersistence()) return;
    const state = getOmpState(this.providerState);
    const forkSource = state.forkSource;
    if (!forkSource) return;
    const envText = getRuntimeEnvironmentText(this.host.settings, 'omp');
    const env = parseEnvironmentVariables(envText);
    const sourceFile = state.forkSourceSessionFile
      ?? findOmpSessionFile(
        forkSource.sessionId,
        this.config.vaultWorkingDirectory,
        getString(env.PI_CODING_AGENT_SESSION_DIR),
      );
    if (!sourceFile) {
      throw new Error(`OMP fork source session not found: ${forkSource.sessionId}`);
    }
    const fork = await this.options.createForkSessionFile(
      sourceFile,
      forkSource.resumeAt,
      { targetCwd: this.config.vaultWorkingDirectory },
    );
    if (isSamePath(fork.sessionFile, sourceFile)) {
      throw new Error('OMP fork materialization returned the source session as its target.');
    }
    if (!this.isActive(active) || active.abortController.signal.aborted) {
      await this.rollbackCreatedFork(fork);
      return;
    }
    this.setProviderStateValue('leafEntryId', fork.leafEntryId);
    this.setProviderStateValue('parentSession', fork.parentSession);
    this.setProviderStateValue('sessionFile', fork.sessionFile);
    this.setProviderStateValue('sessionId', fork.sessionId);
    this.deleteProviderStateValue('forkSource');
    this.deleteProviderStateValue('forkSourceSessionFile');
    this.providerSessionId = fork.sessionId;
    this.bumpRevision();
  }

  private async rollbackCreatedFork(
    fork: CreatedOmpForkSessionFile,
  ): Promise<void> {
    try {
      await this.options.rollbackForkSessionFile(fork);
    } catch (error) {
      throw new OmpForkRollbackError(toError(error));
    }
  }

  private invalidateForForkRollback(error: OmpForkRollbackError): boolean {
    if (
      this.disposed
      || (
        this.status === 'invalidated'
        && this.snapshotInvalidation?.message === error.message
        && this.snapshotInvalidation.recoverable === false
      )
    ) return false;
    this.setInvalidated({
      message: error.message,
      reason: 'provider-error',
      recoverable: false,
    });
    return true;
  }

  private shouldDisableNativePersistence(): boolean {
    return this.config.lifecycle === 'ephemeral'
      || this.config.nativePersistence === 'disabled-if-supported';
  }

  private finishError(
    active: ActiveRun,
    error: unknown,
    category?: ProviderExecutionErrorCategory,
    missingProviderSessionId?: string,
  ): void {
    if (active.terminal) return;
    active.terminalSignal.reject(
      error instanceof Error ? error : new Error('OMP execution failed.'),
    );
    const confirmedMissingProviderSessionId = missingProviderSessionId
      ?? (error instanceof OmpProviderSessionMissingError
        ? error.providerSessionId
        : undefined);
    const details = classifyError(
      error,
      category ?? (confirmedMissingProviderSessionId
        ? 'provider-session-missing'
        : undefined),
      this.kernel?.getStderrSnapshot(),
    );
    if (details.category === 'configuration') {
      this.setStatus('idle');
    } else {
      this.setInvalidated({
        message: details.message,
        reason: details.category === 'process-exited'
          ? 'process-exited'
          : details.category === 'provider-session-missing'
            ? 'provider-session-missing'
          : details.category === 'transport'
            ? 'transport-closed'
            : 'provider-error',
        recoverable: details.recoverable,
      });
    }
    this.emitRequestedState(active);
    this.finishRequested(active, {
      ...details,
      ...(confirmedMissingProviderSessionId
        ? { missingProviderSessionId: confirmedMissingProviderSessionId }
        : {}),
      type: 'execution_error',
    });
  }

  private finishRequested(
    active: ActiveRun,
    event: WithoutScope<ProviderExecutionEvent>,
  ): void {
    if (active.terminal) return;
    this.emitRequested(active, event);
    active.terminal = true;
    active.requestSignal.removeEventListener(
      'abort',
      active.onRequestAbort,
    );
    active.events.close();
    if (this.activeRun === active) this.activeRun = null;
  }

  private emitRequested(
    active: ActiveRun,
    event: WithoutScope<ProviderExecutionEvent>,
  ): void {
    if (active.terminal) return;
    active.events.push({
      ...event,
      scope: this.nextRequestedScope(active),
    });
  }

  private emitRequestedState(active: ActiveRun): void {
    this.emitRequested(active, {
      snapshot: this.getSnapshot(),
      type: 'session_state_changed',
    });
  }

  private emitSession(event: WithoutScope<ProviderSessionEvent>): void {
    const scoped = {
      ...event,
      scope: this.nextSessionScope(),
    } as ProviderSessionEvent;
    for (const listener of this.sessionListeners) {
      try {
        listener(scoped);
      } catch {
        // Session listeners cannot affect process ownership.
      }
    }
  }

  private nextRequestedScope(active: ActiveRun): ProviderRequestedEventScope {
    return Object.freeze({
      executionId: active.executionId,
      kind: 'requested',
      sequence: ++active.sequence,
      sessionInstanceId: this.sessionInstanceId,
      turnId: active.turnId,
    });
  }

  private nextSessionScope(): ProviderSessionEventScope {
    return Object.freeze({
      kind: 'session',
      sequence: ++this.sessionSequence,
      sessionInstanceId: this.sessionInstanceId,
    });
  }

  private isActive(active: ActiveRun): boolean {
    return !this.disposed
      && this.activeRun === active
      && !active.terminal;
  }

  private isCurrentKernel(
    kernel: OmpExecutionKernel,
    generation: number,
  ): boolean {
    return this.kernel === kernel
      && this.kernelGeneration === generation
      && !this.disposed;
  }

  private canReuseKernel(launchSpec: OmpLaunchSpec): boolean {
    if (!this.kernel || this.processKey !== launchSpec.processKey) return false;
    return launchSpec.sessionTarget
      ? this.kernelSessionTargets.has(launchSpec.sessionTarget)
      : this.kernelSessionTargets.size === 0;
  }

  private replaceKernelSessionTargets(
    ...targets: Array<string | null | undefined>
  ): void {
    this.kernelSessionTargets.clear();
    for (const target of targets) {
      if (target) this.kernelSessionTargets.add(target);
    }
  }

  private shutdownKernel(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const kernel = this.kernel;
    this.kernel = null;
    this.processKey = null;
    this.kernelResumeValidationTarget = null;
    this.kernelSessionTargets.clear();
    this.kernelGeneration += 1;
    if (!this.hasNativeSessionState()) {
      this.nativeConversationContextEstablished = false;
    }
    if (!kernel) return Promise.resolve();
    const shutdown = kernel.shutdown().finally(() => {
      if (this.shutdownPromise === shutdown) {
        this.shutdownPromise = null;
      }
    });
    this.shutdownPromise = shutdown;
    return shutdown;
  }

  private hasNativeSessionState(): boolean {
    const state = getOmpState(this.providerState);
    return Boolean(state.sessionId || state.sessionFile);
  }

  private async shutdownAcquiredKernel(
    kernel: OmpExecutionKernel,
    generation: number,
  ): Promise<void> {
    if (this.kernel === kernel && this.kernelGeneration === generation) {
      await this.shutdownKernel().catch(() => undefined);
      return;
    }
    if (this.shutdownPromise) {
      await this.shutdownPromise.catch(() => undefined);
      return;
    }
    await kernel.shutdown().catch(() => undefined);
  }

  private setStatus(status: Exclude<ProviderSessionStatus, 'invalidated'>): void {
    this.status = status;
    this.snapshotInvalidation = null;
    this.bumpRevision();
  }

  private setInvalidated(invalidation: ProviderSessionInvalidation): void {
    this.status = 'invalidated';
    this.snapshotInvalidation = invalidation;
    this.bumpRevision();
  }

  private setProviderStateValue(
    key: keyof OmpProviderState,
    value: unknown,
  ): void {
    this.providerState[key] = value;
    this.providerStateDeletes.delete(key);
  }

  private setOptionalProviderStateValue(
    key: keyof OmpProviderState,
    value: string | undefined,
  ): void {
    if (value) this.setProviderStateValue(key, value);
  }

  private deleteProviderStateValue(key: keyof OmpProviderState): void {
    const hadValue = Object.prototype.hasOwnProperty.call(this.providerState, key);
    delete this.providerState[key];
    if (hadValue) this.providerStateDeletes.add(key);
  }

  private removeNativeProviderState(): void {
    for (const key of OMP_NATIVE_PROVIDER_STATE_KEYS) {
      this.deleteProviderStateValue(key);
    }
  }

  private bumpRevision(): void {
    this.revision += 1;
  }
}

type WithoutScope<T> = T extends unknown ? Omit<T, 'scope'> : never;

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private closed = false;
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];

  constructor(private readonly onEarlyReturn: () => void) {}

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<T>> {
    if (!this.closed) this.onEarlyReturn();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }
}

class OmpConfigurationError extends Error {}

class OmpExecutionCancelledError extends Error {}

class OmpProviderSessionMissingError extends Error {
  constructor(readonly providerSessionId: string) {
    super(`OMP session is unavailable: ${providerSessionId}`);
    this.name = 'OmpProviderSessionMissingError';
  }
}

class OmpProviderSessionMismatchError extends Error {
  constructor(expected: string, reported: string | null) {
    super(
      `OMP resumed an unexpected native session. Expected ${expected}, received ${reported ?? 'no session identity'}. The original conversation session was preserved.`,
    );
    this.name = 'OmpProviderSessionMismatchError';
  }
}

class OmpForkRollbackError extends Error {
  constructor(readonly cleanupError: Error) {
    super(cleanupError.message);
    this.name = 'OmpForkRollbackError';
  }
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    resolve(value?: T) {
      if (settled) return;
      settled = true;
      resolvePromise(value as T);
    },
  };
}

function resolveSelectedModel(
  request: ProviderExecutionRequest,
  settings: OmpProviderSettings,
  hostSettings: Record<string, unknown>,
): string {
  const model = request.configuration.model
    ?? getString(hostSettings.model);
  if (
    !model
    || !decodeOmpModelId(model)
    || !settings.visibleModels.includes(model)
  ) {
    throw new OmpConfigurationError(
      'No Omp model is selected. Enable a discovered model in Claudian settings.',
    );
  }
  return model;
}

function resolveThinkingLevel(
  request: ProviderExecutionRequest,
  settings: OmpProviderSettings,
  model: string,
  hostSettings: Record<string, unknown>,
): string | null {
  const requested = request.configuration.reasoning
    ?? getString(hostSettings.effortLevel)
    ?? settings.preferredThinkingByModel[model];
  const discovered = findOmpModel(settings, model);
  return discovered
    ? clampOmpThinkingLevel(requested, discovered.thinkingLevels)
    : requested ?? null;
}

function resolveToolProfile(
  policy: ProviderToolPolicy,
  settings: OmpProviderSettings,
): {
  noTools: boolean;
  toolMode: OmpProviderSettings['toolMode'];
  tools?: readonly string[];
} {
  if (policy.kind === 'passive') {
    return { noTools: true, toolMode: settings.toolMode };
  }
  if (policy.kind === 'read-only') {
    return { noTools: false, toolMode: 'readonly' };
  }
  if (policy.kind === 'allow-list') {
    return {
      noTools: policy.names.length === 0,
      toolMode: settings.toolMode,
      tools: policy.names,
    };
  }
  return {
    noTools: false,
    toolMode: policy.kind === 'unrestricted' ? 'all' : settings.toolMode,
  };
}

function resolveSystemPrompt(
  request: ProviderExecutionRequest,
  settings: Record<string, unknown>,
  vaultPath: string,
): string {
  if (request.configuration.systemInstructions.kind === 'explicit') {
    return request.configuration.systemInstructions.instructions;
  }
  return buildSystemPrompt({
    customPrompt: getString(settings.systemPrompt) ?? undefined,
    mediaFolder: getString(settings.mediaFolder) ?? undefined,
    userName: getString(settings.userName) ?? undefined,
    vaultPath,
  } satisfies SystemPromptSettings, {
    dynamicSections: request.configuration.systemInstructions.dynamicSections
      ? [...request.configuration.systemInstructions.dynamicSections]
      : undefined,
  });
}

function encodePrompt(
  request: ProviderExecutionRequest,
  replayConversationHistory: boolean,
): {
  images: OmpPromptImage[];
  text: string;
} {
  let text = getInputText(request);
  const context = request.context;
  if (context?.linkedContent?.path) {
    text = appendLinkedContent(text, context.linkedContent.path);
  }
  if (context?.editorSelection) {
    text = appendEditorContext(text, context.editorSelection);
  }
  if (context?.browserSelection) {
    text = appendBrowserContext(text, context.browserSelection);
  }
  if (context?.canvasSelection) {
    text = appendCanvasContext(text, context.canvasSelection);
  }
  if (replayConversationHistory && request.conversationHistory?.length) {
    const history = [...request.conversationHistory] as ChatMessage[];
    const historyContext = buildContextFromHistory(history);
    const recoveredPrompt = buildPromptWithHistoryContext(
      historyContext,
      text,
      text,
      history,
    );
    text = encodeOmpRecoveryPrompt(
      historyContext,
      recoveredPrompt === historyContext ? null : text,
    );
  }
  return {
    images: request.input.flatMap((block): OmpPromptImage[] => {
      if (block.type !== 'image' || !block.image.data) return [];
      return [{
        data: block.image.data,
        mimeType: block.image.mediaType,
        type: 'image',
      }];
    }),
    text,
  };
}

function getInputText(request: ProviderExecutionRequest): string {
  return request.input
    .filter((block): block is { readonly type: 'text'; readonly text: string } =>
      block.type === 'text')
    .map(block => block.text)
    .join('\n\n');
}

function getCompactInstructions(prompt: string): string | null {
  if (!/^\/compact(?:\s|$)/i.test(prompt)) return null;
  return prompt.trim().replace(/^\/compact(?:\s|$)/i, '').trim();
}

function isAssistantChunk(chunk: StreamChunk): boolean {
  return chunk.type === 'text'
    || chunk.type === 'thinking'
    || chunk.type === 'citations'
    || chunk.type === 'tool_use'
    || chunk.type === 'subagent_tool_use';
}

function getFirstRejectedError(
  results: readonly PromiseSettledResult<void>[],
): Error | null {
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  return rejected ? toError(rejected.reason) : null;
}

function isSamePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function classifyError(
  error: unknown,
  category?: ProviderExecutionErrorCategory,
  stderr?: string,
): {
  category: ProviderExecutionErrorCategory;
  message: string;
  recoverable: boolean;
} {
  const baseMessage = error instanceof Error
    ? error.message
    : 'OMP execution failed.';
  const message = stderr?.trim()
    ? `${baseMessage}\n\n${stderr.trim()}`
    : baseMessage;
  const resolvedCategory = category
    ?? (error instanceof OmpConfigurationError
      ? 'configuration'
      : /closed|transport/i.test(baseMessage)
        ? 'transport'
        : 'provider');
  return {
    category: resolvedCategory,
    message,
    recoverable: resolvedCategory !== 'configuration',
  };
}

function getOmpMissingSessionTarget(
  launchSpec: OmpLaunchSpec,
  stderr: string,
): string | null {
  const sessionFlagIndex = launchSpec.args.indexOf('--session');
  const target = launchSpec.args[sessionFlagIndex + 1]?.trim();
  if (
    sessionFlagIndex < 0
    || !target
    || !stderr.includes(`No session found matching '${target}'`)
  ) {
    return null;
  }
  return target;
}

function extractStateRecord(response: unknown): Record<string, unknown> {
  const record = getRecord(response);
  return getRecord(record.state ?? record.session ?? response);
}

interface ReportedOmpSessionIdentity {
  readonly sessionFile: string | null;
  readonly sessionId: string | null;
}

function extractReportedOmpSessionIdentity(response: unknown): ReportedOmpSessionIdentity {
  const state = extractStateRecord(response);
  return {
    sessionFile: getString(state.sessionFile)
      ?? getString(state.session_file)
      ?? getString(state.sessionPath)
      ?? getString(state.session_path)
      ?? getString(state.path),
    sessionId: getString(state.sessionId)
      ?? getString(state.session_id)
      ?? getString(getRecord(state.session).id),
  };
}

function matchesExpectedOmpSession(
  expectedTarget: string,
  expectedState: OmpProviderState,
  reported: ReportedOmpSessionIdentity,
): boolean {
  const expectedFile = expectedState.sessionFile
    ?? (isOmpSessionPathReference(expectedState.sessionId)
      ? expectedState.sessionId
      : isOmpSessionPathReference(expectedTarget)
        ? expectedTarget
        : null);
  const expectedId = expectedState.sessionId
    && !isOmpSessionPathReference(expectedState.sessionId)
    ? expectedState.sessionId
    : !isOmpSessionPathReference(expectedTarget)
      ? expectedTarget
      : null;
  let compared = false;

  if (expectedFile && reported.sessionFile) {
    compared = true;
    if (!isSamePath(expectedFile, reported.sessionFile)) return false;
  }
  if (expectedId && reported.sessionId) {
    compared = true;
    if (expectedId !== reported.sessionId) return false;
  }
  return compared;
}

function findLastRoleId(
  entries: ReturnType<typeof resolveOmpActivePath>,
  role: string,
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (getString(entries[index].message?.role) === role) {
      return entries[index].id ?? null;
    }
  }
  return null;
}

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cloneRecord(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
