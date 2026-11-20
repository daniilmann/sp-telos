import { getMissingKrFields, type KrDraft } from './kr';

export interface AnnualGoalDraft {
  readonly statement: string;
}

export interface ObjectiveDraft extends AnnualGoalDraft {
  readonly quarter: string;
  readonly annualGoalKey: string;
}

export interface LinkedKrDraft extends KrDraft {
  readonly objectiveKey: string;
}

export interface ClosureDraft {
  readonly outcome: string;
  readonly reason: string;
}

const goalOutcomes = ['achieved', 'completed', 'cancelled'] as const;
const krOutcomes = ['achieved', 'not-achieved', 'cancelled'] as const;

type GoalOutcome = (typeof goalOutcomes)[number];
type KrOutcome = (typeof krOutcomes)[number];

type Active = { readonly status: 'active' };
type Closed<Outcome extends string> = {
  readonly status: 'closed';
  readonly outcome: Outcome;
  readonly closureReason: string;
};

type SphereAssignment = { readonly sphereTagKey?: string };

export type AnnualGoal = AnnualGoalDraft &
  SphereAssignment & { readonly kind: 'annual-goal' } & (Active | Closed<GoalOutcome>);

export type Objective = ObjectiveDraft &
  SphereAssignment & { readonly kind: 'objective' } & (Active | Closed<GoalOutcome>);

type KrVersion = LinkedKrDraft & { readonly kind: 'kr' } & (Active | Closed<KrOutcome>);
type KrRevision = KrVersion & { readonly revisionReason: string };

export type Kr = KrVersion & { readonly history: readonly KrRevision[] };
export type GoalRecord = AnnualGoal | Objective | Kr;

type ClosedGoalRecord = ((AnnualGoal | Objective) & Closed<GoalOutcome>) | (Kr & Closed<KrOutcome>);

type ParentField = 'annualGoalKey' | 'objectiveKey';
type ErrorField =
  | keyof ObjectiveDraft
  | keyof LinkedKrDraft
  | keyof ClosureDraft
  | 'revisionReason';

export interface GoalError {
  readonly field: ErrorField;
  readonly code: 'required' | 'unknown-parent' | 'invalid';
}

export type Result<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly errors: readonly GoalError[] };

type RecordsByKey<RecordValue> = Readonly<Record<string, RecordValue | undefined>>;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function requiredErrors(field: ErrorField, value: string): GoalError[] {
  return isBlank(value) ? [{ field, code: 'required' }] : [];
}

function parentErrors(
  field: ParentField,
  key: string,
  records: RecordsByKey<AnnualGoal | Objective>,
): GoalError[] {
  if (isBlank(key)) return [{ field, code: 'required' }];
  if (!Object.prototype.hasOwnProperty.call(records, key) || records[key] === undefined) {
    return [{ field, code: 'unknown-parent' }];
  }
  return [];
}

export function createAnnualGoal({ statement }: AnnualGoalDraft): Result<AnnualGoal> {
  const errors = requiredErrors('statement', statement);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { kind: 'annual-goal', status: 'active', statement } };
}

export function updateAnnualGoal(
  current: AnnualGoal,
  { statement }: AnnualGoalDraft,
): Result<AnnualGoal> {
  const errors = requiredErrors('statement', statement);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { ...current, statement } };
}

function objectiveErrors(
  draft: ObjectiveDraft,
  annualGoals: RecordsByKey<AnnualGoal>,
): GoalError[] {
  return [
    ...requiredErrors('statement', draft.statement),
    ...requiredErrors('quarter', draft.quarter),
    ...parentErrors('annualGoalKey', draft.annualGoalKey, annualGoals),
  ];
}

