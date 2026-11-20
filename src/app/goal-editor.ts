import { sameDraft } from '../platform/draft-store';
import { handleDraftWipe, handoffGoalPlan, type ReadSnapshot } from '../platform/facade';
import {
  absent,
  EDIT_INTERVAL_MS,
  updatedInput,
  draftError,
  removalMessages,
  leaveFailed,
  afterWipe,
  editorIntent,
  editorRecordAt,
  recordIntent,
  type DraftChoice,
  type EditorView,
  type LeaveChoice,
  type GoalIntent,
  type GoalEditorDependencies,
  type Submission,
} from './commands';
import { resolveEditorDraft, prepareFormPlan } from './initiative-task-links';
import {
  checkedEditorRead,
  checkDraftRead,
  createDraftRemoval,
  createEditorReads,
  editorDraft,
  linkedKind,
  readOnlyPatch,
  type DraftConfirmation,
} from './linked-editor-intent';
import { WIPE_KEY } from '../core/records';
import { createSaveStatus, saveMessage } from './save-status';

export function createGoalEditor({
  facade,
  drafts,
  now,
  newId,
  onChange,
  onRead,
  readForStatus,
}: GoalEditorDependencies) {
  const initial: EditorView = { key: '', baseVer: absent, intent: recordIntent(), errors: [] };
  let view = initial;
  let formId = '';
  let generation = 0;
  let submission: Submission | undefined;
  let handoffVer: string | undefined;
  let confirmation: DraftConfirmation | undefined;
  let confirmedInput: Pick<EditorView, 'intent' | 'baseVer'> | undefined;
  const removeWithProof = createDraftRemoval(drafts);
  let scheduledSave:
    | { readonly timer: ReturnType<typeof setTimeout>; readonly cancel: () => void }
    | undefined;
  const lastHandoffByKey = new Map<string, number>();
  let dirty = false;
  let navigation = 0;
  const reads = createEditorReads(
    drafts,
    () => ({ id: formId, view, dirty: dirty && !confirmedInput }),
    (patch, opened) => {
      if (opened) ({ dirty, handoffVer } = opened);
      if (patch.wipe) cancelScheduledSave();
      update(patch);
    },
  );
  const status = createSaveStatus({
    read: readForStatus ?? ((keys) => facade.read(keys)),
    readSaveState: (keys) => facade.readSaveState(keys),
    now,
    onStatus(next) {
      if (next.state !== 'saved') confirmation = undefined;
      const saved = next.state === 'saved' && submission?.generation === generation;
      if (saved && linkedKind(view.key)) confirmedInput ??= view;
      update({
        status: next.state,
        message: view.readOnlyReason ?? saveMessage(next),
        ...(next.state === 'saved' && { deadline: undefined }),
        ...(saved && confirmedInput && { intent: editorIntent(view.record, view.source) }),
      });
      if (next.state === 'saved' && submission?.generation === generation && !confirmation) {
        const proof = { sent: submission, draft: currentDraft() };
        confirmation = proof;
        void removeConfirmed(proof);
      }
    },
  });

  function update(patch: Partial<EditorView>): void {
    view = { ...view, ...patch };
    onChange?.();
  }

  const currentDraft = () =>
    editorDraft(view, confirmedInput?.intent ?? view.intent, now(), handoffVer);

  function storeDraft(): void {
    drafts.write(view.key, currentDraft());
  }

  async function removeConfirmed(proof: DraftConfirmation): Promise<void> {
    const id = formId;
    const applicable = () =>
      formId === id &&
      confirmation === proof &&
      submission === proof.sent &&
      generation === proof.sent.generation &&
      !view.readOnly &&
      !view.wipe &&
      sameDraft(currentDraft(), proof.draft);
    const result = await removeWithProof(proof, applicable);
    if (!result || !applicable()) return;
    if (result === 'removed') dirty = false;
    update({ draftMessage: removalMessages[result] });
  }

  function invalidate(): void {
    generation += 1;
    handoffVer = undefined;
    confirmation = undefined;
    confirmedInput = undefined;
    status.invalidate(formId, generation);
  }

  function cancelScheduledSave(): void {
    if (!scheduledSave) return;
    clearTimeout(scheduledSave.timer);
    scheduledSave.cancel();
    scheduledSave = undefined;
  }

  function close(): void {
    cancelScheduledSave();
    status.close(formId);
    formId = '';
    submission = undefined;
    handoffVer = undefined;
    confirmation = undefined;
    confirmedInput = undefined;
    dirty = false;
    view = initial;
    onChange?.();
  }

  async function open(key: string, source?: string): Promise<void> {
    const turn = ++navigation;
    if (view.key) {
      const oldForm = formId;
      const oldGeneration = generation;
      const result = await drafts.flush();
      if (turn !== navigation || formId !== oldForm || generation !== oldGeneration) return;
      if (!result.ok) {
        update(leaveFailed);
        return;
      }
    }
    close();
    const id = newId();
    formId = id;
    update({ key, source, message: 'Загрузка…' });
    reads.open(key);
    const refresh = reads.begin();
    try {
      const snapshot = await facade.read([key, WIPE_KEY]);
      if (formId !== id) return;
      await refresh(snapshot);
      if (formId === id) onRead?.(snapshot);
    } catch {
      if (formId === id && !view.ready) update({ message: 'Не удалось прочитать данные.' });
    }
  }

  function editingText({ action }: GoalIntent = view.intent): boolean {
    return action === 'create' || action === 'edit';
  }

  function remainingDelay(): number {
    const lastHandoff = lastHandoffByKey.get(view.key);
    return lastHandoff === undefined ? 0 : Math.max(0, lastHandoff + EDIT_INTERVAL_MS - now());
  }

  function delaySave(delay: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        scheduledSave = undefined;
        resolve(save());
      }, delay);
      scheduledSave = { timer, cancel: resolve };
    });
  }

  function scheduleSave(): void {
    const blocked = view.busy || view.draftChoices || view.wipe;
    if (scheduledSave || blocked || linkedKind(view.key) || !editingText()) return;
    void delaySave(remainingDelay() || EDIT_INTERVAL_MS);
  }

  async function checkDraft(): Promise<void> {
    if (dirty && view.ready) await checkDraftRead(drafts, () => view, update);
  }

  function input(intent: GoalIntent): boolean {
    if (!view.ready || view.readOnly || view.draftChoices || view.wipe) return false;
    if (intent.action === 'close' || intent.action === 'revise') cancelScheduledSave();
    invalidate();
    dirty = true;
    update({ ...updatedInput, intent });
    storeDraft();
    scheduleSave();
    return true;
  }

  async function save(retry = false): Promise<void> {
    if (
      (!dirty && !(retry && submission)) ||
      view.busy ||
      view.readOnly ||
      view.draftChoices ||
      view.wipe
    )
      return;
    if (!retry && (view.awaitingRetry || submission?.generation === generation)) return;
    cancelScheduledSave();
    const delay = !retry && editingText() ? remainingDelay() : 0;
    return delay > 0 ? delaySave(delay) : submit(retry);
  }

  async function submit(retry: boolean): Promise<void> {
    const { key, source } = view;
    const { baseVer, intent } = confirmedInput ?? view;
    const id = formId;
    const epoch = generation;
    const currentForm = () => formId === id && generation === epoch;
    const previous = submission;
    status.close(id);
    confirmation = undefined;
    update({ busy: true, errors: [], deadline: undefined });
    reads.invalidate();
    try {
      const linking = linkedKind(key) || intent.fields.sphereTagKey !== undefined;
      const [snapshot, references] = await Promise.all([
        facade.read([key, WIPE_KEY]),
        linking ? facade.readBaseReferences?.() : undefined,
      ]);
      const checked = await checkedEditorRead(drafts, snapshot, key, source);
      if (!currentForm()) return;
      onRead?.(snapshot);
      if (checked.readOnlyReason) update(readOnlyPatch(checked));
      else if (checked.wipe) update({ wipe: checked.wipe });
      if (view.wipe || view.readOnly) return;
      const previousValue =
        previous?.generation === epoch && previous.write.key === key
          ? previous.write.value
          : undefined;
      const options = {
        state: snapshot,
        key,
        baseVer,
        intent,
        previousValue,
        handoffVer,
        at: now(),
        newId,
      };
      const prepared = prepareFormPlan(options, references);
      if ('choices' in prepared) {
        update({
          record: prepared.record,
          intent,
          draftChoices: prepared.choices,
          status: 'replaced',
          message: 'Заменено другой версией',
        });
        return;
      }
      if ('errors' in prepared) {
        update({ errors: prepared.errors, message: prepared.message });
        return;
      }
      const { plan, write } = prepared;
      const sent = { write, generation: epoch };
      submission = sent;
      update({ status: 'pending', awaitingRetry: false, message: 'Сохраняется…' });
      const refresh = reads.begin();
      const result = await handoffGoalPlan(
        facade,
        plan,
        write,
        (deadline) => {
          if (currentForm() && submission === sent && view.status !== 'saved') update({ deadline });
        },
        retry ? { forceSync: true } : { ...(editingText(intent) && { paceEditing: true }) },
      );
      if (result.applied) lastHandoffByKey.set(key, now());
      if (formId !== id) return;
      if (result.applied) acceptHandoff(write, baseVer, currentForm());
      if (!currentForm()) return;
      await refresh(result.refreshed, currentForm);
      if (!currentForm()) return;
      await status.track({ formId: id, generation: epoch, planId: newId() }, plan);
      if (!currentForm()) return;
      if (result.message)
        update({ status: 'unknown', message: view.readOnlyReason ?? result.message });
    } catch {
      if (currentForm()) update({ status: 'unknown', message: 'Состояние неизвестно' });
    } finally {
      if (formId === id) {
        update({ busy: false });
        if (!currentForm()) scheduleSave();
      }
    }
  }

  function acceptHandoff(write: Submission['write'], baseVer: string, sameIntent: boolean): void {
    if (view.key !== write.key || view.baseVer !== baseVer || view.wipe) return;
    const record = editorRecordAt({ entries: { [write.key]: write.value } }, write.key);
    if (!record) return;
    reads.invalidate();
    if (sameIntent) handoffVer = record.ver;
    if (confirmedInput) confirmedInput = { ...confirmedInput, baseVer: record.ver };
    update({ baseVer: record.ver, record });
    storeDraft();
  }

  async function resolveDraft(choice: DraftChoice, target?: string): Promise<void> {
    if (!view.draftChoices?.includes(choice) || view.wipe || view.busy) return;
    const id = formId;
    const current = () => formId === id && !view.wipe;
    invalidate();
    reads.invalidate();
    update({ busy: true });
    try {
      await resolveEditorDraft({
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
        markClean: () => {
          dirty = false;
        },
      });
    } catch {
      if (current()) update({ message: 'Не удалось прочитать данные.' });
    } finally {
      if (formId === id) update({ busy: false });
    }
  }

  async function resolveWipe(choice: 'keep' | 'discard'): Promise<void> {
    if (!view.wipe || view.busy) return;
    const { ver } = view.wipe;
    const id = formId;
    const discard = choice === 'discard';
    update({ busy: true });
    const handled = await handleDraftWipe(drafts, ver, discard, () => formId === id);
    if (formId !== id) return;
    if (handled) reads.handledWipe(ver);
    if (handled && discard) {
      dirty = false;
      invalidate();
    }
    update(afterWipe(view, Boolean(handled), discard, ver));
  }

  async function leave(choice?: LeaveChoice): Promise<boolean> {
    if (choice === 'stay') {
      update({ leaveChoices: undefined });
      return false;
    }
    const { key } = view;
    const id = formId;
    if (choice === 'discard') {
      drafts.remove(key);
      close();
      return true;
    }
    const result = await drafts.flush();
    if (id !== formId) return false;
    if (result.ok) close();
    else update(leaveFailed);
    return result.ok;
  }

  return {
    open,
    checkDraft,
    beginRefresh: () => reads.begin(),
    refresh: (snapshot: ReadSnapshot, latest: () => boolean) => reads.begin()(snapshot, latest),
    close,
    input,
    save,
    leave,
    resolveDraft,
    resolveWipe,
    retry: () => save(true),
    async retryDraftRemoval() {
      if (view.wipe) return;
      if (confirmation) {
        await removeConfirmed(confirmation);
        return;
      }
      const id = formId;
      const result = await drafts.flush();
      if (id === formId) update({ draftMessage: result.ok ? undefined : draftError });
    },
    view: () => view,
  };
}

export type GoalEditor = ReturnType<typeof createGoalEditor>;
