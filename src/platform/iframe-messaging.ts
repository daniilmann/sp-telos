// Iframe side of the PLUGIN_MESSAGE bridge to plugin.js.
import type { Command } from '../app/commands';

const TIMEOUT_MS = 30000;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface Reply {
  readonly type?: unknown;
  readonly messageId?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

let seq = 0;
const pending = new Map<string, Pending>();

window.addEventListener('message', (event: MessageEvent<Reply | null>) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (data === null || typeof data.messageId !== 'string') return;
  const waiter = pending.get(data.messageId);
  if (!waiter) return;
  if (data.type === 'PLUGIN_MESSAGE_RESPONSE') {
    pending.delete(data.messageId);
    waiter.resolve(data.result);
  } else if (data.type === 'PLUGIN_MESSAGE_ERROR') {
    pending.delete(data.messageId);
    waiter.reject(new Error(String(data.error)));
  }
});

export function send(message: Command): Promise<unknown> {
  return new Promise((resolve, reject) => {
    seq += 1;
    const messageId = `sp-telos-${String(seq)}`;
    pending.set(messageId, { resolve, reject });
    window.parent.postMessage({ type: 'PLUGIN_MESSAGE', messageId, message }, '*');
    setTimeout(() => {
      if (pending.delete(messageId)) reject(new Error('No reply from plugin.js; state unknown.'));
    }, TIMEOUT_MS);
  });
}
