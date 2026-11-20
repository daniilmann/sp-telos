import { isBaseKey, WIPE_KEY } from '../core/records';
import type { PlanState } from '../core/plan';
import { removeConfirmedDraft, type ReadSnapshot } from '../platform/facade';
import type { Draft, DraftRead, DraftStore } from '../platform/draft-store';
import { linkedRecordSource, matchesLinkedRecord } from '../platform/linked-record-keys';
import {
  absent,
  afterDraftDiscard,
  changed,
  draftChoices,
  draftError,
  draftIntent,
  editorRecordAt,
  recordAt,
  type EditorView,
  type GoalDraft,
  type GoalIntent,
  type Submission,
} from './commands';

export function linkedKind(key: string): 'initiative' | 'task-meta' | undefined {
  if (key.startsWith('initiative:')) return 'initiative';
  if (key.startsWith('task-meta:')) return 'task-meta';
  return undefined;
}

export function sourceField(kind: 'initiative' | 'task-meta') {
  return kind === 'initiative' ? 'projectKey' : 'taskKey';
}

export function isLinkedSource(kind: 'initiative' | 'task-meta', value: unknown): value is string {
  return isBaseKey(value, kind === 'initiative' ? 'project' : 'task');
}

export function isKeyList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function stringField(fields: GoalIntent['fields'], name: string): string | undefined {
  const value = fields[name];
  return typeof value === 'string' ? value : undefined;
}

function keyField(fields: GoalIntent['fields'], name: string): readonly string[] | undefined {
  const value = fields[name];
  return isKeyList(value) ? value : undefined;
}

const directKrFields = ['directKrKeys', 'addDirectKrKeys', 'removeDirectKrKeys'];

export function directKrEdit(fields: GoalIntent['fields'], base?: readonly string[]) {
  if (directKrFields.some((name) => keyField(fields, name) !== undefined))
    return directKrSelection(fields, base ?? []);
  return undefined;
}

export function directKrSelection(fields: GoalIntent['fields'], base: readonly string[]) {
  const selected = keyField(fields, 'directKrKeys') ?? base;
  const added = keyField(fields, 'addDirectKrKeys') ?? [];
  const removed = new Set(keyField(fields, 'removeDirectKrKeys'));
  return [...new Set([...selected, ...added])].filter((key) => !removed.has(key));
}

export function changeDirectKrSelection(
  fields: GoalIntent['fields'],
  shown: readonly string[],
  chosen: readonly string[],
): GoalIntent['fields'] {
  const added = new Set(keyField(fields, 'addDirectKrKeys'));
  const removed = new Set(keyField(fields, 'removeDirectKrKeys'));
  for (const key of chosen) {
    if (shown.includes(key)) continue;
    removed.delete(key);
    added.add(key);
  }
  for (const key of shown) {
    if (chosen.includes(key)) continue;
    added.delete(key);
    removed.add(key);
  }
  return { ...fields, addDirectKrKeys: [...added], removeDirectKrKeys: [...removed] };
}

export function readLinkedIntent(key: string, { fields: { action, ...fields } }: Draft) {
  const kind = linkedKind(key);
  if (!kind || (action !== 'create' && action !== 'edit')) return undefined;
  const strings =
    kind === 'initiative' ? ['projectKey', 'krKey', 'initiativeType', 'cadence'] : ['taskKey'];
  for (const [name, value] of Object.entries(fields)) {
    if (strings.includes(name) && typeof value === 'string') continue;
    if (kind === 'task-meta') {
      if (
        (name === 'initiativeKey' || name === 'sphereTagKey') &&
        (value === null || typeof value === 'string')
      )
        continue;
      if (directKrFields.includes(name) && isKeyList(value)) continue;
    }
    return undefined;
  }
  return { action, fields } satisfies GoalIntent;
}

const sourceMismatch = 'Только чтение. Не удалось подтвердить исходную ссылку для этого ключа.';

