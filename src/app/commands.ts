// Messages from the iframe UI to plugin.js.
import type { Plan } from '../core/plan';

export type Command = { readonly cmd: 'apply'; readonly plan: Plan };

export function isCommand(message: unknown): message is Command {
  if (typeof message !== 'object' || message === null) return false;
  const { cmd, plan } = message as { cmd?: unknown; plan?: unknown };
  if (cmd !== 'apply' || typeof plan !== 'object' || plan === null) return false;
  return Array.isArray((plan as { ops?: unknown }).ops);
}

export function setEntry(key: string, value: string): Plan {
  return { ops: [{ kind: 'set', key, value }] };
}
