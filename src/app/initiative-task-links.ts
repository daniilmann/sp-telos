import {
  createInitiative,
  setGoalSphere,
  updateInitiative,
  updateTaskLinks,
} from '../core/initiative-task-links';
import { WIPE_KEY, splitRecord, type StoredRecord } from '../core/records';
import type { PlanState } from '../core/plan';
import type { BaseReferences } from '../platform/base-references';
import { sameDraft, type DraftStore } from '../platform/draft-store';
import type { EditorFacade } from '../platform/facade';
import {
  absent,
  afterDraftDiscard,
  changed,
  draftChoices,
  draftError,
  failedRemoval,
  goalRecords,
  isGoalAction,
  prepareEditorPlan,
  prepareGoalPlan,
  editorRecordAt,
  recordAt,
  transition,
  type DraftChoice,
  type EditorView,
  type PlanPreparation,
  type GoalIntent,
} from './commands';
import {
  isKeyList,
  isLinkedSource,
  linkedKind,
  sourceField,
  stringField,
} from './linked-editor-intent';

export function availableLinks(state: PlanState, references: BaseReferences) {
  return {
    projectKeys: new Set(Object.keys(references.projects ?? {})),
    taskKeys: new Set(Object.keys(references.tasks ?? {})),
    krKeys: new Set(
      Object.entries(goalRecords(state)).flatMap(([key, entry]) =>
        entry.kind === 'kr' ? [key] : [],
      ),
    ),
    initiativeKeys: new Set(
      Object.keys(state.entries).filter(
        (key) => editorRecordAt(state, key, 'initiative') !== undefined,
      ),
    ),
    sphereTagKeys: new Set(Object.keys(references.tags ?? {})),
  };
}

function nullableSelection(value: unknown): string | null | undefined {
  return typeof value === 'string' || value === null ? value : undefined;
}

function linkedTransition(
  key: string,
  state: PlanState,
  references: BaseReferences,
  intent: GoalIntent,
) {
  const { fields } = intent;
  const available = availableLinks(state, references);
  switch (linkedKind(key)) {
    case 'initiative': {
      const current = editorRecordAt(state, key, 'initiative');
      const krKey = stringField(fields, 'krKey');
      const initiativeType = stringField(fields, 'initiativeType');
      const cadence = stringField(fields, 'cadence');
      return current
        ? updateInitiative(
            current,
            {
              ...(krKey !== undefined && { krKey }),
              ...(initiativeType !== undefined && { initiativeType }),
              ...(cadence !== undefined && { cadence }),
            },
            available,
          )
        : createInitiative(
            {
              projectKey: stringField(fields, 'projectKey') ?? '',
              krKey: krKey ?? '',
              initiativeType: initiativeType ?? '',
              ...(cadence !== undefined && { cadence }),
            },
            available,
          );
    }
    case 'task-meta': {
      const current = editorRecordAt(state, key, 'task-meta');
      const initiativeKey = nullableSelection(fields.initiativeKey);
      const sphereTagKey = nullableSelection(fields.sphereTagKey);
      return updateTaskLinks(
        current?.taskKey ?? stringField(fields, 'taskKey') ?? '',
        current,
        {
          ...(initiativeKey !== undefined && { initiativeKey }),
          ...(sphereTagKey !== undefined && { sphereTagKey }),
          ...(isKeyList(fields.directKrKeys) && { directKrKeys: fields.directKrKeys }),
        },
        available,
      );
    }
    default: {
      const current = recordAt(state, key);
      const sphere = nullableSelection(fields.sphereTagKey);
      if (
        intent.action === 'edit' &&
        sphere !== undefined &&
        Object.keys(fields).length === 1 &&
        current &&
        'kind' in current &&
        (current.kind === 'annual-goal' || current.kind === 'objective')
      ) {
        return setGoalSphere(splitRecord(current).record, sphere, available.sphereTagKeys);
      }
      const result = transition(key.split(':')[0], current, intent, state);
      if (
        !result?.ok ||
        sphere === undefined ||
        (result.value.kind !== 'annual-goal' && result.value.kind !== 'objective')
      )
        return result;
      return setGoalSphere(result.value, sphere, available.sphereTagKeys);
    }
  }
}

