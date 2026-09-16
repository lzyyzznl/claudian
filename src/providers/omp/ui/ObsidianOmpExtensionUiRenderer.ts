import { type App, Modal, Notice } from 'obsidian';

import type {
  OmpExtensionUiConfirmRequest,
  OmpExtensionUiEditorRequest,
  OmpExtensionUiInputRequest,
  OmpExtensionUiNotifyRequest,
  OmpExtensionUiRenderer,
  OmpExtensionUiSelectRequest,
  OmpExtensionUiSetEditorTextRequest,
  OmpExtensionUiSetStatusRequest,
  OmpExtensionUiSetTitleRequest,
  OmpExtensionUiSetWidgetRequest,
} from './OmpExtensionUiRenderer';

export class ObsidianOmpExtensionUiRenderer implements OmpExtensionUiRenderer {
  constructor(private readonly app: App) {}

  async select(
    request: OmpExtensionUiSelectRequest,
    signal: AbortSignal,
  ): Promise<{ cancelled?: boolean; value?: string }> {
    return new OmpSelectModal(this.app, request, signal).openAndWait();
  }

  async confirm(
    request: OmpExtensionUiConfirmRequest,
    signal: AbortSignal,
  ): Promise<{ cancelled?: boolean; confirmed?: boolean }> {
    return new OmpConfirmModal(this.app, request, signal).openAndWait();
  }

  async input(
    request: OmpExtensionUiInputRequest,
    signal: AbortSignal,
  ): Promise<{ cancelled?: boolean; value?: string }> {
    return new OmpTextModal(this.app, request, signal, false).openAndWait();
  }

  async editor(
    request: OmpExtensionUiEditorRequest,
    signal: AbortSignal,
  ): Promise<{ cancelled?: boolean; value?: string }> {
    return new OmpTextModal(this.app, request, signal, true).openAndWait();
  }

  notify(request: OmpExtensionUiNotifyRequest): void {
    new Notice(getDisplayText(request));
  }

  setStatus(_request: OmpExtensionUiSetStatusRequest): void {}
  setWidget(_request: OmpExtensionUiSetWidgetRequest): void {}
  setTitle(_request: OmpExtensionUiSetTitleRequest): void {}
  setEditorText(_request: OmpExtensionUiSetEditorTextRequest): void {}
}

function getDisplayText(request: Record<string, unknown>): string {
  const message = typeof request.message === 'string' ? request.message.trim() : '';
  const title = typeof request.title === 'string' ? request.title.trim() : '';
  return message || title || 'OMP extension notification.';
}

function getTitle(request: Record<string, unknown>, fallback: string): string {
  return typeof request.title === 'string' && request.title.trim()
    ? request.title.trim()
    : fallback;
}

function getMessage(request: Record<string, unknown>): string {
  return typeof request.message === 'string' ? request.message.trim() : '';
}

interface OmpSelectOption {
  label: string;
  value: string;
}

function getSelectOptions(request: Record<string, unknown>): OmpSelectOption[] {
  const rawOptions = Array.isArray(request.options) ? request.options : [];
  return rawOptions.flatMap((option): OmpSelectOption[] => {
    if (typeof option === 'string' && option.trim()) {
      return [{ label: option.trim(), value: option.trim() }];
    }
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
      return [];
    }

    const record = option as Record<string, unknown>;
    const value = typeof record.value === 'string' ? record.value.trim() : '';
    const label = typeof record.label === 'string' && record.label.trim()
      ? record.label.trim()
      : value;
    return value ? [{ label, value }] : [];
  });
}

abstract class OmpExtensionModal<TResult extends Record<string, unknown>> extends Modal {
  private done = false;
  private resolve!: (result: TResult) => void;
  private readonly resultPromise = new Promise<TResult>((resolve) => {
    this.resolve = resolve;
  });

  constructor(
    app: App,
    protected readonly request: Record<string, unknown>,
    private readonly signal: AbortSignal,
  ) {
    super(app);
  }

  openAndWait(): Promise<TResult> {
    if (this.signal.aborted) {
      return Promise.resolve(this.cancelledResult());
    }

    const abortHandler = (): void => {
      this.finish(this.cancelledResult());
      this.close();
    };
    this.signal.addEventListener('abort', abortHandler, { once: true });
    void this.resultPromise.finally(() => {
      this.signal.removeEventListener('abort', abortHandler);
    });
    this.open();
    return this.resultPromise;
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass('claudian-omp-extension-modal');
    this.render();
  }

  override onClose(): void {
    this.finish(this.cancelledResult());
  }

  protected abstract cancelledResult(): TResult;
  protected abstract render(): void;

  protected finish(result: TResult): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.resolve(result);
  }

  protected renderHeader(fallbackTitle: string): void {
    this.contentEl.createEl('h2', { text: getTitle(this.request, fallbackTitle) });
    const message = getMessage(this.request);
    if (message) {
      this.contentEl.createEl('p', { text: message });
    }
  }
}

class OmpSelectModal extends OmpExtensionModal<{ cancelled?: boolean; value?: string }> {
  protected cancelledResult(): { cancelled: true } {
    return { cancelled: true };
  }

  protected render(): void {
    this.renderHeader('OMP extension');
    const options = getSelectOptions(this.request);
    const listEl = this.contentEl.createDiv({ cls: 'claudian-omp-extension-options' });
    for (const option of options) {
      const button = listEl.createEl('button', { text: option.label });
      button.addEventListener('click', () => {
        this.finish({ value: option.value });
        this.close();
      });
    }
    this.renderCancelButton();
  }

  private renderCancelButton(): void {
    const cancelButton = this.contentEl.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.finish({ cancelled: true });
      this.close();
    });
  }
}

class OmpConfirmModal extends OmpExtensionModal<{ cancelled?: boolean; confirmed?: boolean }> {
  protected cancelledResult(): { cancelled: true } {
    return { cancelled: true };
  }

  protected render(): void {
    this.renderHeader('OMP extension');
    const actionsEl = this.contentEl.createDiv({ cls: 'claudian-omp-extension-actions' });
    const confirmButton = actionsEl.createEl('button', { text: 'Confirm' });
    confirmButton.addEventListener('click', () => {
      this.finish({ confirmed: true });
      this.close();
    });
    const cancelButton = actionsEl.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.finish({ confirmed: false });
      this.close();
    });
  }
}

class OmpTextModal extends OmpExtensionModal<{ cancelled?: boolean; value?: string }> {
  constructor(
    app: App,
    request: Record<string, unknown>,
    signal: AbortSignal,
    private readonly multiline: boolean,
  ) {
    super(app, request, signal);
  }

  protected cancelledResult(): { cancelled: true } {
    return { cancelled: true };
  }

  protected render(): void {
    this.renderHeader('OMP extension');
    const initialValue = typeof this.request.value === 'string'
      ? this.request.value
      : typeof this.request.defaultValue === 'string'
      ? this.request.defaultValue
      : '';
    const input = this.multiline
      ? this.contentEl.createEl('textarea')
      : this.contentEl.createEl('input', { type: 'text' });
    input.value = initialValue;
    if (this.multiline) {
      (input as HTMLTextAreaElement).rows = 8;
    }

    const actionsEl = this.contentEl.createDiv({ cls: 'claudian-omp-extension-actions' });
    const submitButton = actionsEl.createEl('button', { text: 'Submit' });
    submitButton.addEventListener('click', () => {
      this.finish({ value: input.value });
      this.close();
    });
    const cancelButton = actionsEl.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.finish({ cancelled: true });
      this.close();
    });
    window.setTimeout(() => input.focus(), 0);
  }
}
