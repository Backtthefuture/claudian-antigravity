import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import type { ProviderExecutionBackend, ProviderExecutionEvent, ProviderExecutionRequest, ProviderExecutionRun, ProviderExecutionSession, ProviderSessionConfig, ProviderSessionEvent, ProviderSessionSnapshot, ProviderSessionStatus } from '@/core/execution';
import type { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';
import { buildSystemPrompt } from '@/core/prompt/mainAgent';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { appendBrowserContext } from '@/utils/browser';
import { appendCanvasContext } from '@/utils/canvas';
import { appendLinkedContent } from '@/utils/context';
import { appendEditorContext } from '@/utils/editor';

import { createAntigravityProcess, record, string } from './AntigravityProcess';

type EventPayload = ProviderExecutionEvent extends infer E ? E extends ProviderExecutionEvent ? Omit<E, 'scope'> : never : never;

export class AntigravityExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'antigravity';
  constructor(private readonly host: ProviderHost) {}
  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new AntigravityExecutionSession(this.host, config);
  }
}

class AntigravityExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'antigravity';
  readonly sessionInstanceId = randomUUID();
  private nativeId?: string;
  private status: Exclude<ProviderSessionStatus, 'invalidated'> = 'idle';
  private revision = 0;
  private active?: { controller: AbortController; proc?: ManagedStdioProcess };

  constructor(private readonly host: ProviderHost, private readonly config: ProviderSessionConfig) {
    this.nativeId = config.resumeSeed?.providerSessionId;
  }
  getStatus(): ProviderSessionStatus { return this.status; }
  getSnapshot(): ProviderSessionSnapshot {
    return { providerId: this.providerId, revision: this.revision, status: this.status, providerSessionId: this.nativeId };
  }
  onEvent(_listener: (event: ProviderSessionEvent) => void): () => void { return () => {}; }
  cancel(): void {
    if (!this.active) return;
    this.status = 'cancelling';
    this.active.controller.abort();
    void this.active.proc?.shutdown();
  }
  async dispose(): Promise<void> {
    this.cancel();
    this.status = 'disposed';
    await this.active?.proc?.shutdown();
  }
  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.status !== 'idle') throw new Error(`Cannot execute a ${this.status} Antigravity session`);
    const executionId = randomUUID();
    const turnId = randomUUID();
    const active = { controller: new AbortController(), proc: undefined as ManagedStdioProcess | undefined };
    this.active = active;
    this.status = 'executing';
    const cancel = () => { if (this.active === active) this.cancel(); };
    return { executionId, turnId, events: this.run(request, active, executionId, turnId), cancel };
  }
  private async *run(request: ProviderExecutionRequest, active: NonNullable<AntigravityExecutionSession['active']>, executionId: string, turnId: string): AsyncGenerator<ProviderExecutionEvent> {
    let sequence = 0;
    const event = (payload: EventPayload): ProviderExecutionEvent => ({ ...payload, scope: { kind: 'requested', sessionInstanceId: this.sessionInstanceId, executionId, turnId, sequence: ++sequence } });
    const abort = () => { active.controller.abort(); void active.proc?.shutdown(); };
    request.signal.addEventListener('abort', abort, { once: true });
    let terminal: EventPayload = { type: 'execution_error', category: 'transport', message: 'Antigravity ended without a result', recoverable: true };
    try {
      if (request.signal.aborted || active.controller.signal.aborted) throw new Error('Cancelled');
      if (request.toolPolicy.kind !== 'provider-default') throw new Error(`Antigravity does not support the ${request.toolPolicy.kind} tool policy in headless mode`);
      if (request.input.some(block => block.type === 'image')) throw new Error('Antigravity image attachments are not supported');
      const model = request.configuration.model;
      if (!model?.startsWith('antigravity:') || !model.slice(12)) throw new Error('Select an enabled Antigravity model first');
      // In agy 1.2.4, cwd alone does not grant native read access to the vault.
      const args = ['-p', buildPrompt(request, this.host, this.config.vaultWorkingDirectory), '--output-format', 'stream-json', '--model', model.slice(12), '--mode', 'accept-edits', '--add-dir', this.config.vaultWorkingDirectory];
      if (this.nativeId) args.push('--conversation', this.nativeId);
      active.proc = await createAntigravityProcess(this.host, this.config.vaultWorkingDirectory, args);
      if (request.signal.aborted || active.controller.signal.aborted) throw new Error('Cancelled');
      const proc = active.proc;
      let processError: Error | undefined;
      proc.onError(error => { processError = error; });
      proc.start();
      proc.stdin.end();
      const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
      let accepted = false;
      let assistantStarted = false;
      let emittedText = '';
      const tools = new Set<string>();
      for await (const line of lines) {
        if (active.controller.signal.aborted) break;
        if (!line.trim()) continue;
        const raw = record(JSON.parse(line));
        const result = raw.event === 'result' ? record(raw.result) : raw.status ? raw : null;
        const id = string(raw.conversation_id) || string(result?.conversation_id);
        if (id) {
          if (this.nativeId && id !== this.nativeId) throw new Error('Antigravity returned a different conversation ID; refusing to attach it');
          this.nativeId = id;
          this.revision++;
          yield event({ type: 'session_state_changed', snapshot: this.getSnapshot() });
        }
        if (!accepted && (raw.event === 'init' || raw.event === 'step_update' || result?.status === 'SUCCESS')) {
          accepted = true;
          yield event({ type: 'turn_started', accepted: true });
        }
        if (raw.event === 'step_update') {
          const step = record(raw.step_update);
          const delta = string(step.text_delta);
          if (delta && step.step_type === 'agent_response') {
            if (!assistantStarted) { assistantStarted = true; yield event({ type: 'assistant_message_started' }); }
            emittedText += delta;
            yield event({ type: 'text_delta', text: delta });
          }
          if (step.step_type === 'tool') {
            const info = record(step.tool_info);
            const toolCallId = `agy-${step.step_index}`;
            const identity = { toolCallId, toolScope: { kind: 'main' as const } };
            if (!tools.has(toolCallId)) {
              tools.add(toolCallId);
              yield event({ type: 'tool_started', ...identity, name: string(info.name) || string(step.tool_name) || 'tool', input: record(info.parameters) });
            }
            if (step.state === 'DONE' || step.state === 'ERROR') {
              const error = record(info.error);
              yield event({ type: 'tool_completed', ...identity, content: string(info.output) || string(error.message), isError: step.state === 'ERROR' || !!info.error });
            }
          }
        }
        if (result) {
          const response = string(result.response);
          if (!emittedText && response) {
            if (!assistantStarted) yield event({ type: 'assistant_message_started' });
            yield event({ type: 'text_delta', text: response });
          }
          const denied = result.denied_actions;
          const hasDenied = Array.isArray(denied) ? denied.length > 0 : !!denied;
          if (hasDenied) yield event({ type: 'notice', level: 'warning', message: `Antigravity denied actions: ${JSON.stringify(denied)}. Review the CLI permission rules.` });
          terminal = result.status === 'SUCCESS' && !hasDenied
            ? { type: 'turn_completed', reason: 'completed' }
            : { type: 'execution_error', category: 'provider', recoverable: true, message: string(result.error) || (hasDenied ? 'Some requested actions were denied by Antigravity permissions.' : `Antigravity status: ${result.status}`) };
          break;
        }
      }
      if (processError) throw processError;
      const diagnostic = proc.getStderrSnapshot();
      if (diagnostic && !active.controller.signal.aborted) yield event({ type: 'notice', level: 'warning', message: diagnostic });
      if (diagnostic && terminal.type === 'execution_error' && terminal.category === 'transport') {
        terminal = { ...terminal, category: 'process-exited', message: diagnostic };
      }
    } catch (error) {
      terminal = { type: 'execution_error', category: 'provider', message: error instanceof Error ? error.message : String(error), recoverable: true };
    } finally {
      request.signal.removeEventListener('abort', abort);
      await active.proc?.shutdown();
      if (this.active === active) {
        this.active = undefined;
        if (this.status !== 'disposed') this.status = 'idle';
      }
    }
    if (active.controller.signal.aborted || request.signal.aborted) terminal = { type: 'cancelled' };
    yield event(terminal);
  }
}

function buildPrompt(request: ProviderExecutionRequest, host: ProviderHost, vaultPath: string): string {
  let text = request.input.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n');
  const context = request.context;
  if (context?.linkedContent?.path) text = appendLinkedContent(text, context.linkedContent.path);
  if (context?.editorSelection) text = appendEditorContext(text, context.editorSelection);
  if (context?.browserSelection) text = appendBrowserContext(text, context.browserSelection);
  if (context?.canvasSelection) text = appendCanvasContext(text, context.canvasSelection);
  const instructions = request.configuration.systemInstructions;
  const system = instructions.kind === 'explicit' ? instructions.instructions : buildSystemPrompt({
    vaultPath, customPrompt: host.settings.systemPrompt, mediaFolder: host.settings.mediaFolder, userName: host.settings.userName,
  }, { dynamicSections: instructions.dynamicSections ? [...instructions.dynamicSections] : undefined });
  return `${text}\n\n<claudian_application_context>\n${system}\n</claudian_application_context>`;
}
