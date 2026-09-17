import { createHash } from 'node:crypto';

import { FileSystemAdapter } from 'obsidian';

import { CachedProviderCliResolver } from '@/core/providers/cli/CachedProviderCliResolver';
import { normalizeProviderCommandDiscoveryItems } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import type { ProviderWorkspaceRegistration } from '@/core/providers/types';
import { getHostnameKey } from '@/utils/env';

import { parseAntigravityModels, parseAntigravitySkills } from './AntigravityMetadata';
import { readAntigravityMetadata } from './AntigravityProcess';
import { antigravitySettingsTab } from './AntigravitySettingsTab';
import { AntigravitySkillCache } from './AntigravitySkillCache';
import { getAntigravitySettings, updateAntigravitySettings } from './settings';

export const antigravityWorkspace: ProviderWorkspaceRegistration = {
  async initialize({ plugin }) {
    const adapter = plugin.app.vault.adapter;
    const cwd = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
    const pending = new Set<AbortController>();
    let disposed = false;
    let generation = 0;
    const metadata = async (args: string[], signal?: AbortSignal) => {
      if (disposed || !cwd) throw new Error('Antigravity requires an active desktop vault');
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      pending.add(controller);
      try { return await readAntigravityMetadata(plugin, cwd, args, controller.signal); }
      finally { signal?.removeEventListener('abort', abort); pending.delete(controller); }
    };
    const skills = new AntigravitySkillCache(cwd, async signal => parseAntigravitySkills(await metadata(['-p', '/skills', '--output-format', 'json'], signal)));
    const fingerprint = (settings: Record<string, unknown>) => createHash('sha256').update(JSON.stringify([
      cwd, getHostnameKey(), getAntigravitySettings(settings).cliPath,
      getAntigravitySettings(settings).cliPathsByHost, getRuntimeEnvironmentText(settings, 'antigravity'),
    ])).digest('hex');
    const quiesce = () => { generation++; skills.invalidate(); for (const controller of pending) controller.abort(); };
    const unregister = plugin.executionLifecycleRegistry.registerTransitionHook('antigravity', { beforeTransition: async () => quiesce() });
    return {
      cliResolver: new CachedProviderCliResolver({ binaryName: 'agy', providerId: 'antigravity', getSettingsProjection: settings => ({
        cliPathsByHost: getAntigravitySettings(settings).cliPathsByHost,
        legacyCliPath: getAntigravitySettings(settings).cliPath, environmentText: getRuntimeEnvironmentText(settings, 'antigravity'),
      }) }),
      commandCatalog: new RuntimeCommandCatalog({
        dropdownConfig: { providerId: 'antigravity', builtInPrefix: '/', commandPrefix: '/', skillPrefix: '/', triggerChars: ['/'] },
        projectEntry: command => ({ ...command, providerId: 'antigravity', kind: 'skill', source: 'sdk', scope: 'runtime', isEditable: false, isDeletable: false, displayPrefix: '/', insertPrefix: '/' }),
      }),
      commandLoader: {
        getCacheFingerprint: settings => `${fingerprint(settings)}:${generation}`,
        isAvailable: settings => getAntigravitySettings(settings).enabled,
        async loadCommands(context) {
          try {
            return normalizeProviderCommandDiscoveryItems(await skills.load(fingerprint(plugin.settings), context.signal));
          } catch (error) {
            return { status: 'error', retryable: true, message: error instanceof Error ? error.message : String(error) };
          }
        },
      },
      settingsTabRenderer: antigravitySettingsTab,
      tabWarmupPolicy: { resolveMode: () => 'commands' },
      async refreshModelCatalog() {
        const expectedGeneration = generation;
        const models = parseAntigravityModels(await metadata(['models']));
        if (disposed || expectedGeneration !== generation) return { changed: false };
        if (!models.length) throw new Error('Antigravity returned no model catalog');
        let changed = false;
        await plugin.mutateSettingsConditionally(settings => {
          if (disposed || expectedGeneration !== generation) return false;
          changed = JSON.stringify(getAntigravitySettings(settings).discoveredModels) !== JSON.stringify(models);
          if (changed) updateAntigravitySettings(settings, { discoveredModels: models });
          return changed;
        });
        return { changed, persistedSettingsChanged: changed };
      },
      async dispose() { disposed = true; quiesce(); unregister(); await skills.dispose(); },
    };
  },
};