export async function editorSelection(
  state: ReadSnapshot,
  key: string,
  expected?: string,
  localSource?: string,
) {
  const record = editorRecordAt(state, key);
  const actual = linkedRecordSource(record);
  const source = expected ?? actual ?? localSource;
  const blocked = Boolean(
    linkedKind(key) &&
    (state.unreadKeys?.includes(key) ||
      (source !== undefined && !(await matchesLinkedRecord(key, actual ?? source, source)))),
  );
  return {
    blocked,
    record: blocked ? undefined : record,
    source,
    readOnlyReason: state.readOnlyReason ?? (blocked ? sourceMismatch : undefined),
  };
}

export async function checkedEditorRead(
  drafts: DraftStore,
  snapshot: ReadSnapshot,
  key: string,
  source?: string,
) {
  const [selected, wipe] = await Promise.all([
    editorSelection(snapshot, key, source),
    pendingWipe(drafts, snapshot),
  ]);
  return { ...selected, wipe };
}

type EditorRead = Awaited<ReturnType<typeof checkedEditorRead>>;

export function readOnlyPatch({ readOnlyReason, blocked, wipe }: EditorRead): Partial<EditorView> {
  return {
    ...(blocked && { record: undefined }),
    ...(wipe && { wipe }),
    readOnly: true,
    readOnlyReason,
    message: readOnlyReason,
  };
}

export function refreshedView(
  view: EditorView,
  { record, source, readOnlyReason, wipe, blocked }: EditorRead,
  dirty: boolean,
): Partial<EditorView> {
  const available = dirty
    ? { record, draftChoices: draftChoices(record, view.baseVer) }
    : { ...afterDraftDiscard(record, source), status: view.status };
  const editedMessage = dirty ? changed : undefined;
  return {
    ...(view.ready && !view.busy && !blocked && available),
    ...(blocked && { record: undefined }),
    source,
    readOnly: Boolean(readOnlyReason),
    readOnlyReason,
    wipe,
    message: readOnlyReason ?? (view.readOnlyReason ? editedMessage : view.message),
  };
}

async function readEditor(
  snapshot: ReadSnapshot,
  key: string,
  expected: string | undefined,
  local: DraftRead,
  wipe: EditorView['wipe'],
) {
  const kind = linkedKind(key);
  const draft = local.value;
  const restored = draft && (kind ? readLinkedIntent(key, draft) : draftIntent(draft));
  const localSource = kind && restored && stringField(restored.fields, sourceField(kind));
  const { record, source, readOnlyReason } = await editorSelection(
    snapshot,
    key,
    expected,
    localSource,
  );
  const draftCollision =
    localSource !== undefined && localSource !== source ? sourceMismatch : undefined;
  const reason = readOnlyReason ?? draftCollision;
  const intent = draftCollision ? undefined : restored;
  const baseVer = (intent && draft?.baseVer) ?? record?.ver ?? absent;
  const handoff = draft && 'handoffVer' in draft ? draft.handoffVer : undefined;
  const handoffVer = handoff === baseVer ? baseVer : undefined;
  const awaitingRetry = Boolean(kind && handoffVer && record?.ver === handoffVer);
  const localMessage = awaitingRetry ? 'Подтверждение сохранения не получено.' : changed;
  const view: Partial<EditorView> = {
    ...afterDraftDiscard(record, source),
    source,
    baseVer,
    draftChoices: intent ? draftChoices(record, baseVer) : undefined,
    draftMessage: local.failed ? 'Не удалось прочитать черновики' : undefined,
    wipe,
    awaitingRetry,
    ready: true,
    readOnly: Boolean(reason),
    readOnlyReason: reason,
    ...(intent && { intent }),
    status: intent ? 'changed' : undefined,
    message: reason ?? (intent ? localMessage : undefined),
  };
  return { view, handoffVer, draftCollision, dirty: intent !== undefined };
}

