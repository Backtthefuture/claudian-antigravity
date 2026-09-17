import { Notice, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderSettingsTabRenderer } from '@/core/providers/types';
import { renderEnvironmentSettingsSection } from '@/shared/settings/EnvironmentSettingsSection';
import { renderHostnameCliPathSetting } from '@/shared/settings/HostnameCliPathSetting';
import { renderProviderModelPicker } from '@/shared/settings/ProviderModelPicker';
import { getHostnameKey } from '@/utils/env';

import { getAntigravitySettings, updateAntigravitySettings } from './settings';

export const antigravitySettingsTab: ProviderSettingsTabRenderer = {
  render(container, context) {
    const host = context.plugin;
    const settings = () => getAntigravitySettings(host.settings);
    new Setting(container).setName('Antigravity').setDesc('Uses your installed and authenticated agy CLI. Native CLI permission rules apply; interactive approvals are unavailable in headless mode.').addToggle(toggle => toggle.setValue(settings().enabled).onChange(async value => {
      if (!ProviderSettingsCoordinator.canApplyProviderEnablement(host.settings, 'antigravity', value)) {
        toggle.setValue(settings().enabled);
        new Notice('Keep at least one provider enabled.');
        return;
      }
      await host.runProviderExecutionTransition(['antigravity'], async () => {
        await host.mutateSettings(bag => { ProviderSettingsCoordinator.applyProviderEnablement(bag, 'antigravity', value); });
      });
      context.notifyProviderModelOptionsChanged('antigravity');
    }));
    renderHostnameCliPathSetting({
      container, name: 'CLI path', description: 'Absolute path to agy on this computer. Leave empty to discover it on PATH.', placeholder: '/path/to/agy',
      getValue: () => settings().cliPathsByHost[getHostnameKey()] || '',
      async onChange(value) {
        await host.applyProviderRuntimeSettings(['antigravity'], bag => {
          const paths = { ...getAntigravitySettings(bag).cliPathsByHost };
          if (value) paths[getHostnameKey()] = value; else delete paths[getHostnameKey()];
          updateAntigravitySettings(bag, { cliPathsByHost: paths });
        });
      },
    });
    renderProviderModelPicker({
      container, providerName: 'Antigravity', modifier: 'antigravity',
      emptyCatalogText: 'Discover models from agy, then enable the ones you want in chat.',
      failedCatalogText: 'Model discovery failed. Check the CLI path, login and network settings.',
      loadingCatalogText: 'Reading agy models…',
      getState() {
        const config = settings();
        return { aliases: config.modelAliases, defaultModelId: config.visibleModels[0], discoveredCount: config.discoveredModels.length, models: config.discoveredModels, selectedIds: config.visibleModels };
      },
      async loadCatalog() {
        try {
          await ProviderWorkspaceRegistry.requireServices('antigravity').refreshModelCatalog?.();
          context.notifyProviderModelOptionsChanged('antigravity');
          return settings().discoveredModels.length ? 'loaded' : 'empty';
        } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); return 'failed'; }
      },
      async onSelectedIdsChange(visibleModels) {
        await host.mutateSettings(bag => updateAntigravitySettings(bag, { visibleModels }));
        context.notifyProviderModelOptionsChanged('antigravity');
      },
      async onAliasesChange(modelAliases) {
        await host.mutateSettings(bag => updateAntigravitySettings(bag, { modelAliases }));
        context.notifyProviderModelOptionsChanged('antigravity');
      },
    });
    new Setting(container).setName('Skills').setDesc('The / menu reads the native agy /skills catalog, including project skills and symlinks. Edit skills in their source folders. Reopen the chat to refresh discovery.');
    context.renderHiddenProviderCommandSetting(container, 'antigravity', { name: 'Hidden Skills', desc: 'Hide selected Skills from the slash menu.', placeholder: 'skill-name' });
    renderEnvironmentSettingsSection({ container, plugin: host, scope: 'provider:antigravity', name: 'Environment variables', desc: 'Environment for agy subprocesses, including proxy settings when needed.', placeholder: 'HTTPS_PROXY=http://127.0.0.1:7897' });
  },
};
