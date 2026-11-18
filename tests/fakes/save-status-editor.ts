import { vi } from 'vitest';
import { createGoalEditor } from '../../src/app/goal-editor';
import type { PlanState } from '../../src/core/plan';
import { createDraftStore } from '../../src/platform/draft-store';
import { createHostFacade, inspectRecords } from '../../src/platform/facade';
import { apply, checkCompatibility } from '../../src/platform/sp-facade';
import { createFakeDraftDatabase } from './fake-draft-database';
import { createFakeHost } from './fake-facade';

export const input = { action: 'edit', fields: { statement: 'Локальный ввод' } } as const;

export async function openSaveStatusEditor(initial: PlanState, key: string, savedAt: number) {
  const host = createFakeHost(initial);
  const database = createFakeDraftDatabase();
  const drafts = createDraftStore(database.factory);
  vi.stubGlobal('PluginAPI', host.api);
  const facade = {
    ...createHostFacade(),
    apply: vi.fn(apply),
    async read() {
      const { state, readOnlyReason } = await checkCompatibility([key]);
      return { ...inspectRecords(state), ...(readOnlyReason && { readOnlyReason }) };
    },
  };
  const form = createGoalEditor({
    facade,
    drafts,
    now: Date.now,
    newId: () => crypto.randomUUID(),
  });
  await form.open(key);

  async function commitDrafts() {
    await vi.advanceTimersByTimeAsync(0);
    for (const transaction of database.mutations) {
      if (transaction.finished) continue;
      transaction.succeedRequest();
      transaction.complete();
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  async function submit() {
    form.input(input);
    await commitDrafts();
    await form.save();
    await host.commitAfter(Promise.resolve());
    host.acknowledge(key, savedAt);
    return host.api.getSyncedDataSaveState([key]);
  }

  const disk = () => database.committedRows('sp-telos-drafts').get(key);
  return { host, facade, form, database, commitDrafts, submit, disk };
}