export function prepareLinkedPlan({
  intent: { action, fields },
  references,
  ...options
}: Omit<PlanPreparation, 'intent'> & {
  readonly references: BaseReferences;
  readonly intent: { readonly action: string; readonly fields: GoalIntent['fields'] };
}) {
  const kind = linkedKind(options.key);
  if (!isGoalAction(action) || (kind && action !== 'create' && action !== 'edit')) {
    return { errors: [], message: 'Проверьте действие формы.' };
  }
  return prepareEditorPlan({ ...options, intent: { action, fields } }, (intent) =>
    linkedTransition(options.key, options.state, references, intent),
  );
}

interface LinkedRow {
  readonly key: string;
  readonly title?: string;
  readonly hasDraft: boolean;
}

export async function resolveLinkedReferences(
  state: PlanState,
  references: BaseReferences,
  draftKeys: readonly string[] = [],
  readDraft?: DraftStore['read'],
) {
  const draftsWithSource = await Promise.all(
    draftKeys.map(async (key) => {
      const kind = linkedKind(key);
      if (!kind || !readDraft || linkedSource(editorRecordAt(state, key))) return undefined;
      const { value } = await readDraft(key);
      return [key, value && stringField(value.fields, sourceField(kind))] as const;
    }),
  );
  const draftSources = new Map(draftsWithSource.filter((pair) => pair !== undefined));
  const { projects = {}, tasks = {}, tags = {} } = references;
  const krs = Object.fromEntries(
    Object.entries(goalRecords(state)).flatMap(([key, record]) =>
      record.kind === 'kr' ? [[key, { title: record.statement }]] : [],
    ),
  );

  const drafts = new Set(draftKeys);
  const initiativeRows: LinkedRow[] = [];
  const taskRows: LinkedRow[] = [];
  const initiatives: Record<string, { title: string; isArchived: boolean }> = {};
  const live = new Set<string>();
  for (const key of new Set([...Object.keys(state.entries), ...draftKeys])) {
    const kind = linkedKind(key);
    if (!kind) continue;
    const source = linkedSource(editorRecordAt(state, key));
    const hasDraft = drafts.has(key);
    if (!source && !hasDraft) continue;
    const sourceKey = source ?? draftSources.get(key);
    const group = kind === 'initiative' ? projects : tasks;
    const reference = sourceKey ? group[sourceKey] : undefined;
    const fallback = sourceKey ? 'Недоступно' : undefined;
    const title = reference?.title ?? fallback;
    if (source) {
      live.add(key);
      if (kind === 'initiative') {
        initiatives[key] = {
          title: title ?? 'Недоступно',
          isArchived: projects[source]?.isArchived ?? false,
        };
      }
    }
    const list = kind === 'initiative' ? initiativeRows : taskRows;
    list.push({ key, ...(title !== undefined && { title }), hasDraft });
  }
  return { projects, tasks, tags, krs, initiativeRows, taskRows, initiatives, live };
}

export type LinkedReferences = Awaited<ReturnType<typeof resolveLinkedReferences>>;

export function linkedSource(record?: StoredRecord): string | undefined {
  if (record && 'kind' in record) {
    if (record.kind === 'initiative') return record.projectKey;
    if (record.kind === 'task-meta') return record.taskKey;
  }
  return undefined;
}

export async function prepareDraftTransfer(
  facade: EditorFacade,
  drafts: DraftStore,
  view: EditorView,
  target: unknown,
  at: number,
  current: () => boolean,
): Promise<Partial<EditorView>> {
  const kind = linkedKind(view.key);
  const field = kind && sourceField(kind);
  if (!kind || !field || !isLinkedSource(kind, target) || !facade.linkedRecordKey) {
    return { draftMessage: 'Выберите другой объект для черновика.' };
  }
  const key = await facade.linkedRecordKey(target);
  const [state, references, source] = await Promise.all([
    facade.read([key, WIPE_KEY]),
    facade.readBaseReferences?.(),
    drafts.read(view.key),
  ]);
  const targets = kind === 'initiative' ? references?.projects : references?.tasks;
  if (!current()) return {};
  if (
    key === view.key ||
    !targets?.[target] ||
    state.readOnlyReason ||
    state.entries[key] !== undefined ||
    state.unreadKeys?.includes(key)
  ) {
    return { draftMessage: 'Для этого объекта нельзя восстановить черновик.' };
  }
  const expected = {
    at,
    baseVer: view.baseVer,
    fields: { ...view.intent.fields, action: view.intent.action },
  };
  if (source.failed || !source.value || !sameDraft(source.value, expected))
    return { draftMessage: draftError };
  const intent = { action: 'create', fields: { ...view.intent.fields, [field]: target } } as const;
  const moved = await drafts.claim(key, {
    at,
    baseVer: absent,
    fields: { ...intent.fields, action: intent.action },
  });
  if (!moved) return { draftMessage: 'Не удалось сохранить черновик для выбранного объекта.' };
  if (!current()) return {};
  const removal = drafts.removeConfirmed(view.key, source.value, current, true);
  const result = removal && (await drafts.flush());
  return {
    ...afterDraftDiscard(undefined, target),
    key,
    source: target,
    intent,
    status: 'changed',
    message: changed,
    draftMessage: result?.ok ? undefined : failedRemoval,
  };
}

