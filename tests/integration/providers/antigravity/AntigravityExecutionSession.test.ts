import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderSessionConfig } from '@/core/execution';
import { buildSystemPrompt } from '@/core/prompt/mainAgent';
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
if (prompt.startsWith('capture-prompt')) { emit({event:'result',result:{status:'SUCCESS',conversation_id:id,response:prompt}}); process.exit(0); }
if (prompt.startsWith('network-error')) { process.stderr.write('Eligibility check failed: EOF'); process.exit(1); }
if (prompt.startsWith('rejected')) { emit({event:'result',result:{status:'ERROR',error:'Unknown model'}}); process.exit(1); }
if (prompt.startsWith('mismatch')) { emit({event:'init',conversation_id:'unexpected-session'}); process.exit(0); }
emit({event:'init', conversation_id:id});
if (prompt.startsWith('wait')) {
  process.on('SIGTERM', () => { process.stderr.write('error: interrupted'); process.exit(1); });
  setInterval(() => {}, 1000);
}
else if (prompt.startsWith('denied')) {
  emit({event:'step_update',step_update:{step_index:2,state:'ERROR',step_type:'tool',tool_info:{name:'write_to_file',error:{type:'TOOL_ERROR',message:'permission check failed for write_file'}}}});
  emit({event:'result',result:{status:'SUCCESS',conversation_id:id,response:'',denied_actions:[{action:'write_file',display_name:'WriteToFile'}]}});
} else if (prompt.startsWith('read-in-vault')) {
  if (!a.includes('--add-dir') || require('node:fs').realpathSync(a[a.indexOf('--add-dir') + 1]) !== process.cwd()) {
    emit({event:'result',result:{status:'SUCCESS',conversation_id:id,response:'',denied_actions:[{action:'read_file',display_name:'ViewFile'}]}});
  } else {
    const response = require('node:fs').readFileSync(require('node:path').join(process.cwd(), 'read-proof.txt'), 'utf8');
    emit({event:'result',result:{status:'SUCCESS',conversation_id:id,response}});
  }
} else if (prompt.startsWith('write-in-vault')) {
  if (a[a.indexOf('--mode') + 1] !== 'accept-edits') {
    emit({event:'result',result:{status:'SUCCESS',conversation_id:id,response:'',denied_actions:[{action:'write_file',display_name:'WriteToFile'}]}});
  } else {
    require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'write-proof.txt'), 'VAULT_WRITE_OK');
    emit({event:'result',result:{status:'SUCCESS',conversation_id:id,response:'Written'}});
  }
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
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_completed', isError: true, content: 'permission check failed for write_file' }));
    await session.dispose();
  });

  it('supplies fresh host time and native tool limits while preserving the complete shared prompt', async () => {
    host.settings.systemPrompt = 'Keep my custom instructions.';
    const session = backend.createSession(config());
    const query = request('capture-prompt');
    const events = await collect(session.execute({
      ...query,
      configuration: { ...query.configuration, systemInstructions: { kind: 'provider-default', dynamicSections: ['Keep the dynamic section.'] } },
    }).events);
    const text = events.flatMap(e => e.type === 'text_delta' ? [e.text] : []).join('');
    expect(text).toContain(buildSystemPrompt({ vaultPath: root, customPrompt: 'Keep my custom instructions.' }, { dynamicSections: ['Keep the dynamic section.'] }));
    expect(text).toMatch(/Host current time: \d{4}-\d{2}-\d{2}T/);
    expect(text).toContain('Interactive approvals are unavailable');
    expect(text).toContain('find_by_name');
    expect(text).toContain('grep_search');
    await session.dispose();
  });

  it('allows native file edits in each session vault, including resumed conversations', async () => {
    const secondVault = await mkdtemp(join(root, 'second-vault-'));
    for (const vaultWorkingDirectory of [root, secondVault]) {
      const session = backend.createSession({ ...config('saved-session'), vaultWorkingDirectory });
      const events = await collect(session.execute(request('write-in-vault')).events);
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(await readFile(join(vaultWorkingDirectory, 'write-proof.txt'), 'utf8')).toBe('VAULT_WRITE_OK');
      expect(session.getSnapshot().providerSessionId).toBe('saved-session');
      await session.dispose();
    }
  });

  it('reads each explicitly registered vault in fresh and restored native conversations', async () => {
    const secondVault = await mkdtemp(join(root, 'second-vault-'));
    for (const [index, vaultWorkingDirectory] of [root, secondVault].entries()) {
      await writeFile(join(vaultWorkingDirectory, 'read-proof.txt'), `VAULT_READ_${index}`);
      for (const id of [undefined, 'saved-session']) {
        const session = backend.createSession({ ...config(id), vaultWorkingDirectory });
        const events = await collect(session.execute(request('read-in-vault')).events);
        expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
        expect(events.flatMap(e => e.type === 'text_delta' ? [e.text] : []).join('')).toBe(`VAULT_READ_${index}`);
        expect(session.getSnapshot().providerSessionId).toBe(id ?? 'new-session');
        await session.dispose();
      }
    }
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
