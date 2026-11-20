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
  canonicalJson,
  decodeRecord,
  isObject,
  isUuid,
  KR_VALUE_PREFIX,
  MODEL_VERSION,
  splitRecord,
  type RecordInput,
  type StoredGoalRecord,
  type StoredRecord,
} from '../core/records';
import type { Draft, DraftStore } from '../platform/draft-store';
import type { SaveStatus } from './save-status';
import { sourceField, stringField } from './linked-editor-intent';

export const EDIT_INTERVAL_MS = 2000;

export interface KrValuePreconditions {
  readonly expectedWipe: string;
  readonly byteCheck: 'allow-absent' | 'require-exact';
}

export type ApplyOptions = {
  readonly forceSync?: true;
  readonly paceEditing?: true;
} & (KrValuePreconditions | { readonly expectedWipe?: never; readonly byteCheck?: never });

export type Command = {
  readonly cmd: 'apply';
  readonly plan: Plan;
  readonly requestId?: string;
} & ApplyOptions;
export type CompatibilityQuery = { readonly cmd: 'compatibility' };
export type ApplyingQuery = { readonly cmd: 'isApplying'; readonly requestId: string };

export function includesKrValueWrite(plan: Plan): boolean {
  return plan.writes.some(({ key }) => key.startsWith(KR_VALUE_PREFIX));
}

export function krValueWrite(plan: Plan) {
  const [write] = plan.writes;
  if (
    plan.v !== MODEL_VERSION ||
    plan.origin !== 'manual' ||
    plan.writes.length !== 1 ||
    write?.base !== 'absent'
  )
    return undefined;

  const decoded = decodeRecord(write.key, write.value);
  if (!decoded.ok || !('kind' in decoded.value) || decoded.value.kind !== 'kr-value')
    return undefined;
  return write.value === canonicalJson(decoded.value)
    ? { ...write, krKey: decoded.value.krKey }
    : undefined;
}

export function isKrValuePreconditions(value: unknown): value is KrValuePreconditions {
  return (
    isObject(value) &&
    (value.expectedWipe === 'absent' || isUuid(value.expectedWipe)) &&
    (value.byteCheck === 'allow-absent' || value.byteCheck === 'require-exact')
  );
}

export function isCommand(message: unknown): message is Command {
  if (!isObject(message) || message.cmd !== 'apply' || !isPlan(message.plan)) return false;
  const keys = Object.keys(message);
  if (!keys.includes('cmd') || !keys.includes('plan')) return false;
  const allowed = ['cmd', 'plan', 'requestId', 'forceSync', 'paceEditing'];
  if (includesKrValueWrite(message.plan)) {
    if (
      !keys.includes('expectedWipe') ||
      !keys.includes('byteCheck') ||
      !isKrValuePreconditions(message) ||
      !krValueWrite(message.plan)
    )
      return false;
    allowed.push('expectedWipe', 'byteCheck');
  }
  return (
    (!('requestId' in message) || (keys.includes('requestId') && isUuid(message.requestId))) &&
    (!('forceSync' in message) || (keys.includes('forceSync') && message.forceSync === true)) &&
    (!('paceEditing' in message) ||
      (keys.includes('paceEditing') && message.paceEditing === true)) &&
    keys.every((key) => allowed.includes(key))
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

export interface GoalIntent {
  readonly action: 'create' | 'edit' | 'close' | 'revise';
  readonly fields: Readonly<Record<string, unknown>>;
}

type EditorRecord = Exclude<StoredRecord, { kind: 'kr-value' }>;

function isGoalEditorRecord(record: EditorRecord): record is StoredGoalRecord {
  return !('kind' in record) || (record.kind !== 'initiative' && record.kind !== 'task-meta');
}

export function goalRecords(state: PlanState) {
  const records: Record<string, GoalRecord & { readonly ver: string }> = {};
  for (const key of Object.keys(state.entries)) {
    const record = recordAt(state, key);
    if (record && 'kind' in record) records[key] = record;
  }
  return records;
}

export function recordAt(state: PlanState, key: string): StoredGoalRecord | undefined {
  const record = editorRecordAt(state, key);
  return record && isGoalEditorRecord(record) ? record : undefined;
}

export function editorRecordAt(state: PlanState, key: string): EditorRecord | undefined;
export function editorRecordAt<Kind extends 'initiative' | 'task-meta'>(
  state: PlanState,
  key: string,
  kind: Kind,
): Extract<StoredRecord, { kind: Kind }> | undefined;
export function editorRecordAt(state: PlanState, key: string, kind?: 'initiative' | 'task-meta') {
  if (key.startsWith(KR_VALUE_PREFIX)) return undefined;
  const decoded = decodeRecord(key, state.entries[key] ?? '');
  if (!decoded.ok) return undefined;
  const record = decoded.value;
  if ('kind' in record && record.kind === 'kr-value') return undefined;
  return kind === undefined || ('kind' in record && record.kind === kind) ? record : undefined;
}

export function isGoalAction(action: unknown): action is GoalIntent['action'] {
  return action === 'create' || action === 'edit' || action === 'close' || action === 'revise';
}

export function draftIntent(draft: Draft): GoalIntent | undefined {
  const { action, ...fields } = draft.fields;
  if (!isGoalAction(action)) return undefined;
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'sphereTagKey' && value === null) continue;
    if (typeof value !== 'string') return undefined;
    strings[key] = value;
  }
  return {
    action,
    fields: { ...strings, ...(fields.sphereTagKey === null && { sphereTagKey: null }) },
  };
}

