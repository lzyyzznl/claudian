import * as fs from 'node:fs';

import { createMockEl, type MockElement } from '@test/helpers/MockElement';
import { applyTextInput } from '@test/helpers/settingsControls';

const mockRenderEnvironmentSettingsSection = jest.fn();
const mockCliResolverReset = jest.fn();
const mockDiscoverModels = jest.fn();
const mockNotices: string[] = [];

jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    canApplyProviderEnablement: jest.fn(() => true),
    applyProviderEnablement: jest.fn((settings: Record<string, unknown>, providerId: string, enabled: boolean) => {
      const providerConfigs = settings.providerConfigs as Record<string, { enabled: boolean }>;
      providerConfigs[providerId].enabled = enabled;
      return true;
    }),
  },
}));

interface MockToggleComponent {
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  setValue: jest.Mock;
  value: boolean;
  onChange(callback: (value: boolean) => Promise<void> | void): MockToggleComponent;
}

interface MockTextComponent {
  inputEl: {
    [key: string]: unknown;
    addClass: jest.Mock;
    style: Record<string, string>;
    toggleClass: jest.Mock;
    value: string;
  };
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  setPlaceholder: jest.Mock;
  setValue: jest.Mock;
  value: string;
  onChange(callback: (value: string) => Promise<void> | void): MockTextComponent;
}

interface MockButtonComponent {
  disabled: boolean;
  onClickCallback: (() => Promise<void> | void) | null;
  setButtonText: jest.Mock;
  setDisabled: jest.Mock;
  text: string;
  onClick(callback: () => Promise<void> | void): MockButtonComponent;
}

interface MockDropdownComponent {
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  options: Record<string, string>;
  setValue: jest.Mock;
  value: string;
  addOption(value: string, label: string): MockDropdownComponent;
  onChange(callback: (value: string) => Promise<void> | void): MockDropdownComponent;
}

class MockSetting {
  buttonComponents: MockButtonComponent[] = [];
  desc = '';
  dropdownComponents: MockDropdownComponent[] = [];
  heading = false;
  name = '';
  settingEl = { addClass: jest.fn() };
  textComponents: MockTextComponent[] = [];
  toggleComponents: MockToggleComponent[] = [];

  constructor(_container: unknown) {
    createdSettings.push(this);
  }

  setName(name: string): this {
    this.name = name;
    return this;
  }

  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }

  setHeading(): this {
    this.heading = true;
    return this;
  }

  addToggle(callback: (toggle: MockToggleComponent) => void): this {
    const component = createToggleComponent();
    this.toggleComponents.push(component);
    callback(component);
    return this;
  }

  addText(callback: (text: MockTextComponent) => void): this {
    const component = createTextComponent();
    this.textComponents.push(component);
    callback(component);
    return this;
  }

  addButton(callback: (button: MockButtonComponent) => void): this {
    const component = createButtonComponent();
    this.buttonComponents.push(component);
    callback(component);
    return this;
  }

  addDropdown(callback: (dropdown: MockDropdownComponent) => void): this {
    const component = createDropdownComponent();
    this.dropdownComponents.push(component);
    callback(component);
    return this;
  }
}

jest.mock('node:fs');
jest.mock('obsidian', () => ({
  Notice: class MockNotice {
    constructor(message: string) {
      mockNotices.push(message);
    }
  },
  Setting: MockSetting,
}));
jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));
jest.mock('@/providers/omp/app/OmpWorkspaceServices', () => ({
  maybeGetOmpWorkspaceServices: jest.fn(() => ({
    cliResolver: {
      reset: mockCliResolverReset,
    },
  })),
}));
jest.mock('@/providers/omp/runtime/OmpModelDiscoveryService', () => ({
  OmpModelDiscoveryService: jest.fn().mockImplementation(() => ({
    discoverModels: mockDiscoverModels,
  })),
}));
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

import type { ProviderSettingsTabRendererContext } from '@/core/providers/types';
import { getOmpProviderSettings } from '@/providers/omp/settings';
import { ompSettingsTabRenderer } from '@/providers/omp/ui/OmpSettingsTab';

