import * as fs from 'node:fs';

import { Notice, Setting } from 'obsidian';

import { probeCliInstallation } from '@/core/providers/cli/CliInstallationProbe';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { resolveOmpProcessSpec } from '@/providers/omp/runtime/OmpSubprocess';
import { OMP_PROVIDER_ICON } from '@/shared/icons';
import { renderCliInstallationSetting } from '@/shared/settings/CliInstallationSetting';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import type { ProviderEnablementSettingOptions } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { normalizeConfiguredCliPath } from '../../../utils/path';
import { maybeGetOmpWorkspaceServices } from '../app/OmpWorkspaceServices';
import { sameDiscoveredModels, sameStringList } from '../internal/compareCollections';
import { decodeOmpModelId, type OmpDiscoveredModel } from '../models';
import { OmpModelDiscoveryService } from '../runtime/OmpModelDiscoveryService';
import {
  getOmpProviderSettings,
  normalizeOmpVisibleModels,
  updateOmpProviderSettings,
} from '../settings';

export const ompSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const hostnameKey = getHostnameKey();
    const workspace = maybeGetOmpWorkspaceServices();

    const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
      getValue: () => getOmpProviderSettings(settingsBag).enabled,
      name: t('settings.providerEnablement.name', { provider: 'OMP' }),
      onChange: async (value) => {
        if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
          settingsBag,
          'omp',
          value,
        )) {
          lastProviderWarning.showFor();
          return;
        }

        let accepted = true;
        await context.plugin.runProviderExecutionTransition(['omp'], async () => {
          await context.plugin.mutateSettings((settings) => {
            accepted = ProviderSettingsCoordinator.applyProviderEnablement(
              settings,
              'omp',
              value,
            );
          });
        });
        if (accepted) {
          lastProviderWarning.hide();
        } else {
          lastProviderWarning.showFor();
        }
        modelWarning.context.notifyProviderModelOptionsChanged('omp');
      },
    };

    const installationContainer = container.createDiv();
    const lastProviderWarning = renderLastEnabledProviderWarning(container);

    const modelWarning = renderProviderModelEnablementWarning(container, context, {
      getHasEnabledModels: () => getOmpProviderSettings(settingsBag).visibleModels.length > 0,
      getIsEnabled: () => getOmpProviderSettings(settingsBag).enabled,
      providerId: 'omp',
      providerName: 'OMP',
    });

    renderCliInstallationSetting({
      cliName: 'OMP CLI',
      icon: OMP_PROVIDER_ICON,
      inspect: async () => {
        const settings = context.plugin.settings as unknown as Record<string, unknown>;
        const config = getOmpProviderSettings(settings);
        return probeCliInstallation({
          path: await context.plugin.getResolvedProviderCliPath('omp'),
          configuredPath: config.cliPathsByHost[hostnameKey] || config.cliPath,
          args: ['--version'],
          env: { ...process.env, ...getRuntimeEnvironmentVariables(settings, 'omp') },
          prepareLaunch: (spec) => ({ ...spec, ...resolveOmpProcessSpec(spec, spec.env.PATH ?? '') }),
        });
      },
      container: installationContainer,
      enablement,
      getValue: () => {
        const config = getOmpProviderSettings(settingsBag);
        return config.cliPathsByHost[hostnameKey] || config.cliPath;
      },
      name: 'CLI path',
      onChange: async (value) => {
        const cliPathsByHost = {
          ...getOmpProviderSettings(settingsBag).cliPathsByHost,
        };
        if (value) {
          cliPathsByHost[hostnameKey] = value;
        } else {
          delete cliPathsByHost[hostnameKey];
        }

        await context.plugin.applyProviderRuntimeSettings(
          ['omp'],
          (settings) => {
            updateOmpProviderSettings(settings, {
              cliPathsByHost,
              discoveredModels: [],
            });
          },
          () => workspace?.cliResolver?.reset(),
        );
        context.notifyProviderModelOptionsChanged('omp');
      },
      placeholder: process.platform === 'win32'
        ? 'C:\\Users\\you\\.bun\\bin\\omp.exe'
        : '/Users/you/.bun/bin/omp',
      validate: validateCliPath,
    });

    new Setting(container).setName('Models').setHeading();
    renderOmpModelPicker(container, modelWarning.context, settingsBag);

    new Setting(container).setName(t('settings.agentSkills.sectionTitle')).setHeading();
    context.renderAgentSkillSettings(container, 'omp');

    new Setting(container).setName('Commands').setHeading();
    context.renderHiddenProviderCommandSetting(container, 'omp', {
      name: 'Hidden OMP commands and skills',
      desc: 'Hide runtime commands and skills advertised by OMP from the command dropdown. Enter exact names without the leading slash, one per line.',
      placeholder: 'skill:review\ncompact',
    });

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to OMP.',
      heading: 'Environment',
      name: 'OMP environment variables',
      placeholder: 'OMP_PROFILE=default',
      plugin: context.plugin,
      scope: 'provider:omp',
    });
  },
};

function renderOmpModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
): void {
  const getState = (): ProviderModelPickerState => {
    const current = getOmpProviderSettings(settingsBag);
    return {
      aliases: current.modelAliases,
      discoveredCount: current.discoveredModels.length,
      models: buildOmpPickerModels(current.discoveredModels, current.visibleModels),
      selectedIds: current.visibleModels,
    };
  };

  renderProviderModelPicker({
    container,
    emptyCatalogText: 'No OMP models discovered yet. Click Discover to load models from OMP.',
    failedCatalogText: 'Could not load the OMP model catalog. Check the CLI path and login state, then try again.',
    getState,
    async loadCatalog() {
      const result = await new OmpModelDiscoveryService(context.plugin).discoverModels();
      if (result.kind === 'skipped') {
        return getOmpProviderSettings(settingsBag).discoveredModels.length > 0 ? 'loaded' : 'empty';
      }
      if (result.diagnostics) {
        new Notice(`OMP discovery failed: ${result.diagnostics}`);
        return 'failed';
      }

      const current = getOmpProviderSettings(settingsBag);
      const normalizedVisibleModels = normalizeOmpVisibleModels(current.visibleModels, result.models);
      const catalogChanged = !sameDiscoveredModels(current.discoveredModels, result.models);
      const visibilityChanged = !sameStringList(current.visibleModels, normalizedVisibleModels);
      if (catalogChanged || visibilityChanged) {
        await context.plugin.mutateSettings((settings) => {
          updateOmpProviderSettings(settings, {
            discoveredModels: result.models,
            visibleModels: normalizedVisibleModels,
          });
        });
        context.notifyProviderModelOptionsChanged('omp');
      }
      return result.models.length > 0 ? 'loaded' : 'empty';
    },
    loadingCatalogText: 'Loading OMP model catalog...',
    modifier: 'omp',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateOmpProviderSettings(settings, { modelAliases });
      });
      context.notifyProviderModelOptionsChanged('omp');
    },
    async onSelectedIdsChange(visibleModels) {
      const current = getOmpProviderSettings(settingsBag);
      const normalized = normalizeOmpVisibleModels(visibleModels, current.discoveredModels);
      if (sameStringList(current.visibleModels, normalized)) {
        return;
      }

      await context.plugin.mutateSettings((settings) => {
        updateOmpProviderSettings(settings, { visibleModels: normalized });
      });
      context.notifyProviderModelOptionsChanged('omp');
    },
    providerName: 'OMP',
  });
}

function validateCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const expandedPath = normalizeConfiguredCliPath(trimmed);
  if (!fs.existsSync(expandedPath)) {
    return 'Path does not exist';
  }

  if (!fs.statSync(expandedPath).isFile()) {
    return 'Path must point to a file';
  }

  return null;
}

function buildOmpPickerModels(
  discoveredModels: OmpDiscoveredModel[],
  visibleModels: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = [];
  const discoveredIds = new Set<string>();

  for (const model of discoveredModels) {
    discoveredIds.add(model.encodedId);
    models.push({
      description: buildOmpModelDescription(model),
      id: model.encodedId,
      isAvailable: true,
      name: model.label || model.id,
      providerKey: model.provider.toLowerCase(),
      providerLabel: formatProviderLabel(model.provider),
    });
  }

  for (const encodedId of visibleModels) {
    if (discoveredIds.has(encodedId)) {
      continue;
    }

    const decoded = decodeOmpModelId(encodedId);
    const provider = decoded?.provider ?? 'omp';
    models.push({
      description: 'Configured model',
      id: encodedId,
      isAvailable: false,
      name: decoded?.modelId ?? encodedId,
      providerKey: provider.toLowerCase(),
      providerLabel: formatProviderLabel(provider),
      unavailableMessage: 'Not currently reported by OMP',
    });
  }

  return models.sort((left, right) => {
    const providerCmp = (left.providerLabel ?? '').localeCompare(right.providerLabel ?? '');
    if (providerCmp !== 0) {
      return providerCmp;
    }
    return left.name.localeCompare(right.name);
  });
}

function buildOmpModelDescription(model: OmpDiscoveredModel): string {
  const details: string[] = [];
  if (model.api) {
    details.push(`API: ${model.api}`);
  }
  if (model.contextWindow) {
    details.push(`${model.contextWindow.toLocaleString()} context`);
  }
  if (model.maxTokens) {
    details.push(`${model.maxTokens.toLocaleString()} output`);
  }
  if (model.input.includes('image')) {
    details.push('image input');
  }
  details.push(model.reasoning
    ? `thinking: ${model.thinkingLevels.join(', ')}`
    : 'thinking: off');

  return details.join(' | ');
}

function formatProviderLabel(provider: string): string {
  const normalized = provider.trim();
  const knownProviders: Record<string, string> = {
    anthropic: 'Anthropic',
    deepseek: 'DeepSeek',
    google: 'Google',
    openai: 'OpenAI',
    xai: 'xAI',
  };
  const known = knownProviders[normalized.toLowerCase()];
  if (known) {
    return known;
  }

  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'OMP';
}
