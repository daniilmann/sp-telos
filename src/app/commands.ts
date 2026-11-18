// Messages from the iframe UI to plugin.js.
import { isPlan, type Plan } from '../core/plan';

export type Command = { readonly cmd: 'apply'; readonly plan: Plan };

export function isCommand(message: unknown): message is Command {
  return (
    typeof message === 'object' &&
    message !== null &&
    'cmd' in message &&
    message.cmd === 'apply' &&
    'plan' in message &&
    isPlan(message.plan)
  );
}
