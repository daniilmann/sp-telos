import type { EditorFacade, ReadSnapshot } from '../platform/facade';
// Messages from the iframe UI to plugin.js.
import {
  closeGoalRecord,
  createAnnualGoal,
  createKr,
  createObjective,
  reviseKr,
  updateAnnualGoal,
  updateKr,
  updateObjective,
  type GoalRecord,
  type GoalError,
  type Result,
} from '../core/goals';
import { buildPlan, classifyPlan, isPlan, type Plan, type PlanState } from '../core/plan';
import {
  decodeRecord,
  isObject,
  isUuid,
  splitRecord,
  WIPE_KEY,
  type StoredRecord,
} from '../core/records';
import type { Draft, DraftStore } from '../platform/draft-store';
import type { SaveStatus } from './save-status';

export type Command = {
  readonly cmd: 'apply';
  readonly plan: Plan;
  readonly requestId?: string;
  readonly forceSync?: true;
};
export type CompatibilityQuery = { readonly cmd: 'compatibility' };
export type ApplyingQuery = { readonly cmd: 'isApplying'; readonly requestId: string };

export function isCommand(message: unknown): message is Command {
  if (!isObject(message) || message.cmd !== 'apply' || !isPlan(message.plan)) return false;
  const keys = Object.keys(message);
  if (!keys.includes('cmd') || !keys.includes('plan')) return false;
  return (
    (!('requestId' in message) || (keys.includes('requestId') && isUuid(message.requestId))) &&
    (!('forceSync' in message) || (keys.includes('forceSync') && message.forceSync === true)) &&
    keys.every((key) => ['cmd', 'plan', 'requestId', 'forceSync'].includes(key))
  );
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

export type GoalFields = Readonly<Record<string, string>>;
export interface GoalIntent {
  readonly action: 'create' | 'edit' | 'close' | 'revise';
  readonly fields: GoalFields;
}

export function goalRecords(state: PlanState) {
  const records: Record<string, GoalRecord & { readonly ver: string }> = {};
  for (const [key, raw] of Object.entries(state.entries)) {
    const decoded = decodeRecord(key, raw);
    if (decoded.ok && 'kind' in decoded.value) records[key] = decoded.value;
  }
  return records;
}

export function recordAt(state: PlanState, key: string): StoredRecord | undefined {
  const decoded = decodeRecord(key, state.entries[key] ?? '');
  return decoded.ok ? decoded.value : undefined;
}

export function draftIntent(draft: Draft): GoalIntent | undefined {
  const { action, ...fields } = draft.fields;
  if (action !== 'create' && action !== 'edit' && action !== 'close' && action !== 'revise')
    return undefined;
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string') return undefined;
    strings[key] = value;
  }
  return { action, fields: strings };
}

export function recordIntent(record?: StoredRecord | GoalRecord): GoalIntent {
  if (!record || !('kind' in record)) return { action: 'create', fields: {} };
  const fields: Record<string, string> = { statement: record.statement };
  if (record.kind === 'objective') {
    fields.quarter = record.quarter;
    fields.annualGoalKey = record.annualGoalKey;
  }
  if (record.kind === 'kr') {
    fields.baseline = record.baseline;
    fields.dataSource = record.dataSource;
    fields.target = record.target;
    fields.objectiveKey = record.objectiveKey;
  }
  return { action: 'edit', fields };
}