const createdSettings: MockSetting[] = [];
const createdDomElements: MockElement[] = [];
const mockedExists = fs.existsSync as jest.Mock;
const mockedStat = fs.statSync as jest.Mock;

function createToggleComponent(): MockToggleComponent {
  const component = {} as MockToggleComponent;
  component.onChangeCallback = null;
  component.value = false;
  component.setValue = jest.fn((value: boolean) => {
    component.value = value;
    return component;
  });
  component.onChange = (callback: (value: boolean) => Promise<void> | void): MockToggleComponent => {
    component.onChangeCallback = callback;
    return component;
  };
  return component;
}

function createTextComponent(): MockTextComponent {
  const component = {} as MockTextComponent;
  component.inputEl = {
    ...createMockEl('input'),
    addEventListener: jest.fn(),
    addClass: jest.fn(),
    style: {},
    toggleClass: jest.fn(),
    value: '',
  };
  component.onChangeCallback = null;
  component.value = '';
  component.setPlaceholder = jest.fn(() => component);
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    component.inputEl.value = value;
    return component;
  });
  component.onChange = (callback: (value: string) => Promise<void> | void): MockTextComponent => {
    component.onChangeCallback = callback;
    return component;
  };
  return component;
}

function createButtonComponent(): MockButtonComponent {
  const component = {} as MockButtonComponent;
  component.disabled = false;
  component.onClickCallback = null;
  component.text = '';
  component.setButtonText = jest.fn((value: string) => {
    component.text = value;
    return component;
  });
  component.setDisabled = jest.fn((value: boolean) => {
    component.disabled = value;
    return component;
  });
  component.onClick = (callback: () => Promise<void> | void): MockButtonComponent => {
    component.onClickCallback = callback;
    return component;
  };
  return component;
}

function createDropdownComponent(): MockDropdownComponent {
  const component = {} as MockDropdownComponent;
  component.onChangeCallback = null;
  component.options = {};
  component.value = '';
  component.addOption = (value: string, label: string): MockDropdownComponent => {
    component.options[value] = label;
    return component;
  };
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    return component;
  });
  component.onChange = (callback: (value: string) => Promise<void> | void): MockDropdownComponent => {
    component.onChangeCallback = callback;
    return component;
  };
  return component;
}

function createElement(): MockElement {
  const classes = new Set<string>();
  const eventListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const element: MockElement = {
    ...createMockEl('div'),
    checked: false,
    open: false,
    placeholder: '',
    style: {},
    title: '',
    value: '',
    classList: {
      add: jest.fn((cls: string) => classes.add(cls)),
      remove: jest.fn((cls: string) => classes.delete(cls)),
      toggle: jest.fn((cls: string, force?: boolean) => {
        if (force === undefined) {
          if (classes.has(cls)) {
            classes.delete(cls);
            return false;
          }
          classes.add(cls);
          return true;
        }
        if (force) {
          classes.add(cls);
        } else {
          classes.delete(cls);
        }
        return force;
      }),
      contains: jest.fn((cls: string) => classes.has(cls)),
    },
    addClass: jest.fn((cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((item) => classes.add(item));
    }),
    removeClass: jest.fn((cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((item) => classes.delete(item));
    }),
    toggleClass: jest.fn((cls: string, force: boolean) => {
      if (force) {
        classes.add(cls);
      } else {
        classes.delete(cls);
      }
    }),
    hasClass: jest.fn((cls: string) => classes.has(cls)),
    setText: jest.fn((value: string) => {
      element.text = value;
    }),
    empty: jest.fn(),
    setAttribute: jest.fn(),
    addEventListener: jest.fn((type: string, callback: (...args: unknown[]) => void) => {
      const listeners = eventListeners.get(type) ?? [];
      listeners.push(callback);
      eventListeners.set(type, listeners);
    }),
    dispatchMockEvent: async (type: string, event?: unknown) => {
      for (const listener of eventListeners.get(type) ?? []) {
        await listener(event);
      }
    },
    blur: jest.fn(),
    createEl: jest.fn((tag?: string, attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = tag;
      applyElementAttrs(child, attrs);
      createdDomElements.push(child);
      return child;
    }),
    createDiv: jest.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'div';
      applyElementAttrs(child, attrs);
      createdDomElements.push(child);
      return child;
    }),
    createSpan: jest.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'span';
      applyElementAttrs(child, attrs);
      createdDomElements.push(child);
      return child;
    }),
  };

  return element;
}

