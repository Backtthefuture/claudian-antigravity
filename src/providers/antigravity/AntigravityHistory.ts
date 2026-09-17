import type { ProviderConversationHistoryService } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';

import { record } from './AntigravityProcess';

function decodeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const m = record(item);
    if (typeof m.id !== 'string' || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || typeof m.timestamp !== 'number') return [];
    return [{ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp,
      ...(typeof m.displayContent === 'string' ? { displayContent: m.displayContent } : {}),
    }];
  });
}

export const antigravityHistory: ProviderConversationHistoryService = {
  async hydrateConversationHistory(conversation) {
    if (conversation.messages.length === 0) conversation.messages = decodeMessages(conversation.providerState?.displayMessages);
  },
  resolveSessionIdForConversation: conversation => conversation?.sessionId ?? null,
  isPendingForkConversation: () => false,
  buildForkProviderState() { throw new Error('Antigravity conversation forks are not supported'); },
  buildPersistedProviderState: conversation => ({
    ...conversation.providerState,
    displayMessages: conversation.messages.length > 0 ? decodeMessages(conversation.messages) : decodeMessages(conversation.providerState?.displayMessages),
  }),
};