export function recordIntent(record?: StoredGoalRecord | GoalRecord): GoalIntent {
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
  current: StoredGoalRecord | undefined,
  { action, fields }: GoalIntent,
  state: PlanState,
): Result<GoalRecord> | undefined {
  const record = current && 'kind' in current ? splitRecord(current).record : undefined;
  if (action === 'close') {
    if (record?.status !== 'active') return undefined;
    return closeGoalRecord(record, {
      outcome: stringField(fields, 'outcome') ?? '',
      reason: stringField(fields, 'reason') ?? '',
    });
  }
  const values = action === 'edit' ? { ...recordIntent(record).fields, ...fields } : fields;
  const get = (name: string) => stringField(values, name) ?? '';
  const statement = get('statement');
  const kr = {
    statement,
    baseline: get('baseline'),
    dataSource: get('dataSource'),
    target: get('target'),
    objectiveKey: get('objectiveKey'),
  };
  if (action === 'revise') {
    return record?.kind === 'kr' ? reviseKr(record, kr, get('revisionReason')) : undefined;
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
    const objective = { statement, quarter: get('quarter'), annualGoalKey: get('annualGoalKey') };
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

export interface PlanPreparation {
  readonly state: PlanState;
  readonly key: string;
  readonly baseVer: string;
  readonly intent: GoalIntent;
  readonly previousValue: string | undefined;
  readonly handoffVer: string | undefined;
  readonly at: number;
  readonly newId: () => string;
}

export type EditorError =
  | GoalError
  | {
      readonly field: string;
      readonly code: 'required' | 'invalid' | 'unavailable';
    };

type Prepared =
  | { readonly plan: Plan; readonly write: Plan['writes'][number] }
  | { readonly choices: DraftChoice[]; readonly record: EditorRecord | undefined }
  | { readonly message: string; readonly errors: readonly EditorError[] };

export function prepareGoalPlan(options: PlanPreparation): Prepared {
  const { key, state } = options;
  return prepareEditorPlan(options, (intent) =>
    transition(key.split(':')[0], recordAt(state, key), intent, state),
  );
}

export function prepareEditorPlan(
  { state, key, baseVer, intent, previousValue, handoffVer, at, newId }: PlanPreparation,
  applyIntent: (
    intent: GoalIntent,
  ) =>
    | { readonly ok: true; readonly value: RecordInput }
    | { readonly ok: false; readonly errors: readonly EditorError[] }
    | undefined,
): Prepared {
  const record = editorRecordAt(state, key);
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
    : applyIntent(effective);
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
  readonly record?: EditorRecord | undefined;
  readonly source?: string | undefined;
  readonly readOnlyReason?: string | undefined;
  readonly errors: readonly EditorError[];
  readonly message?: string | undefined;
  readonly draftMessage?: string | undefined;
  readonly deadline?: string | undefined;
  readonly readOnly?: boolean;
  readonly ready?: boolean;
  readonly busy?: boolean;
  readonly awaitingRetry?: boolean;
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

export interface GoalEditorDependencies {
  readonly facade: EditorFacade;
  readonly drafts: DraftStore;
  readonly now: () => number;
  readonly newId: () => string;
  readonly onChange?: () => void;
  readonly readForStatus?: EditorFacade['read'];
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
  awaitingRetry: false,
  message: changed,
  leaveChoices: undefined,
  deadline: undefined,
} as const;

export function afterWipe(
  view: EditorView,
  handled: boolean,
  discard: boolean,
  ver: string,
): Partial<EditorView> {
  const status = {
    busy: false,
    wipe: handled && view.wipe?.ver === ver ? undefined : view.wipe,
    draftMessage: handled ? undefined : draftError,
  };
  if (!handled || !discard) return status;
  return {
    ...status,
    ...afterDraftDiscard(view.record, view.source),
    message: view.readOnlyReason,
  };
}

export function afterDraftDiscard(record?: EditorRecord, source?: string): Partial<EditorView> {
  return {
    record,
    intent: editorIntent(record, source),
    baseVer: record?.ver ?? absent,
    draftChoices: undefined,
    awaitingRetry: false,
    status: undefined,
    message: undefined,
  };
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

export function editorIntent(record?: EditorRecord, source?: string): GoalIntent {
  if (record && 'kind' in record) {
    if (record.kind === 'initiative' || record.kind === 'task-meta') {
      const field = sourceField(record.kind);
      return {
        action: 'edit',
        fields: { [field]: record.kind === 'initiative' ? record.projectKey : record.taskKey },
      };
    }
    return recordIntent(record);
  }
  const kind = source?.startsWith('project:') ? 'initiative' : 'task-meta';
  return { action: 'create', fields: source === undefined ? {} : { [sourceField(kind)]: source } };
}
