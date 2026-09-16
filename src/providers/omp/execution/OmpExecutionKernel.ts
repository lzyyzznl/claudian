import {
  type JsonlRpcRecord,
  JsonlRpcTransport,
} from '@/core/rpc/JsonlRpcTransport';

import type { StreamChunk } from '../../../core/types';
import {
  OmpExtensionUiBridge,
  type OmpExtensionUiRenderer,
} from '../runtime/OmpExtensionUiBridge';
import type { OmpLaunchSpec } from '../runtime/OmpLaunchSpec';
import { OmpSubprocess } from '../runtime/OmpSubprocess';

export interface OmpExecutionKernelCallbacks {
  onClose(error?: Error): void;
  onEvent(event: JsonlRpcRecord): void;
  onExtensionChunk(chunk: StreamChunk): void;
  onExtensionRequest(request: JsonlRpcRecord): boolean;
}

export interface OmpExecutionKernel {
  readonly launchSpec: OmpLaunchSpec;
  getStderrSnapshot(): string;
  request<T>(
    type: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
  send(record: JsonlRpcRecord): void;
  shutdown(): Promise<void>;
  start(): void;
}

export type OmpExecutionKernelFactory = (
  launchSpec: OmpLaunchSpec,
  callbacks: OmpExecutionKernelCallbacks,
  extensionUiRenderer: OmpExtensionUiRenderer | null,
) => OmpExecutionKernel;

export class OmpRpcSessionKernel implements OmpExecutionKernel {
  private readonly subprocess: OmpSubprocess;
  private transport: JsonlRpcTransport | null = null;
  private extensionBridge: OmpExtensionUiBridge | null = null;
  private removeCloseListener: (() => void) | null = null;
  private removeEventListener: (() => void) | null = null;
  private started = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    readonly launchSpec: OmpLaunchSpec,
    private readonly callbacks: OmpExecutionKernelCallbacks,
    extensionUiRenderer: OmpExtensionUiRenderer | null,
  ) {
    this.subprocess = new OmpSubprocess(launchSpec);
    this.extensionUiRenderer = extensionUiRenderer;
  }

  private readonly extensionUiRenderer: OmpExtensionUiRenderer | null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.subprocess.start();
    const transport = new JsonlRpcTransport({
      input: this.subprocess.stdout,
      onClose: listener => this.subprocess.onClose(listener),
      output: this.subprocess.stdin,
    });
    const extensionBridge = new OmpExtensionUiBridge(
      transport,
      this.extensionUiRenderer,
      chunk => this.callbacks.onExtensionChunk(chunk),
      request => this.callbacks.onExtensionRequest(request),
    );
    this.transport = transport;
    this.extensionBridge = extensionBridge;
    transport.start();
    this.removeEventListener = transport.onEvent((event) => {
      if (event.type === 'extension_ui_request') {
        extensionBridge.handleRequest(event);
        return;
      }
      this.callbacks.onEvent(event);
    });
    this.removeCloseListener = transport.onClose(error => {
      this.callbacks.onClose(error);
    });
  }

  getStderrSnapshot(): string {
    return this.subprocess.getStderrSnapshot();
  }

  request<T>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.requireTransport().request(type, payload, timeoutMs, signal);
  }

  send(record: JsonlRpcRecord): void {
    this.requireTransport().send(record);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    this.extensionBridge?.cleanup();
    this.removeEventListener?.();
    this.removeEventListener = null;
    this.removeCloseListener?.();
    this.removeCloseListener = null;
    this.transport?.dispose();
    this.transport = null;
    this.extensionBridge = null;
    await this.subprocess.shutdown();
  }

  private requireTransport(): JsonlRpcTransport {
    if (!this.transport) {
      throw new Error('OMP execution kernel is not started');
    }
    return this.transport;
  }
}

export const createOmpExecutionKernel: OmpExecutionKernelFactory = (
  launchSpec,
  callbacks,
  extensionUiRenderer,
) => new OmpRpcSessionKernel(
  launchSpec,
  callbacks,
  extensionUiRenderer,
);
