import type { AnnualGoal, Objective } from './goals';
import { isBaseKey, isRecordKeyOfKind, type Initiative, type TaskMeta } from './records';

export interface AvailableLinks {
  readonly projectKeys: ReadonlySet<string>;
  readonly taskKeys: ReadonlySet<string>;
  readonly krKeys: ReadonlySet<string>;
  readonly initiativeKeys: ReadonlySet<string>;
  readonly sphereTagKeys: ReadonlySet<string>;
}

export interface InitiativeChanges {
  readonly krKey?: string;
  readonly initiativeType?: string;
  readonly cadence?: string;
}

export interface InitiativeDraft extends InitiativeChanges {
  readonly projectKey: string;
  readonly krKey: string;
  readonly initiativeType: string;
}

export interface TaskLinkChanges {
  readonly initiativeKey?: string | null;
  readonly sphereTagKey?: string | null;
  readonly directKrKeys?: readonly string[];
}

type LinkField = keyof InitiativeDraft | keyof TaskLinkChanges | 'taskKey';

interface LinkError {
  readonly field: LinkField;
  readonly code: 'required' | 'invalid' | 'unavailable';
}

type LinkResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly errors: readonly LinkError[] };

function referenceErrors(
  field: LinkField,
  value: string,
  valid: boolean,
  available: ReadonlySet<string>,
): LinkError[] {
  if (!valid) return [{ field, code: value === '' ? 'required' : 'invalid' }];
  return available.has(value) ? [] : [{ field, code: 'unavailable' }];
}

function initiativeResult(draft: InitiativeDraft, errors: LinkError[]): LinkResult<Initiative> {
  const { projectKey, krKey, initiativeType, cadence } = draft;
  const fields = { kind: 'initiative', projectKey, krKey } as const;
  if (initiativeType === 'one-off') {
    return errors.length
      ? { ok: false, errors }
      : { ok: true, value: { ...fields, initiativeType } };
  }
  if (initiativeType !== 'regular') {
    return { ok: false, errors: [...errors, { field: 'initiativeType', code: 'invalid' }] };
  }
  if (typeof cadence !== 'string' || !cadence.trim()) {
    return { ok: false, errors: [...errors, { field: 'cadence', code: 'required' }] };
  }
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { ...fields, initiativeType, cadence } };
}

export function createInitiative(
  draft: InitiativeDraft,
  available: Pick<AvailableLinks, 'projectKeys' | 'krKeys'>,
): LinkResult<Initiative> {
  const { projectKey, krKey } = draft;
  return initiativeResult(draft, [
    ...referenceErrors(
      'projectKey',
      projectKey,
      isBaseKey(projectKey, 'project'),
      available.projectKeys,
    ),
    ...referenceErrors('krKey', krKey, isRecordKeyOfKind(krKey, 'kr'), available.krKeys),
  ]);
}

export function updateInitiative(
  current: Initiative,
  changes: InitiativeChanges,
  available: Pick<AvailableLinks, 'krKeys'>,
): LinkResult<Initiative> {
  const {
    krKey = current.krKey,
    initiativeType = current.initiativeType,
    cadence = current.cadence,
  } = changes;
  const errors =
    krKey === current.krKey
      ? []
      : referenceErrors('krKey', krKey, isRecordKeyOfKind(krKey, 'kr'), available.krKeys);
  return initiativeResult(
    {
      projectKey: current.projectKey,
      krKey,
      initiativeType,
      ...(cadence !== undefined && { cadence }),
    },
    errors,
  );
}

function sphereErrors(
  next: string | null | undefined,
  previous: string | undefined,
  available: ReadonlySet<string>,
): LinkError[] {
  if (next == null || next === previous) return [];
  return referenceErrors('sphereTagKey', next, isBaseKey(next, 'tag'), available);
}

function directKrErrors(
  next: readonly string[] | undefined,
  previous: readonly string[] | undefined,
  available: ReadonlySet<string>,
): LinkError[] {
  const added = next?.filter((key) => !previous?.includes(key));
  if (added?.some((key) => !isRecordKeyOfKind(key, 'kr'))) {
    return [{ field: 'directKrKeys', code: 'invalid' }];
  }
  return added?.some((key) => !available.has(key))
    ? [{ field: 'directKrKeys', code: 'unavailable' }]
    : [];
}

export function updateTaskLinks(
  taskKey: string,
  current: TaskMeta | undefined,
  changes: TaskLinkChanges,
  available: Pick<AvailableLinks, 'taskKeys' | 'initiativeKeys' | 'krKeys' | 'sphereTagKeys'>,
): LinkResult<TaskMeta> {
  if (current && current.taskKey !== taskKey) {
    return { ok: false, errors: [{ field: 'taskKey', code: 'invalid' }] };
  }
  const {
    initiativeKey = current?.initiativeKey,
    sphereTagKey = current?.sphereTagKey,
    directKrKeys,
  } = changes;
  const errors = [
    ...(current
      ? []
      : referenceErrors('taskKey', taskKey, isBaseKey(taskKey, 'task'), available.taskKeys)),
    ...(initiativeKey == null || initiativeKey === current?.initiativeKey
      ? []
      : referenceErrors(
          'initiativeKey',
          initiativeKey,
          isRecordKeyOfKind(initiativeKey, 'initiative'),
          available.initiativeKeys,
        )),
    ...sphereErrors(sphereTagKey, current?.sphereTagKey, available.sphereTagKeys),
    ...directKrErrors(directKrKeys, current?.directKrKeys, available.krKeys),
  ];
  if (errors.length) return { ok: false, errors };
  const keys =
    directKrKeys === undefined
      ? current?.directKrKeys
      : [...new Set(directKrKeys)].sort((first, second) =>
          first < second ? -1 : Number(first > second),
        );

  return {
    ok: true,
    value: {
      kind: 'task-meta',
      taskKey,
      ...(initiativeKey != null && { initiativeKey }),
      ...(sphereTagKey != null && { sphereTagKey }),
      ...(keys !== undefined && { directKrKeys: keys }),
    },
  };
}

export function setGoalSphere(
  current: AnnualGoal | Objective,
  sphereTagKey: string | null,
  available: ReadonlySet<string>,
): LinkResult<AnnualGoal | Objective> {
  const errors = sphereErrors(sphereTagKey, current.sphereTagKey, available);
  if (errors.length) return { ok: false, errors };
  const goal = { ...current };
  if (sphereTagKey === null) delete goal.sphereTagKey;
  else goal.sphereTagKey = sphereTagKey;
  return { ok: true, value: goal };
}
