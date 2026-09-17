import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProviderExecutionEvent, ProviderExecutionSession, ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { AntigravityExecutionBackend } from '@/providers/antigravity/AntigravityExecutionBackend';

const live = process.env.CLAUDIAN_AGY_LIVE_WRITE_TEST === '1' ? describe : describe.skip;

live('Antigravity live file permissions', () => {
  it('reads, creates and edits files in two vaults while retaining outside-file and command permissions', async () => {
    const parent = process.env.CLAUDIAN_AGY_TEST_VAULT;
    const cli = process.env.CLAUDIAN_AGY_TEST_CLI;
    if (!parent || !cli) throw new Error('Set an isolated CLAUDIAN_AGY_TEST_VAULT and CLAUDIAN_AGY_TEST_CLI');
    const root = await mkdtemp(join(parent, 'live-permissions-'));
    const host = {
      settings: {}, getResolvedProviderCliPath: async () => cli,
      getActiveEnvironmentVariables: () => process.env.CLAUDIAN_AGY_TEST_ENV ?? '',
    } as unknown as ProviderHost;
    const backend = new AntigravityExecutionBackend(host);
    const sessions: ProviderExecutionSession[] = [];
    const createSession = (vaultWorkingDirectory: string, id?: string) => {
      const session = backend.createSession({
        vaultWorkingDirectory, lifecycle: 'persistent', nativePersistence: 'enabled',
        interactionPort: {} as ProviderSessionConfig['interactionPort'],
        resumeSeed: id ? { providerSessionId: id } : undefined,
      });
      sessions.push(session);
      return session;
    };
    const run = async (session: ProviderExecutionSession, text: string) => {
      for (let attempt = 0; ; attempt++) {
        const events: ProviderExecutionEvent[] = [];
        for await (const event of session.execute({
          input: [{ type: 'text', text }], signal: new AbortController().signal,
          configuration: {
            model: 'antigravity:gemini-3.8-flash-high',
            systemInstructions: { kind: 'explicit', instructions: 'Perform only the specified isolated permission test. Do not inspect other files. Never work around a permission denial; stop immediately if denied.' },
          },
          toolPolicy: { kind: 'provider-default' },
        }).events) events.push(event);
        const failure = events.find(e => e.type === 'execution_error');
        if (attempt === 0 && !events.some(e => e.type === 'turn_started') && failure?.type === 'execution_error' && failure.message.includes('Eligibility check failed')) continue;
        return events;
      }
    };
    try {
      const ids: string[] = [];
      for (const name of ['vault-a', 'vault-b']) {
        const vault = join(root, name);
        await mkdir(vault);
        const target = join(vault, 'proof.txt');
        const session = createSession(vault);
        const readTarget = join(vault, 'read-proof.txt');
        const assertRead = async (reader: ProviderExecutionSession) => {
          const marker = randomUUID();
          await writeFile(readTarget, marker);
          const reads = await run(reader, `Use view_file to read exactly ${readTarget} and return its exact text. No shell commands, other tools or other files. Stop if denied.`);
          expect(reads.at(-1)).toMatchObject({ type: 'turn_completed' });
          expect(reads).toContainEqual(expect.objectContaining({ type: 'tool_started', name: 'view_file' }));
          expect(reads.flatMap(e => e.type === 'text_delta' ? [e.text] : []).join('')).toContain(marker);
        };
        await assertRead(session);
        const events = await run(session, `Use write_to_file to create exactly ${target} with text VAULT_CREATED. No shell commands. Reply DONE after writing.`);
        expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
        expect((await readFile(target, 'utf8')).trim()).toBe('VAULT_CREATED');
        const id = session.getSnapshot().providerSessionId;
        expect(id).toBeTruthy();
        ids.push(id!);
        await session.dispose();
        const resumed = createSession(vault, id);
        await assertRead(resumed);
        const editEvents = await run(resumed, `Use replace_file_content to replace VAULT_CREATED with VAULT_EDITED in exactly ${target}. No shell commands. Reply DONE after editing.`);
        expect(editEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
        expect((await readFile(target, 'utf8')).trim()).toBe('VAULT_EDITED');
        expect(resumed.getSnapshot().providerSessionId).toBe(id);
      }
      expect(ids[0]).not.toBe(ids[1]);

      const outside = join(root, 'outside.txt');
      const denied = await run(createSession(join(root, 'vault-a')), `Use write_to_file to create exactly ${outside} with text OUTSIDE_PROBE. Do not use another location or another tool. Stop if denied.`);
      expect(denied.at(-1)).toMatchObject({ type: 'execution_error' });
      expect(denied).toContainEqual(expect.objectContaining({ type: 'tool_completed', isError: true }));
      await expect(readFile(outside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const outsideRead = join(root, 'outside-read.txt');
      await writeFile(outsideRead, randomUUID());
      const readDenied = await run(createSession(join(root, 'vault-b')), `Use view_file to read exactly ${outsideRead}. Do not use another location or another tool. Stop if denied.`);
      expect(readDenied.at(-1)).toMatchObject({ type: 'execution_error' });
      expect(readDenied).toContainEqual(expect.objectContaining({ type: 'notice', message: expect.stringContaining('read_file') }));

      const command = await run(createSession(join(root, 'vault-b')), 'Use run_command to execute exactly: printf CLAUDIAN_COMMAND_PROBE. Do not use another tool or change any files. Stop if denied.');
      expect(command.at(-1)).toMatchObject({ type: 'execution_error' });
      expect(command).toContainEqual(expect.objectContaining({ type: 'notice', message: expect.stringContaining('command') }));
    } finally {
      await Promise.all(sessions.map(session => session.dispose()));
      await rm(root, { recursive: true, force: true });
    }
  }, 420_000);
});