function applyElementAttrs(element: MockElement, attrs?: Record<string, unknown>): void {
  if (!attrs) {
    return;
  }
  if (typeof attrs.cls === 'string') {
    element.cls = attrs.cls;
  }
  if (typeof attrs.text === 'string') {
    element.text = attrs.text;
  }
  if (typeof attrs.value === 'string') {
    element.value = attrs.value;
  }
  if (typeof attrs.type === 'string') {
    element.type = attrs.type;
  }
}

function createContext(settings: Record<string, unknown>) {
  const saveSettings = jest.fn().mockResolvedValue(undefined);
  const runProviderExecutionTransition = jest.fn(async (
    _providerIds: string[],
    mutation: () => Promise<void>,
  ) => mutation());
  const mutateSettings = jest.fn(async (
    mutation: (current: Record<string, unknown>) => void | Promise<void>,
  ) => {
    await mutation(settings);
    await saveSettings();
  });
  const applyProviderRuntimeSettings = jest.fn(async (
    providerIds: string[],
    mutation: (current: Record<string, unknown>) => void | Promise<void>,
    onApplied?: () => void | Promise<void>,
  ) => runProviderExecutionTransition(providerIds, async () => {
    await mutateSettings(mutation);
    await onApplied?.();
  }));
  return {
    plugin: {
      applyProviderRuntimeSettings,
      notifyProviderChatOptionsChanged: jest.fn(),
      runProviderExecutionTransition,
      saveSettings,
      settings,
      mutateSettings,
    },
    renderAgentSkillSettings: jest.fn(),
    notifyProviderModelOptionsChanged: jest.fn(),
    renderHiddenProviderCommandSetting: jest.fn(),
  };
}

function render(settings: Record<string, unknown>) {
  const context = createContext(settings);
  // Test double from the shared MockElement helper: the renderer only touches the DOM surface it provides.
  ompSettingsTabRenderer.render(
    createElement() as unknown as HTMLElement,
    context as unknown as ProviderSettingsTabRendererContext,
  );
  return context;
}

