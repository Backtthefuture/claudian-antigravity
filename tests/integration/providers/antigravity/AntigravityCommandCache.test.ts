import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileSystemAdapter } from 'obsidian';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderCommandLoaderContext, ProviderWorkspaceInitContext, ProviderWorkspaceServices } from '@/core/providers/types';
import { antigravityWorkspace } from '@/providers/antigravity/AntigravityWorkspace';
import { updateAntigravitySettings } from '@/providers/antigravity/settings';

jest.mock('obsidian', () => ({
  ...jest.requireActual('obsidian'),
  FileSystemAdapter: class { getBasePath() { return ''; } },
}));

describe('Antigravity workspace command cache', () => {
  let root: string;
  let host: ProviderHost;
  let services: ProviderWorkspaceServices[];
  let transition: () => Promise<void>;
  const context = (plugin: ProviderHost): ProviderCommandLoaderContext => ({ plugin, conversation: null, allowIsolatedMetadataCreation: true });
  const start = async () => {
    const service = await antigravityWorkspace.initialize({ plugin: host } as ProviderWorkspaceInitContext);
    services.push(service);
    return service.commandLoader!;
  };
  const fixture = async (value: unknown) => writeFile(join(root, 'fixture.json'), JSON.stringify(value));
  beforeEach(async () => {
    services = [];
    root = await mkdtemp(join(tmpdir(), 'agy-skills-'));
    const cli = join(root, 'agy');
    await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const countPath = path.join(process.cwd(), 'probe-count');
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;
fs.writeFileSync(countPath, String(count + 1));
const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'fixture.json'), 'utf8'));
setTimeout(() => {
  if (data.error) { process.stderr.write(data.error); process.exit(1); }
  process.stdout.write(JSON.stringify({status:'SUCCESS',command:{data:{skills:data.skills}}}));
}, data.delay || 0);
`);
    await chmod(cli, 0o755);
    await writeFile(join(root, 'fixture.json'), JSON.stringify({ skills: [{ name: 'laoming-test', description: 'Native skill' }] }));
    const adapter = new FileSystemAdapter();
    jest.spyOn(adapter, 'getBasePath').mockReturnValue(root);
    host = {
      app: { vault: { adapter } }, settings: { providerConfigs: { antigravity: { enabled: true, cliPath: cli } } },
      getResolvedProviderCliPath: async () => cli, getActiveEnvironmentVariables: () => '',
      executionLifecycleRegistry: { registerTransitionHook: (_id: string, hook: { beforeTransition: () => Promise<void> }) => {
        transition = hook.beforeTransition;
        return () => {};
      } },
    } as unknown as ProviderHost;
  });
  afterEach(async () => {
    await Promise.all(services.map(s => s.dispose?.()));
    await rm(root, { recursive: true, force: true });
  });

  it('shares successful discovery between conversations instead of starting another CLI', async () => {
    const loader = await start();
    const first = await loader.loadCommands(context(host));
    expect(first.status).toBe('ready');
    await writeFile(join(root, 'fixture.json'), JSON.stringify({ error: 'CLI should not be needed for another conversation' }));
    expect(await loader.loadCommands(context(host))).toEqual(first);
    expect(await readFile(join(root, 'probe-count'), 'utf8')).toBe('1');
  });

  it('restores the last native list after a plugin restart while revalidation is unavailable', async () => {
    const loader = await start();
    const first = await loader.loadCommands(context(host));
    await services[0].dispose?.();
    await writeFile(join(root, 'fixture.json'), JSON.stringify({ error: 'Offline', delay: 500 }));
    const restarted = await start();
    expect(await restarted.loadCommands(context(host))).toEqual(first);
  });

  it('shares a cold discovery when one of two chat consumers cancels', async () => {
    await fixture({ skills: [{ name: 'shared-skill', description: '' }], delay: 100 });
    const loader = await start();
    const controller = new AbortController();
    const abandoned = loader.loadCommands({ ...context(host), signal: controller.signal });
    const surviving = loader.loadCommands(context(host));
    controller.abort();
    expect((await abandoned).status).toBe('error');
    expect(await surviving).toMatchObject({ status: 'ready', items: [{ name: 'shared-skill' }] });
    expect(await readFile(join(root, 'probe-count'), 'utf8')).toBe('1');
  });

  it('retries a failed cold discovery instead of caching it as empty', async () => {
    await fixture({ error: 'Temporary metadata error' });
    const loader = await start();
    expect((await loader.loadCommands(context(host))).status).toBe('error');
    await fixture({ skills: [{ name: 'recovered', description: '' }] });
    expect(await loader.loadCommands(context(host))).toMatchObject({ status: 'ready', items: [{ name: 'recovered' }] });
  });

  it('caches a successful empty catalog and rejects corrupted disk metadata', async () => {
    await fixture({ skills: [] });
    const loader = await start();
    expect(await loader.loadCommands(context(host))).toEqual({ status: 'empty' });
    await fixture({ error: 'Do not retry a successful empty discovery' });
    expect(await loader.loadCommands(context(host))).toEqual({ status: 'empty' });
    await services[0].dispose?.();
    await writeFile(join(root, '.claudian/cache/antigravity-skills.json'), '{corrupt');
    await fixture({ skills: [{ name: 'fresh-list', description: '' }] });
    expect(await (await start()).loadCommands(context(host))).toMatchObject({ status: 'ready', items: [{ name: 'fresh-list' }] });
  });

  it('does not reuse a catalog from different CLI settings', async () => {
    const loader = await start();
    await loader.loadCommands(context(host));
    updateAntigravitySettings(host.settings, { environmentVariables: 'AGY_TEST_ENV=changed' });
    await fixture({ skills: [{ name: 'changed-environment', description: '' }] });
    expect(await loader.loadCommands(context(host))).toMatchObject({ status: 'ready', items: [{ name: 'changed-environment' }] });
  });

  it('publishes a background refresh for subsequent chats without blocking the restored list', async () => {
    const loader = await start();
    const first = await loader.loadCommands(context(host));
    await services[0].dispose?.();
    await fixture({ skills: [{ name: 'newly-installed', description: 'Updated native list' }], delay: 100 });
    const restarted = await start();
    expect(await restarted.loadCommands(context(host))).toEqual(first);
    const cachePath = join(root, '.claudian/cache/antigravity-skills.json');
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readFile(cachePath, 'utf8')).includes('newly-installed')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await restarted.loadCommands(context(host))).toMatchObject({ status: 'ready', items: [{ name: 'newly-installed' }] });
  });

  it('fences an in-flight catalog when the provider environment transitions', async () => {
    await fixture({ skills: [{ name: 'old-environment', description: '' }], delay: 1000 });
    const loader = await start();
    const old = loader.loadCommands(context(host));
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(join(root, 'probe-count'), 'utf8').catch(() => '0') === '1') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await transition();
    expect((await old).status).toBe('error');
    await fixture({ skills: [{ name: 'current-environment', description: '' }] });
    const current = await loader.loadCommands(context(host));
    expect(current).toMatchObject({ status: 'ready', items: [{ name: 'current-environment' }] });
    await services[0].dispose?.();
    expect(await (await start()).loadCommands(context(host))).toEqual(current);
  });
});
