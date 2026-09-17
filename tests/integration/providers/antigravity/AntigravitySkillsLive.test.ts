import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { FileSystemAdapter } from 'obsidian';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderCommandLoaderContext, ProviderWorkspaceInitContext, ProviderWorkspaceServices } from '@/core/providers/types';
import { antigravityWorkspace } from '@/providers/antigravity/AntigravityWorkspace';

jest.mock('obsidian', () => ({
  ...jest.requireActual('obsidian'),
  FileSystemAdapter: class { getBasePath() { return ''; } },
}));

const live = process.env.CLAUDIAN_AGY_LIVE_SKILL_TEST === '1' ? describe : describe.skip;

live('Antigravity live Skill discovery latency', () => {
  it('restores native command metadata without waiting for CLI startup', async () => {
    const parent = process.env.CLAUDIAN_AGY_TEST_VAULT;
    const cli = process.env.CLAUDIAN_AGY_TEST_CLI;
    if (!parent || !cli) throw new Error('Set an isolated CLAUDIAN_AGY_TEST_VAULT and CLAUDIAN_AGY_TEST_CLI');
    const root = await mkdtemp(join(parent, 'skill-cache-'));
    const services: ProviderWorkspaceServices[] = [];
    const adapter = new FileSystemAdapter();
    jest.spyOn(adapter, 'getBasePath').mockReturnValue(root);
    const host = {
      app: { vault: { adapter } }, settings: { providerConfigs: { antigravity: { enabled: true, cliPath: cli } } },
      getResolvedProviderCliPath: async () => cli, getActiveEnvironmentVariables: () => process.env.CLAUDIAN_AGY_TEST_ENV ?? '',
      executionLifecycleRegistry: { registerTransitionHook: () => () => {} },
    } as unknown as ProviderHost;
    const context: ProviderCommandLoaderContext = { plugin: host, conversation: null, allowIsolatedMetadataCreation: true };
    const start = async () => {
      const service = await antigravityWorkspace.initialize({ plugin: host } as ProviderWorkspaceInitContext);
      services.push(service);
      return service.commandLoader!;
    };
    try {
      const loader = await start();
      let began = performance.now();
      const cold = await loader.loadCommands(context);
      const coldMs = performance.now() - began;
      expect(cold.status).toBe('ready');
      began = performance.now();
      expect(await loader.loadCommands(context)).toEqual(cold);
      const warmMs = performance.now() - began;
      await services[0].dispose?.();
      const restored = await start();
      began = performance.now();
      expect(await restored.loadCommands(context)).toEqual(cold);
      const restoredMs = performance.now() - began;
      expect(warmMs).toBeLessThan(500);
      expect(restoredMs).toBeLessThan(500);
      if (process.env.CLAUDIAN_AGY_PERF_OUTPUT) {
        await writeFile(process.env.CLAUDIAN_AGY_PERF_OUTPUT, JSON.stringify({
          coldMs, warmMs, restoredMs, skills: cold.status === 'ready' ? cold.items.length : 0,
        }, null, 2));
      }
    } finally {
      await Promise.all(services.map(service => service.dispose?.()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