async function flushPromises(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function findSetting(name: string): MockSetting {
  const setting = [...createdSettings].reverse().find(entry => entry.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

function findElement(tag: string, cls: string): MockElement {
  const element = [...createdDomElements].reverse().find(
    candidate => candidate.tag === tag && candidate.cls === cls,
  );
  if (!element) {
    throw new Error(`Element not found: ${tag}.${cls}`);
  }
  return element;
}

function findInputByType(type: string): MockElement {
  const element = [...createdDomElements].reverse().find(
    candidate => candidate.tag === 'input' && candidate.type === type,
  );
  if (!element) {
    throw new Error(`Input not found: ${type}`);
  }
  return element;
}

describe('OmpSettingsTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createdSettings.length = 0;
    createdDomElements.length = 0;
    mockNotices.length = 0;
    mockedExists.mockReturnValue(true);
    mockedStat.mockReturnValue({ isFile: () => true });
    mockDiscoverModels.mockResolvedValue({
      kind: 'completed',
      models: [],
    });
  });

  it.each([false, true])('clears legacy CLI configuration when restoring automatic detection (host override: %s)', async (hasHostOverride) => {
    const config = {
      cliPath: '/legacy/omp',
      cliPathsByHost: { 'other-host': '/keep/omp', ...(hasHostOverride ? { 'current-host': '/host/omp' } : {}) },
    };
    const settings: Record<string, unknown> = { providerConfigs: { omp: config } };
    render(settings);
    const input = findSetting('CLI path').textComponents[0];
    expect(input.value).toBe(hasHostOverride ? '/host/omp' : '/legacy/omp');
    await applyTextInput(input, '');
    expect(getOmpProviderSettings(settings).cliPath).toBe('');
    expect(getOmpProviderSettings(settings).cliPathsByHost).toEqual({ 'other-host': '/keep/omp' });
  });

  it('updates provider config when Omp is enabled', async () => {
    const settings: Record<string, unknown> = { providerConfigs: { omp: { enabled: false } } };
    const context = render(settings);

    const enableSetting = findSetting('Enable OMP');
    await enableSetting.toggleComponents[0].onChangeCallback?.(true);

    expect(getOmpProviderSettings(settings).enabled).toBe(true);
    expect(context.plugin.saveSettings).toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('omp');
  });

  it('commits Omp enablement inside the execution transition without metadata startup', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { omp: { enabled: true } },
    };
    const context = render(settings);
    const enableSetting = findSetting('Enable OMP');
    context.plugin.runProviderExecutionTransition.mockImplementationOnce(async (
      providerIds: string[],
      mutation: () => Promise<void>,
    ) => {
      expect(providerIds).toEqual(['omp']);
      expect(getOmpProviderSettings(settings).enabled).toBe(true);
      await mutation();
      expect(getOmpProviderSettings(settings).enabled).toBe(false);
    });

    await enableSetting.toggleComponents[0].onChangeCallback?.(false);

    expect(context.plugin.runProviderExecutionTransition).toHaveBeenCalledTimes(1);
    expect(mockDiscoverModels).not.toHaveBeenCalled();
  });

  it('resynchronizes the Omp toggle when disabling the final provider is rejected', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { omp: { enabled: true } },
    };
    const context = render(settings);
    const toggle = findSetting('Enable OMP').toggleComponents[0];
    const coordinator = jest.requireMock('@/core/providers/ProviderSettingsCoordinator')
      .ProviderSettingsCoordinator;
    coordinator.canApplyProviderEnablement.mockImplementationOnce(() => false);
    toggle.setValue.mockClear();

    await toggle.onChangeCallback?.(false);

    expect(toggle.setValue).toHaveBeenLastCalledWith(true);
    expect(context.plugin.runProviderExecutionTransition).not.toHaveBeenCalled();
    expect(coordinator.applyProviderEnablement).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();

    await toggle.onChangeCallback?.(true);
  });

  it('restores the Omp enablement toggle when the execution transition fails', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { omp: { enabled: false } },
    };
    const context = render(settings);
    const toggle = findSetting('Enable OMP').toggleComponents[0];
    context.plugin.runProviderExecutionTransition.mockRejectedValueOnce(
      new Error('transition failed'),
    );

    await expect(toggle.onChangeCallback?.(true)).rejects.toThrow(
      'transition failed',
    );

    expect(getOmpProviderSettings(settings).enabled).toBe(false);
    expect(toggle.setValue).toHaveBeenLastCalledWith(false);
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
    expect(mockDiscoverModels).not.toHaveBeenCalled();
  });

  it('resynchronizes Omp enablement to durable settings after a late transition failure', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { omp: { enabled: false } },
    };
    const context = render(settings);
    const toggle = findSetting('Enable OMP').toggleComponents[0];
    context.plugin.runProviderExecutionTransition.mockImplementationOnce(async (
      _providerIds: string[],
      mutation: () => Promise<void>,
    ) => {
      await mutation();
      throw new Error('transition completion failed');
    });

    await expect(toggle.onChangeCallback?.(true)).rejects.toThrow(
      'transition completion failed',
    );

    expect(getOmpProviderSettings(settings).enabled).toBe(true);
    expect(toggle.setValue).toHaveBeenLastCalledWith(true);
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
    expect(mockDiscoverModels).not.toHaveBeenCalled();
  });

  it('renders shared skills and keeps hidden provider commands separate', () => {
    const settings: Record<string, unknown> = { providerConfigs: { omp: {} } };
    const context = render(settings);

    expect(context.renderAgentSkillSettings).toHaveBeenCalledWith(
      expect.anything(),
      'omp',
    );
    expect(context.renderHiddenProviderCommandSetting).toHaveBeenCalledWith(
      expect.anything(),
      'omp',
      expect.objectContaining({ name: 'Hidden OMP commands and skills' }),
    );
  });

  it('scopes provider environment variables to the omp provider', () => {
    render({ providerConfigs: { omp: {} } });

    expect(mockRenderEnvironmentSettingsSection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'OMP environment variables',
        scope: 'provider:omp',
      }),
    );
  });

  it('does not render the chat input tool mode setting for Omp', () => {
    render({ providerConfigs: { omp: { toolMode: 'readonly' } } });

    expect(() => findSetting('Tool mode')).toThrow('Setting not found: Tool mode');
  });

  it('validates host-scoped CLI paths and resets the resolver after valid changes', async () => {
    const settings: Record<string, unknown> = { providerConfigs: { omp: {} } };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];

    mockedExists.mockReturnValue(false);
    await applyTextInput(cliInput, '/missing/omp');
    expect(context.plugin.saveSettings).not.toHaveBeenCalled();
    expect(mockCliResolverReset).not.toHaveBeenCalled();

    mockedExists.mockReturnValue(true);
    mockedStat.mockReturnValue({ isFile: () => true });
    await applyTextInput(cliInput, '/valid/omp');
    expect(getOmpProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/valid/omp',
    });
    expect(mockCliResolverReset).toHaveBeenCalled();
    expect(context.plugin.saveSettings).toHaveBeenCalled();
  });

  it('accepts a CLI path pasted with surrounding quotes', async () => {
    const settings: Record<string, unknown> = { providerConfigs: { omp: {} } };
    render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];

    mockedExists.mockImplementation((filePath: unknown) => String(filePath) === '/my tools/omp');
    mockedStat.mockReturnValue({ isFile: () => true });
    await applyTextInput(cliInput, '"/my tools/omp"');

    expect(getOmpProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '"/my tools/omp"',
    });
  });

  it('commits the Omp CLI path and clears discovery inside the execution transition', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          cliPathsByHost: { 'current-host': '/old/omp' },
          discoveredModels: [{ id: 'cached' }],
        },
      },
    };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];
    const order: string[] = [];
    mockCliResolverReset.mockImplementationOnce(() => {
      order.push('resolver-reset');
    });
    context.plugin.runProviderExecutionTransition.mockImplementationOnce(async (
      providerIds: string[],
      mutation: () => Promise<void>,
    ) => {
      order.push('transition-start');
      expect(providerIds).toEqual(['omp']);
      expect(getOmpProviderSettings(settings).cliPathsByHost['current-host'])
        .toBe('/old/omp');
      await mutation();
      order.push('settings-committed');
      expect(getOmpProviderSettings(settings).discoveredModels).toEqual([]);
      expect(mockCliResolverReset).toHaveBeenCalledTimes(1);
      order.push('transition-end');
    });

    await applyTextInput(cliInput, '/new/omp');

    expect(order).toEqual([
      'transition-start',
      'resolver-reset',
      'settings-committed',
      'transition-end',
    ]);
    expect(getOmpProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/new/omp',
    });
    expect(context.plugin.applyProviderRuntimeSettings).toHaveBeenCalledWith(
      ['omp'],
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('retains the Omp CLI draft when transition setup fails before mutation', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: { cliPathsByHost: { 'current-host': '/old/omp' } },
      },
    };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];
    cliInput.inputEl.value = '/failed/omp';
    context.plugin.runProviderExecutionTransition.mockRejectedValueOnce(
      new Error('transition failed'),
    );

    await applyTextInput(cliInput, '/failed/omp');

    expect(getOmpProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/old/omp',
    });
    expect(cliInput.inputEl.value).toBe('/failed/omp');
    expect(mockCliResolverReset).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
  });

  it('resynchronizes the Omp CLI input to durable settings when resolver reset fails', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: { cliPathsByHost: { 'current-host': '/old/omp' } },
      },
    };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];
    cliInput.inputEl.value = '/new/omp';
    mockCliResolverReset.mockImplementationOnce(() => {
      throw new Error('resolver reset failed');
    });

    await applyTextInput(cliInput, '/new/omp');

    expect(getOmpProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/new/omp',
    });
    expect(cliInput.inputEl.value).toBe('/new/omp');
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
  });

  it('discovers models through OmpModelDiscoveryService and reports failures', async () => {
    mockDiscoverModels.mockResolvedValueOnce({
      kind: 'completed',
      models: [{
        encodedId: 'omp:anthropic/claude-sonnet-4',
        id: 'claude-sonnet-4',
        input: ['text'],
        label: 'Claude Sonnet 4',
        provider: 'anthropic',
        reasoning: true,
        thinkingLevels: ['off', 'medium'],
      }],
    });
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          visibleModels: ['omp:anthropic/claude-sonnet-4'],
        },
      },
    };
    const context = render(settings);

    await findElement('button', 'claudian-provider-model-picker-action').dispatchMockEvent('click');
    await flushPromises();

    expect(mockDiscoverModels).toHaveBeenCalledTimes(1);
    expect(getOmpProviderSettings(settings).discoveredModels).toHaveLength(1);
    expect(getOmpProviderSettings(settings).visibleModels).toEqual(['omp:anthropic/claude-sonnet-4']);
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('omp');

    mockDiscoverModels.mockResolvedValueOnce({
      diagnostics: 'not logged in',
      kind: 'completed',
      models: [],
    });
    await findElement('button', 'claudian-provider-model-picker-action').dispatchMockEvent('click');
    await flushPromises();
    expect(mockNotices[0]).toContain('not logged in');
  });

  it('preserves cached models when discovery is skipped for a disabled provider', async () => {
    const cachedModel = {
      encodedId: 'omp:anthropic/claude-sonnet-4',
      id: 'claude-sonnet-4',
      input: ['text'],
      label: 'Claude Sonnet 4',
      provider: 'anthropic',
      reasoning: true,
      thinkingLevels: ['off', 'medium'],
    };
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          discoveredModels: [cachedModel],
          enabled: false,
          visibleModels: [cachedModel.encodedId],
        },
      },
    };
    const context = render(settings);
    mockDiscoverModels.mockResolvedValueOnce({
      kind: 'skipped',
      reason: 'provider-disabled',
    });

    await findElement('button', 'claudian-provider-model-picker-action').dispatchMockEvent('click');
    await flushPromises();

    expect(getOmpProviderSettings(settings).discoveredModels).toEqual([cachedModel]);
    expect(context.plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('does not publish unchanged model discovery', async () => {
    const cachedModel = {
      encodedId: 'omp:anthropic/claude-sonnet-4',
      id: 'claude-sonnet-4',
      input: ['text'] as Array<'text'>,
      label: 'Claude Sonnet 4',
      provider: 'anthropic',
      reasoning: true,
      thinkingLevels: ['off', 'medium'] as Array<'off' | 'medium'>,
    };
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          discoveredModels: [cachedModel],
          visibleModels: [cachedModel.encodedId],
        },
      },
    };
    const context = render(settings);
    mockDiscoverModels.mockResolvedValueOnce({
      kind: 'completed',
      models: [cachedModel],
    });

    await findElement('button', 'claudian-provider-model-picker-action').dispatchMockEvent('click');
    await flushPromises();

    expect(context.plugin.saveSettings).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
  });

  it('persists visible model choices and aliases', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          discoveredModels: [{
            encodedId: 'omp:anthropic/claude-sonnet-4',
            id: 'claude-sonnet-4',
            input: ['text'],
            label: 'Claude Sonnet 4',
            provider: 'anthropic',
            reasoning: true,
            thinkingLevels: ['off', 'medium'],
          }],
          visibleModels: [],
        },
      },
    };
    const context = render(settings);
    const checkboxEl = findInputByType('checkbox');

    checkboxEl.checked = true;
    await checkboxEl.dispatchMockEvent('change');
    await flushPromises();
    expect(getOmpProviderSettings(settings).visibleModels).toEqual(['omp:anthropic/claude-sonnet-4']);

    const aliasInput = findElement('input', 'claudian-provider-model-picker-selected-alias');
    aliasInput.value = 'Sonnet';
    await aliasInput.dispatchMockEvent('blur');
    await flushPromises();

    expect(getOmpProviderSettings(settings).modelAliases).toEqual({
      'omp:anthropic/claude-sonnet-4': 'Sonnet',
    });
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledTimes(2);
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('omp');
  });
});