export function transition(
  kind: string | undefined,
  current: StoredRecord | undefined,
  { action, fields }: GoalIntent,
  state: PlanState,
): Result<GoalRecord> | undefined {
  const record = current && 'kind' in current ? splitRecord(current).record : undefined;
  if (action === 'close') {
    if (record?.status !== 'active') return undefined;
    return closeGoalRecord(record, { outcome: fields.outcome ?? '', reason: fields.reason ?? '' });
  }
  const { statement = '', quarter = '', annualGoalKey = '', objectiveKey = '' } = fields;
  const { baseline = '', dataSource = '', target = '', revisionReason = '' } = fields;
  const kr = { statement, baseline, dataSource, target, objectiveKey };
  if (action === 'revise') {
    return record?.kind === 'kr' ? reviseKr(record, kr, revisionReason) : undefined;
  }
  if (action === 'create' ? current !== undefined : !record) return undefined;
  if (kind === 'annual-goal') {
    return record?.kind === kind
      ? updateAnnualGoal(record, { statement })
      : createAnnualGoal({ statement });
  }
  const parents = goalRecords(state);
  if (kind === 'objective') {
    const annualGoals = Object.fromEntries(
      Object.entries(parents).flatMap(([key, parent]) =>
        parent.kind === 'annual-goal' ? [[key, parent] as const] : [],
      ),
    );
    const objective = { statement, quarter, annualGoalKey };
    return record?.kind === kind
      ? updateObjective(record, objective, annualGoals)
      : createObjective(objective, annualGoals);
  }
  if (kind === 'kr') {
    const objectives = Object.fromEntries(
      Object.entries(parents).flatMap(([key, parent]) =>
        parent.kind === 'objective' ? [[key, parent] as const] : [],
      ),
    );
    return record?.kind === kind ? updateKr(record, kr, objectives) : createKr(kr, objectives);
  }
  return undefined;
}

export const absent = 'absent';
export type DraftChoice = 'keep-draft' | 'use-saved' | 'discard-draft' | 'restore-as-new';

export function draftChoices(
  record: StoredRecord | undefined,
  baseVer: string,
): DraftChoice[] | undefined {
  if ('deleted' in (record ?? {}) || (!record && baseVer !== absent))
    return ['discard-draft', 'restore-as-new'];
  if ((record?.ver ?? absent) !== baseVer) return ['keep-draft', 'use-saved'];
  return undefined;
}

interface PlanPreparation {
  readonly state: PlanState;
  readonly key: string;
  readonly baseVer: string;
  readonly intent: GoalIntent;
  readonly previousValue: string | undefined;
  readonly handoffVer: string | undefined;
  readonly at: number;
  readonly newId: () => string;
}

type Prepared =
  | { readonly plan: Plan; readonly write: Plan['writes'][number] }
  | { readonly choices: DraftChoice[]; readonly record: StoredRecord | undefined }
  | { readonly message: string; readonly errors: readonly GoalError[] };

export function prepareGoalPlan({
  state,
  key,
  baseVer,
  intent,
  previousValue,
  handoffVer,
  at,
  newId,
}: PlanPreparation): Prepared {
  const record = recordAt(state, key);
  const materialized =
    record &&
    'kind' in record &&
    (previousValue === state.entries[key] || record.ver === handoffVer);
  const choices = draftChoices(record, baseVer);
  if (choices && !materialized) return { choices, record };
  const effective =
    intent.action === 'create' && record ? ({ ...intent, action: 'edit' } as const) : intent;
  const next = materialized
    ? ({ ok: true, value: splitRecord(record).record } as const)
    : transition(key.split(':')[0], record, effective, state);
  if (!next?.ok)
    return { errors: next?.errors ?? [], message: 'Проверьте данные и действие формы.' };
  const origin = intent.action === 'revise' && !materialized ? 'kr-revision' : 'manual';
  const plan = buildPlan(origin, [{ key, record: next.value, base: record?.ver ?? absent }], {
    at,
    newId,
  });
  const [write] = plan.writes;
  if (!write || !classifyPlan(state, plan).ok) {
    return { errors: [], message: 'Не удалось подготовить план. Проверьте поля и размер записи.' };
  }
  return { plan, write };
}

export type LeaveChoice = 'retry' | 'stay' | 'discard';

export interface EditorView {
  readonly key: string;
  readonly baseVer: string;
  readonly intent: GoalIntent;
  readonly record?: StoredRecord | undefined;
  readonly errors: readonly GoalError[];
  readonly message?: string | undefined;
  readonly draftMessage?: string | undefined;
  readonly deadline?: string | undefined;
  readonly readOnly?: boolean;
  readonly ready?: boolean;
  readonly busy?: boolean;
  readonly status?: SaveStatus['state'] | undefined;
  readonly draftChoices?: readonly DraftChoice[] | undefined;
  readonly leaveChoices?: readonly LeaveChoice[] | undefined;
  readonly wipe?: { readonly ver: string; readonly count: number } | undefined;
}

