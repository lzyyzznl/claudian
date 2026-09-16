import type { JsonlRpcRecord, JsonlRpcTransport } from '@/core/rpc/JsonlRpcTransport';
import type { StreamChunk } from '@/core/types';

export interface OmpExtensionUiSelectRequest extends JsonlRpcRecord {
  id: string;
}

export interface OmpExtensionUiConfirmRequest extends JsonlRpcRecord {
  id: string;
}

export interface OmpExtensionUiInputRequest extends JsonlRpcRecord {
  id: string;
}

export interface OmpExtensionUiEditorRequest extends JsonlRpcRecord {
  id: string;
}

export type OmpExtensionUiNotifyRequest = JsonlRpcRecord;
export type OmpExtensionUiSetEditorTextRequest = JsonlRpcRecord;
export type OmpExtensionUiSetStatusRequest = JsonlRpcRecord;
export type OmpExtensionUiSetTitleRequest = JsonlRpcRecord;
export type OmpExtensionUiSetWidgetRequest = JsonlRpcRecord;

export interface OmpExtensionUiRenderer {
  confirm(request: OmpExtensionUiConfirmRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; confirmed?: boolean }>;
  editor(request: OmpExtensionUiEditorRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  input(request: OmpExtensionUiInputRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  notify(request: OmpExtensionUiNotifyRequest): void;
  select(request: OmpExtensionUiSelectRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  setEditorText(request: OmpExtensionUiSetEditorTextRequest): void;
  setStatus(request: OmpExtensionUiSetStatusRequest): void;
  setTitle(request: OmpExtensionUiSetTitleRequest): void;
  setWidget(request: OmpExtensionUiSetWidgetRequest): void;
}

export class OmpExtensionUiBridge {
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly transport: JsonlRpcTransport,
    private readonly renderer: OmpExtensionUiRenderer | null,
    private readonly emit?: (chunk: StreamChunk) => void,
    private readonly admitDialog: (request: JsonlRpcRecord) => boolean = () => true,
  ) {}

  handleRequest(request: JsonlRpcRecord): boolean {
    if (request.type !== 'extension_ui_request') {
      return false;
    }

    const method = getString(request.method) ?? getString(request.action) ?? getString(request.uiType);
    switch (method) {
      case 'select':
        this.handleDialog(request, (renderer, signal) =>
          renderer.select(requireDialogRequest(request), signal));
        return true;
      case 'confirm':
        this.handleDialog(request, (renderer, signal) =>
          renderer.confirm(requireDialogRequest(request), signal));
        return true;
      case 'input':
        this.handleDialog(request, (renderer, signal) =>
          renderer.input(requireDialogRequest(request), signal));
        return true;
      case 'editor':
        this.handleDialog(request, (renderer, signal) =>
          renderer.editor(requireDialogRequest(request), signal));
        return true;
      case 'notify':
        this.renderer?.notify(request);
        this.emit?.({
          type: 'notice',
          content: getString(request.message) ?? getString(request.title) ?? 'OMP extension notification.',
          level: 'info',
        });
        return true;
      case 'setStatus':
      case 'set_status':
        this.renderer?.setStatus(request);
        return true;
      case 'setWidget':
      case 'set_widget':
        this.renderer?.setWidget(request);
        return true;
      case 'setTitle':
      case 'set_title':
        this.renderer?.setTitle(request);
        return true;
      case 'setEditorText':
      case 'set_editor_text':
        this.renderer?.setEditorText(request);
        return true;
      case 'cancel':
        this.cancelDialog(request);
        return true;
      default:
        this.sendCancellation(request);
        return true;
    }
  }

  cleanup(): void {
    for (const [id, controller] of this.pending) {
      controller.abort();
      this.sendResponse(id, { cancelled: true });
    }
    this.pending.clear();
  }

  private handleDialog(
    request: JsonlRpcRecord,
    render: (
      renderer: OmpExtensionUiRenderer,
      signal: AbortSignal,
    ) => Promise<Record<string, unknown>>,
  ): void {
    const id = getString(request.id);
    if (!id || !this.renderer || !this.admitDialog(request)) {
      this.sendCancellation(request);
      return;
    }

    const controller = new AbortController();
    this.pending.set(id, controller);
    render(this.renderer, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          this.sendResponse(id, response.cancelled ? { cancelled: true } : response);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          this.sendResponse(id, { cancelled: true });
        }
      })
      .finally(() => {
        this.pending.delete(id);
      });
  }

  /**
   * omp emits `{ method: 'cancel', targetId }` when a dialog it already abandoned must be
   * dismissed. Abort the matching dialog so the host does not keep it open, then acknowledge
   * the cancel frame itself.
   */
  private cancelDialog(request: JsonlRpcRecord): void {
    const targetId = getString(request.targetId);
    const controller = targetId ? this.pending.get(targetId) : undefined;
    if (targetId && controller) {
      this.pending.delete(targetId);
      controller.abort();
      this.sendResponse(targetId, { cancelled: true });
    }
    this.sendCancellation(request);
  }

  private sendCancellation(request: JsonlRpcRecord): void {
    const id = getString(request.id);
    if (id) {
      this.sendResponse(id, { cancelled: true });
    }
  }

  private sendResponse(id: string, response: Record<string, unknown>): void {
    this.transport.send({
      id,
      type: 'extension_ui_response',
      ...response,
    });
  }
}

function requireDialogRequest<T extends JsonlRpcRecord & { id: string }>(request: JsonlRpcRecord): T {
  return request as T;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
