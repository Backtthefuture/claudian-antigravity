import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { AntigravityExecutionBackend } from '@/providers/antigravity/AntigravityExecutionBackend';

describe('Antigravity native process boundary', () => {
  let root: string;
  let host: ProviderHost;
  let backend: AntigravityExecutionBackend;
  const request = (text: string): ProviderExecutionRequest => ({
    input: [{ type: 'text', text }],
    configuration: { model: 'antigravity:test-model', systemInstructions: { kind: 'explicit', instructions: 'Test instruction' } },
    toolPolicy: { kind: 'provider-default' },
    signal: new AbortController().signal,
  });
  const config = (id?: string): ProviderSessionConfig => ({
    lifecycle: 'persistent', nativePersistence: 'enabled', vaultWorkingDirectory: root,
    interactionPort: {} as ProviderSessionConfig['interactionPort'],
    resumeSeed: id ? { providerSessionId: id } : undefined,
  });
  const collect = async (events: AsyncIterable<ProviderExecutionEvent>) => {
    const result: ProviderExecutionEvent[] = [];
    for await (const event of events) result.push(event);
    return result;
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agy-contract-'));
    const cli = join(root, 'agy');
    await writeFile(cli, `#!${process.execPath}
const a = process.argv.slice(2);
const prompt = a[a.indexOf('-p') + 1];
const id = a.includes('--conversation') ? a[a.indexOf('--conversation') + 1] : 'new-session';
const emit = x => process.stdout.write(JSON.stringify(x) + '\\n');
if (a.includes('--continue') || a.includes('--dangerously-skip-permissions')) process.exit(9);
if (prompt.startsWith('network-error')) { process.stderr.write('Eligibility check failed: EOF'); process.exit(1); }
if (prompt.startsWith('rejected')) { emit({event:'result',result:{status:'ERROR',error:'Unknown model'}}); process.exit(1); }
if (prompt.startsWith('mismatch')) { emit({event:'init',conversation_id:'unexpected-session'}); process.exit(0); }
emit({event:'init', conversation_id:id});
if (prompt.startsWith('wait')) {
  process.on('SIGTERM', () => { process.stderr.write('error: interrupted'); process.exit(1); });
  setInterval(() => {}, 1000);
}
else if (prompt.startsWith('denied')) {
  emit({event:'result',result:{status:'SUCCESS',conversation_id:id,response:'',denied_actions:[{action:'command',target:'git'}]}});
} else {
  emit({event:'step_update',step_update:{step_index:1,state:'ACTIVE',step_type:'agent_response',text_delta:'Hello '}});
  emit({event:'step_update',step_update:{step_index:1,state:'DONE',step_type:'agent_response',text_delta:id}});
  emit({event:'result',result:{status:'SUCCESS',conversation_id:id,response:'Hello '+id}});
}
`);
    await chmod(cli, 0o755);
    host = {
      settings: {}, getResolvedProviderCliPath: async () => cli,
      getActiveEnvironmentVariables: () => '',
    } as unknown as ProviderHost;
    backend = new AntigravityExecutionBackend(host);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('streams once and resumes two independent native conversations', async () => {
    const a = backend.createSession(config('session-a'));
    const b = backend.createSession(config('session-b'));
    const [ea, eb] = await Promise.all([collect(a.execute(request('hi')).events), collect(b.execute(request('hi')).events)]);
    const text = (events: ProviderExecutionEvent[]) => events.flatMap(e => e.type === 'text_delta' ? [e.text] : []).join('');
    expect(text(ea)).toBe('Hello session-a');
    expect(text(eb)).toBe('Hello session-b');
    expect(ea.filter(e => e.type === 'turn_completed')).toHaveLength(1);
    expect(a.getSnapshot().providerSessionId).toBe('session-a');
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('reports denied actions even when the CLI exits successfully', async () => {
    const session = backend.createSession(config());
    const events = await collect(session.execute(request('denied')).events);
    expect(events.some(e => e.type === 'notice' && /denied/i.test(e.message))).toBe(true);
    expect(events.at(-1)?.type).toBe('execution_error');
    await session.dispose();
  });

  it('preserves a native startup error when no JSON result is produced', async () => {
    const session = backend.createSession(config());
    const events = await collect(session.execute(request('network-error')).events);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: 'Eligibility check failed: EOF' });
    expect(events.some(e => e.type === 'turn_started')).toBe(false);
    await session.dispose();
  });

  it('stops a running subprocess and emits one cancellation', async () => {
    const session = backend.createSession(config());
    const run = session.execute(request('wait'));
    const events: ProviderExecutionEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'turn_started') run.cancel();
    }
    expect(events.filter(e => e.type === 'cancelled')).toHaveLength(1);
    expect(events.some(e => e.type === 'notice')).toBe(false);
    expect(session.getStatus()).toBe('idle');
    await session.dispose();
  });

  it('does not accept a prompt rejected before the native turn starts', async () => {
    const session = backend.createSession(config());
    const events = await collect(session.execute(request('rejected')).events);
    expect(events.some(e => e.type === 'turn_started')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: 'Unknown model' });
    await session.dispose();
  });

  it('refuses to attach an unexpected native conversation', async () => {
    const session = backend.createSession(config('original-session'));
    const events = await collect(session.execute(request('mismatch')).events);
    expect(events.at(-1)?.type).toBe('execution_error');
    expect(session.getSnapshot().providerSessionId).toBe('original-session');
    await session.dispose();
  });

  it('releases a running process when the consumer leaves the stream early', async () => {
    const session = backend.createSession(config());
    for await (const event of session.execute(request('wait')).events) {
      if (event.type === 'turn_started') break;
    }
    expect(session.getStatus()).toBe('idle');
    expect((await collect(session.execute(request('hi')).events)).at(-1)?.type).toBe('turn_completed');
    await session.dispose();
  });
});
