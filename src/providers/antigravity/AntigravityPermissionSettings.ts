import { Notice, Setting } from 'obsidian';

import type { ProviderHost } from '@/core/providers/ProviderHost';

import { getAntigravitySettings, updateAntigravitySettings } from './settings';

export function renderAntigravityPermissionSetting(container: HTMLElement, host: ProviderHost): void {
  const current = () => getAntigravitySettings(host.settings).autoApproveAllTools ? 'full-access' : 'native';
  new Setting(container)
    .setName('Tool permissions')
    .setDesc('Full access automatically approves all agy tools, including terminal commands and files outside the vault. Applies to new and resumed chats. Native permissions keeps the CLI rules; headless approval requests are denied.')
    .addDropdown(dropdown => {
      dropdown.selectEl.setAttribute('aria-label', 'Tool permissions');
      dropdown.addOption('native', 'Native permissions')
        .addOption('full-access', 'Full access (auto-approve all tools)')
        .setValue(current())
        .onChange(async value => {
          dropdown.setDisabled(true);
          try {
            await host.applyProviderRuntimeSettings(['antigravity'], settings => {
              updateAntigravitySettings(settings, { autoApproveAllTools: value === 'full-access' });
            });
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          } finally {
            dropdown.setValue(current()).setDisabled(false);
          }
        });
    });
}