export interface GoalDraft extends Draft {
  // This version was returned by our own handoff. It distinguishes a restored retry
  // from a fresh explicit transition such as a second revision with identical text.
  readonly handoffVer?: string | undefined;
}

interface DraftContext {
  readonly intent: GoalIntent | undefined;
  readonly baseVer: string;
  readonly draftChoices: DraftChoice[] | undefined;
  readonly draftMessage: string | undefined;
  readonly wipe: EditorView['wipe'];
  readonly handoffVer: string | undefined;
}

async function readDraftContext(
  drafts: DraftStore,
  state: PlanState,
  key: string,
): Promise<DraftContext> {
  const [local, listed, handled] = await Promise.all([
    drafts.read(key),
    drafts.list(),
    drafts.readWipeVersion().catch(() => undefined),
  ]);
  const record = recordAt(state, key);
  const restored = local.value && {
    intent: draftIntent(local.value),
    baseVer: local.value.baseVer,
  };
  const intent = restored?.intent;
  const baseVer = restored?.intent ? restored.baseVer : (record?.ver ?? absent);
  const wipeVer = recordAt(state, WIPE_KEY)?.ver;
  const handoff = local.value && 'handoffVer' in local.value ? local.value.handoffVer : undefined;
  return {
    intent,
    baseVer,
    handoffVer: handoff === baseVer ? baseVer : undefined,
    draftChoices: intent ? draftChoices(record, baseVer) : undefined,
    draftMessage: local.failed || listed.failed ? 'Не удалось прочитать черновики' : undefined,
    wipe:
      wipeVer && wipeVer !== handled && listed.keys.length
        ? { ver: wipeVer, count: listed.keys.length }
        : undefined,
  };
}

export interface GoalEditorDependencies {
  readonly facade: EditorFacade;
  readonly drafts: DraftStore;
  readonly now: () => number;
  readonly newId: () => string;
  readonly onChange?: () => void;
  readonly onRead?: (snapshot: ReadSnapshot) => void;
}

export interface Submission {
  readonly write: Plan['writes'][number];
  readonly generation: number;
}

export const draftError = 'Черновик на этом устройстве не сохраняется';
export const changed = 'Изменено';
export const updatedInput = {
  errors: [],
  status: 'changed',
  message: changed,
  leaveChoices: undefined,
  deadline: undefined,
} as const;

export async function readEditor(facade: EditorFacade, drafts: DraftStore, key: string) {
  const snapshot = await facade.read([key, WIPE_KEY]);
  const { intent, handoffVer, ...local } = await readDraftContext(drafts, snapshot, key);
  const record = recordAt(snapshot, key);
  const view: Partial<EditorView> = {
    ...local,
    record,
    ready: true,
    readOnly: Boolean(snapshot.readOnlyReason),
    intent: intent ?? recordIntent(record),
    status: intent ? 'changed' : undefined,
    message: snapshot.readOnlyReason ?? (intent ? changed : undefined),
  };
  return { snapshot, view, handoffVer, dirty: intent !== undefined };
}

export function afterWipe(
  view: EditorView,
  handled: boolean,
  discard: boolean,
): Partial<EditorView> {
  const status = {
    busy: false,
    wipe: handled ? undefined : view.wipe,
    draftMessage: handled ? undefined : draftError,
  };
  if (!handled || !discard) return status;
  return {
    ...status,
    ...afterDraftDiscard(view.record),
  };
}

export function afterDraftDiscard(record?: StoredRecord): Partial<EditorView> {
  return {
    intent: recordIntent(record),
    baseVer: record?.ver ?? absent,
    draftChoices: undefined,
    status: undefined,
    message: undefined,
  };
}

export function applyHandoffToSnapshot(
  snapshot: ReadSnapshot,
  { key, value }: Submission['write'],
) {
  return { ...snapshot, entries: { ...snapshot.entries, [key]: value } };
}

export const leaveFailed = {
  message: 'Черновик не сохранён на этом устройстве',
  leaveChoices: ['retry', 'stay', 'discard'],
} as const;

export const failedRemoval = 'Черновик не удалён';
export const removalMessages = {
  removed: undefined,
  skipped: undefined,
  'write-failed': draftError,
  'remove-failed': failedRemoval,
};
