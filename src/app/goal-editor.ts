import { sameDraft, type Draft } from '../platform/draft-store';
import {
  handleDraftWipe,
  handoffGoalPlan,
  removeConfirmedDraft,
  type ReadSnapshot,
} from '../platform/facade';
import {
  absent,
  EDIT_INTERVAL_MS,
  updatedInput,
  draftError,
  removalMessages,
  leaveFailed,
  afterWipe,
  editorRecordAt,
  recordIntent,
  type DraftChoice,
  type EditorView,
  type LeaveChoice,
  type GoalIntent,
  type GoalDraft,
  type GoalEditorDependencies,
  type Submission,
} from './commands';
import { resolveEditorDraft, prepareFormPlan, refreshedView } from './initiative-task-links';
import { linkedKind, pendingWipe, readEditor } from './linked-editor-intent';
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
  let confirmation: { readonly sent: Submission; readonly draft: Draft } | undefined;
  let removing: typeof confirmation;
  let scheduledSave:
    | { readonly timer: ReturnType<typeof setTimeout>; readonly cancel: () => void }
    | undefined;
  const lastHandoffByKey = new Map<string, number>();
  let dirty = false;
  let navigation = 0;
  const status = createSaveStatus({
    read: readForStatus ?? ((keys) => facade.read(keys)),
    readSaveState: (keys) => facade.readSaveState(keys),
    now,
    onStatus(next) {
      if (next.state !== 'saved') confirmation = undefined;
      update({
        status: next.state,
        message: saveMessage(next),
        ...(next.state === 'saved' && { deadline: undefined }),
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

  function currentDraft(): GoalDraft {
    return {
      at: now(),
      ...(handoffVer && { handoffVer }),
      baseVer: view.baseVer,
      fields: { ...view.intent.fields, action: view.intent.action },
    };
  }

  function storeDraft(): void {
    drafts.write(view.key, currentDraft());
  }

  async function removeConfirmed(proof: NonNullable<typeof confirmation>): Promise<void> {
    const id = formId;
    const applicable = () =>
      formId === id &&
      confirmation === proof &&
      submission === proof.sent &&
      generation === proof.sent.generation &&
      sameDraft(currentDraft(), proof.draft);
    if (!applicable() || removing === proof) return;
    removing = proof;
    try {
      const result = await removeConfirmedDraft(
        drafts,
        proof.sent.write.key,
        proof.draft,
        applicable,
      );
      if (!applicable() || !result) return;
      if (result === 'removed') dirty = false;
      update({ draftMessage: removalMessages[result] });
    } finally {
      if (removing === proof) removing = undefined;
    }
  }

  function invalidate(): void {
    generation += 1;
    handoffVer = undefined;
    confirmation = undefined;
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
    update({ key, message: 'Загрузка…' });
    try {
      const opened = await readEditor(facade, drafts, key, source);
      if (formId !== id) return;
      dirty = opened.dirty;
      handoffVer = opened.handoffVer;
      onRead?.(opened.snapshot);
      update(opened.view);
    } catch {
      if (formId === id) update({ message: 'Не удалось прочитать данные.' });
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
    if (!dirty || !view.ready) return;
    const current = view;
    const result = await drafts.read(current.key);
    if (view === current && result.failed && !view.draftMessage)
      update({ draftMessage: draftError });
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
    const { key, baseVer, intent } = view;
    const id = formId;
    const epoch = generation;
    const currentForm = () => formId === id && generation === epoch;
    const previous = submission;
    status.close(id);
    confirmation = undefined;
    update({ busy: true, errors: [], deadline: undefined });
    try {
      const linking = linkedKind(key) || intent.fields.sphereTagKey !== undefined;
      const [snapshot, references] = await Promise.all([
        facade.read([key, WIPE_KEY]),
        linking ? facade.readBaseReferences?.() : undefined,
      ]);
      const wipe = await pendingWipe(drafts, snapshot);
      if (!currentForm()) return;
      onRead?.(snapshot);
      if (snapshot.readOnlyReason) {
        update({
          readOnly: true,
          readOnlyReason: snapshot.readOnlyReason,
          message: snapshot.readOnlyReason,
        });
        return;
      }
      if (wipe) {
        update({ wipe });
        return;
      }
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
      await status.track({ formId: id, generation: epoch, planId: newId() }, plan);
      if (!currentForm()) return;
      if (result.message) update({ status: 'unknown', message: result.message });
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
    if (view.key !== write.key || view.baseVer !== baseVer) return;
    const record = editorRecordAt({ entries: { [write.key]: write.value } }, write.key);
    if (!record) return;
    if (sameIntent) handoffVer = record.ver;
    update({ baseVer: record.ver, record });
    storeDraft();
  }

  async function resolveDraft(choice: DraftChoice, target?: string): Promise<void> {
    if (!view.draftChoices?.includes(choice) || view.wipe || view.busy) return;
    const id = formId;
    const current = () => formId === id;
    invalidate();
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
      if (current()) update({ busy: false });
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
    if (handled && discard) {
      dirty = false;
      handoffVer = undefined;
    }
    update(afterWipe(view, Boolean(handled), discard));
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
    async refresh(snapshot: ReadSnapshot, latest: () => boolean) {
      const id = formId;
      const wipe = await pendingWipe(drafts, snapshot);
      if (!latest() || !id || formId !== id) return;
      if (wipe) cancelScheduledSave();
      update(refreshedView(view, snapshot, snapshot.readOnlyReason, wipe, dirty));
    },
    close,
    input,
    save,
    leave,
    resolveDraft,
    resolveWipe,
    retry: () => save(true),
    async retryDraftRemoval() {
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
