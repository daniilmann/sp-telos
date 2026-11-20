import { isBaseKey, WIPE_KEY } from '../core/records';
import type { PlanState } from '../core/plan';
import type { EditorFacade } from '../platform/facade';
import type { Draft, DraftStore } from '../platform/draft-store';
import {
  absent,
  afterDraftDiscard,
  changed,
  draftChoices,
  draftIntent,
  editorRecordAt,
  recordAt,
  type DraftChoice,
  type EditorView,
  type GoalIntent,
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
      if (name === 'directKrKeys' && isKeyList(value)) continue;
    }
    return undefined;
  }
  return { action, fields } satisfies GoalIntent;
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
  const [local, wipe] = await Promise.all([drafts.read(key), pendingWipe(drafts, state)]);
  const record = editorRecordAt(state, key);
  const restored = local.value && {
    intent: linkedKind(key) ? readLinkedIntent(key, local.value) : draftIntent(local.value),
    baseVer: local.value.baseVer,
  };
  const intent = restored?.intent;
  const baseVer = restored?.intent ? restored.baseVer : (record?.ver ?? absent);
  const handoff = local.value && 'handoffVer' in local.value ? local.value.handoffVer : undefined;
  return {
    intent,
    baseVer,
    handoffVer: handoff === baseVer ? baseVer : undefined,
    draftChoices: intent ? draftChoices(record, baseVer) : undefined,
    draftMessage: local.failed ? 'Не удалось прочитать черновики' : undefined,
    wipe,
  };
}

export async function readEditor(
  facade: EditorFacade,
  drafts: DraftStore,
  key: string,
  source?: string,
) {
  const snapshot = await facade.read([key, WIPE_KEY]);
  const { intent, handoffVer, ...local } = await readDraftContext(drafts, snapshot, key);
  const record = editorRecordAt(snapshot, key);
  const awaitingRetry = Boolean(linkedKind(key) && handoffVer && record?.ver === handoffVer);
  const localMessage = awaitingRetry ? 'Подтверждение сохранения не получено.' : changed;
  const view: Partial<EditorView> = {
    ...afterDraftDiscard(record, source),
    ...local,
    source,
    awaitingRetry,
    ready: true,
    readOnly: Boolean(snapshot.readOnlyReason),
    readOnlyReason: snapshot.readOnlyReason,
    ...(intent && { intent }),
    status: intent ? 'changed' : undefined,
    message: snapshot.readOnlyReason ?? (intent ? localMessage : undefined),
  };
  return { snapshot, view, handoffVer, dirty: intent !== undefined };
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
