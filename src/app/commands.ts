// Messages from the iframe UI to plugin.js.
import { isPlan, type Plan } from '../core/plan';
import { isObject, isUuid } from '../core/records';

export type Command = {
  readonly cmd: 'apply';
  readonly plan: Plan;
  readonly requestId?: string;
};
export type CompatibilityQuery = { readonly cmd: 'compatibility' };
export type ApplyingQuery = { readonly cmd: 'isApplying'; readonly requestId: string };

export function isCommand(message: unknown): message is Command {
  if (!isObject(message) || message.cmd !== 'apply' || !isPlan(message.plan)) return false;
  const keys = Object.keys(message);
  if (!keys.includes('cmd') || !keys.includes('plan')) return false;
  if (keys.includes('requestId')) return keys.length === 3 && isUuid(message.requestId);
  return keys.length === 2 && !('requestId' in message);
}

export function isApplyingQuery(message: unknown): message is ApplyingQuery {
  if (!isObject(message) || message.cmd !== 'isApplying' || !isUuid(message.requestId))
    return false;
  const keys = Object.keys(message);
  return keys.length === 2 && keys.includes('cmd') && keys.includes('requestId');
}

export function isCompatibilityQuery(message: unknown): message is CompatibilityQuery {
  return isObject(message) && Object.keys(message).length === 1 && message.cmd === 'compatibility';
}