export function refreshedView(
  view: EditorView,
  state: PlanState,
  readOnlyReason: string | undefined,
  wipe: EditorView['wipe'],
  dirty: boolean,
): Partial<EditorView> {
  const record = editorRecordAt(state, view.key);
  const available = dirty
    ? { record, draftChoices: draftChoices(record, view.baseVer) }
    : { record, ...afterDraftDiscard(record, view.source), status: view.status };
  const editedMessage = dirty ? changed : undefined;
  return {
    ...(view.ready && !view.busy && available),
    readOnly: Boolean(readOnlyReason),
    readOnlyReason,
    wipe,
    message: readOnlyReason ?? (view.readOnlyReason ? editedMessage : view.message),
  };
}

interface DraftResolution {
  readonly facade: EditorFacade;
  readonly drafts: DraftStore;
  readonly view: EditorView;
  readonly choice: DraftChoice;
  readonly target: string | undefined;
  readonly now: () => number;
  readonly newId: () => string;
  readonly current: () => boolean;
  readonly update: (patch: Partial<EditorView>) => void;
  readonly storeDraft: () => void;
  readonly markClean: () => void;
}

export async function resolveEditorDraft({
  facade,
  drafts,
  view,
  choice,
  target,
  now,
  newId,
  current,
  update,
  storeDraft,
  markClean,
}: DraftResolution): Promise<void> {
  const { key, record, intent } = view;
  const snapshot = await facade.read([key, WIPE_KEY]);
  if (!current()) return;
  const remote = editorRecordAt(snapshot, key);
  if (snapshot.readOnlyReason && choice !== 'discard-draft' && choice !== 'use-saved') {
    update({
      readOnly: true,
      readOnlyReason: snapshot.readOnlyReason,
      message: snapshot.readOnlyReason,
    });
    return;
  }
  if (remote?.ver !== record?.ver) {
    update({ record: remote, draftChoices: draftChoices(remote, view.baseVer) });
    return;
  }
  if (choice === 'keep-draft') {
    update({
      baseVer: remote?.ver ?? absent,
      draftChoices: undefined,
      status: 'changed',
      message: changed,
    });
    storeDraft();
    return;
  }
  if (choice === 'restore-as-new') {
    if (linkedKind(key)) {
      const moved = await prepareDraftTransfer(facade, drafts, view, target, now(), current);
      if (current()) update(moved);
      return;
    }
    const newKey = `${key.split(':')[0] ?? ''}:${newId()}`;
    update({
      ...afterDraftDiscard(),
      key: newKey,
      intent: { ...intent, action: 'create' },
      status: 'changed',
      message: changed,
    });
    storeDraft();
    if (!(await drafts.flush()).ok) {
      if (current()) update({ draftMessage: draftError });
      return;
    }
    if (!current()) return;
  } else {
    markClean();
    update(afterDraftDiscard(remote, view.source ?? linkedSource(record)));
  }
  drafts.remove(key);
  const result = await drafts.flush();
  if (current()) update({ draftMessage: result.ok ? undefined : failedRemoval });
}

export function prepareFormPlan(options: PlanPreparation, references: BaseReferences | undefined) {
  return references || linkedKind(options.key) || options.intent.fields.sphereTagKey !== undefined
    ? prepareLinkedPlan({ ...options, references: references ?? {} })
    : prepareGoalPlan(options);
}