export async function pendingWipe(
  drafts: DraftStore,
  state: PlanState,
): Promise<EditorView['wipe']> {
  const ver = recordAt(state, WIPE_KEY)?.ver;
  if (!ver) return undefined;
  const [listed, handled] = await Promise.all([
    drafts.list(),
    drafts.readWipeVersion().catch(() => undefined),
  ]);
  return ver !== handled && listed.keys.length ? { ver, count: listed.keys.length } : undefined;
}

export function createEditorReads(
  drafts: DraftStore,
  currentForm: () => { readonly id: string; readonly view: EditorView; readonly dirty: boolean },
  apply: (patch: Partial<EditorView>, opened?: Awaited<ReturnType<typeof readEditor>>) => void,
) {
  let issued = 0;
  let accepted = 0;
  let opening: Promise<DraftRead> | undefined;
  let draftCollision: string | undefined;
  let handledWipe: { readonly ver: string; readonly through: number } | undefined;

  function applyCurrent(
    number: number,
    patch: Partial<EditorView>,
    opened?: Awaited<ReturnType<typeof readEditor>>,
  ) {
    const alreadyHandled =
      handledWipe && number <= handledWipe.through && patch.wipe?.ver === handledWipe.ver;
    const wipe = alreadyHandled ? undefined : patch.wipe;
    apply({ ...patch, wipe }, opened);
  }

  return {
    open(key: string) {
      opening = drafts.read(key);
      draftCollision = undefined;
    },
    invalidate() {
      accepted = ++issued;
    },
    handledWipe(ver: string) {
      handledWipe = { ver, through: issued };
    },
    begin() {
      const {
        id,
        view: { key },
      } = currentForm();
      const number = ++issued;
      return async (snapshot: ReadSnapshot | undefined, latest = () => true): Promise<void> => {
        const current = () => {
          const form = currentForm();
          return id && form.id === id && form.view.key === key && latest();
        };
        if (!snapshot || !current() || number < accepted) return;
        accepted = number;
        const { source } = currentForm().view;
        if (opening) {
          const [local, wipe] = await Promise.all([opening, pendingWipe(drafts, snapshot)]);
          const opened = await readEditor(snapshot, key, source, local, wipe);
          if (!current() || accepted !== number) return;
          opening = undefined;
          draftCollision = opened.draftCollision;
          applyCurrent(number, opened.view, opened);
          return;
        }
        const read = await checkedEditorRead(drafts, snapshot, key, source);
        if (!current() || accepted !== number) return;
        const { view, dirty } = currentForm();
        applyCurrent(
          number,
          refreshedView(
            view,
            { ...read, readOnlyReason: read.readOnlyReason ?? draftCollision },
            dirty,
          ),
        );
      };
    },
  };
}

export async function checkDraftRead(
  drafts: DraftStore,
  currentView: () => EditorView,
  update: (patch: Partial<EditorView>) => void,
): Promise<void> {
  const view = currentView();
  const result = await drafts.read(view.key);
  if (view === currentView() && result.failed && !view.draftMessage)
    update({ draftMessage: draftError });
}

export function editorDraft(
  view: EditorView,
  intent: GoalIntent,
  at: number,
  handoffVer?: string,
): GoalDraft {
  return {
    at,
    ...(handoffVer && { handoffVer }),
    baseVer: view.baseVer,
    fields: { ...intent.fields, action: intent.action },
  };
}

export interface DraftConfirmation {
  readonly sent: Submission;
  readonly draft: Draft;
}

export function createDraftRemoval(drafts: DraftStore) {
  const removing = new Set<DraftConfirmation>();
  return async (proof: DraftConfirmation, applicable: () => boolean) => {
    if (!applicable() || removing.has(proof)) return undefined;
    removing.add(proof);
    try {
      const result = await removeConfirmedDraft(
        drafts,
        proof.sent.write.key,
        proof.draft,
        applicable,
      );
      return applicable() ? result : undefined;
    } finally {
      removing.delete(proof);
    }
  };
}
