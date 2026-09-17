import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { AntigravityExecutionBackend } from '@/providers/antigravity/AntigravityExecutionBackend';

const live = process.env.CLAUDIAN_AGY_LIVE_TEST === '1' ? describe : describe.skip;

live('Antigravity live CLI', () => {
  it('keeps two real native sessions isolated across backend recreation', async () => {
    const cwd = process.env.CLAUDIAN_AGY_TEST_VAULT;
    const cli = process.env.CLAUDIAN_AGY_TEST_CLI;
    if (!cwd || !cli) throw new Error('Set CLAUDIAN_AGY_TEST_VAULT and CLAUDIAN_AGY_TEST_CLI explicitly');
    const host = {
      settings: {}, getResolvedProviderCliPath: async () => cli,
      getActiveEnvironmentVariables: () => process.env.CLAUDIAN_AGY_TEST_ENV ?? '',
    } as unknown as ProviderHost;
    const backend = new AntigravityExecutionBackend(host);
    const config = (id?: string): ProviderSessionConfig => ({
      vaultWorkingDirectory: cwd, lifecycle: 'persistent', nativePersistence: 'enabled',
      interactionPort: {} as ProviderSessionConfig['interactionPort'],
      resumeSeed: id ? { providerSessionId: id } : undefined,
    });
    const request = (text: string): ProviderExecutionRequest => ({
      input: [{ type: 'text', text }], signal: new AbortController().signal,
      configuration: { model: 'antigravity:gemini-3.8-flash-medium', systemInstructions: { kind: 'explicit', instructions: 'Answer the test question only. Do not use tools or read any files.' } },
      toolPolicy: { kind: 'provider-default' },
    });
    const run = async (id: string | undefined, prompt: string) => {
      const session = backend.createSession(config(id));
      const events: ProviderExecutionEvent[] = [];
      try {
        for await (const event of session.execute(request(prompt)).events) events.push(event);
        const failure = events.find(event => event.type === 'execution_error');
        if (failure?.type === 'execution_error') throw new Error(failure.message);
        expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
        return { id: session.getSnapshot().providerSessionId, text: events.flatMap(e => e.type === 'text_delta' ? [e.text] : []).join('') };
      } finally { await session.dispose(); }
    };
    const a = await run(undefined, 'Remember my fictional code ORBIT-417. Reply only ORBIT-417.');
    const b = await run(undefined, 'Remember my fictional code PINE-829. Reply only PINE-829.');
    expect(a.text).toContain('ORBIT-417');
    expect(b.text).toContain('PINE-829');
    expect(a.id).toBeTruthy();
    expect(b.id).not.toBe(a.id);
    expect((await run(a.id, 'What was my fictional code? Reply only the code.')).text).toContain('ORBIT-417');
    expect((await run(b.id, 'What was my fictional code? Reply only the code.')).text).toContain('PINE-829');
  }, 240_000);
});
