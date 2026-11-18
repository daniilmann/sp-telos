// Messages from the iframe UI to plugin.js.
import { isPlan, type Plan } from '../core/plan';
import { isObject } from '../core/records';

export type Command = { readonly cmd: 'apply'; readonly plan: Plan };
export type CompatibilityQuery = { readonly cmd: 'compatibility' };

export function isCommand(message: unknown): message is Command {
  return (
    isObject(message) &&
    Object.keys(message).length === 2 &&
    message.cmd === 'apply' &&
    isPlan(message.plan)
  );
}

export function isCompatibilityQuery(message: unknown): message is CompatibilityQuery {
  return isObject(message) && Object.keys(message).length === 1 && message.cmd === 'compatibility';
}