export function createObjective(
  draft: ObjectiveDraft,
  annualGoals: RecordsByKey<AnnualGoal>,
): Result<Objective> {
  const errors = objectiveErrors(draft, annualGoals);
  if (errors.length > 0) return { ok: false, errors };

  const { statement, quarter, annualGoalKey } = draft;
  return {
    ok: true,
    value: { kind: 'objective', status: 'active', statement, quarter, annualGoalKey },
  };
}

export function updateObjective(
  current: Objective,
  draft: ObjectiveDraft,
  annualGoals: RecordsByKey<AnnualGoal>,
): Result<Objective> {
  const errors = objectiveErrors(draft, annualGoals);
  if (errors.length > 0) return { ok: false, errors };

  const { statement, quarter, annualGoalKey } = draft;
  return { ok: true, value: { ...current, statement, quarter, annualGoalKey } };
}

function krErrors(draft: KrDraft): GoalError[] {
  return getMissingKrFields(draft).map((field) => ({ field, code: 'required' }));
}

function krWriteErrors(draft: LinkedKrDraft, objectives: RecordsByKey<Objective>): GoalError[] {
  return [...krErrors(draft), ...parentErrors('objectiveKey', draft.objectiveKey, objectives)];
}

function krFields({ statement, baseline, dataSource, target }: KrDraft): KrDraft {
  return { statement, baseline, dataSource, target };
}

export function createKr(draft: LinkedKrDraft, objectives: RecordsByKey<Objective>): Result<Kr> {
  const errors = krWriteErrors(draft, objectives);
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      kind: 'kr',
      status: 'active',
      ...krFields(draft),
      objectiveKey: draft.objectiveKey,
      history: [],
    },
  };
}

export function updateKr(
  current: Kr,
  draft: LinkedKrDraft,
  objectives: RecordsByKey<Objective>,
): Result<Kr> {
  const errors = krWriteErrors(draft, objectives);
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, value: { ...current, ...krFields(draft), objectiveKey: draft.objectiveKey } };
}

function checkClosure<Outcome extends string>(
  draft: ClosureDraft,
  allowedOutcomes: readonly Outcome[],
): Result<Closed<Outcome>> {
  const outcome = allowedOutcomes.find((allowed) => allowed === draft.outcome);
  const errors = requiredErrors('reason', draft.reason);
  if (outcome === undefined) {
    const code = isBlank(draft.outcome) ? 'required' : 'invalid';
    return { ok: false, errors: [{ field: 'outcome', code }, ...errors] };
  }
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, value: { status: 'closed', outcome, closureReason: draft.reason } };
}

export function closeGoalRecord(
  current: AnnualGoal,
  draft: ClosureDraft,
): Result<AnnualGoal & Closed<GoalOutcome>>;
export function closeGoalRecord(
  current: Objective,
  draft: ClosureDraft,
): Result<Objective & Closed<GoalOutcome>>;
export function closeGoalRecord(current: Kr, draft: ClosureDraft): Result<Kr & Closed<KrOutcome>>;
export function closeGoalRecord(current: GoalRecord, draft: ClosureDraft): Result<ClosedGoalRecord>;
export function closeGoalRecord(
  current: GoalRecord,
  draft: ClosureDraft,
): Result<ClosedGoalRecord> {
  if (current.kind === 'kr') {
    const closure = checkClosure(draft, krOutcomes);
    return closure.ok ? { ok: true, value: { ...current, ...closure.value } } : closure;
  }

  const closure = checkClosure(draft, goalOutcomes);
  return closure.ok ? { ok: true, value: { ...current, ...closure.value } } : closure;
}

export function reviseKr(current: Kr, fields: KrDraft, revisionReason: string): Result<Kr> {
  const errors = [...krErrors(fields), ...requiredErrors('revisionReason', revisionReason)];
  if (errors.length > 0) return { ok: false, errors };

  const { history: earlierRevisions, ...previous } = current;
  return {
    ok: true,
    value: {
      ...current,
      ...krFields(fields),
      history: [...earlierRevisions, { ...previous, revisionReason }],
    },
  };
}
