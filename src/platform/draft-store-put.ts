import type { Draft } from './draft-store';

const BYTE_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();
type PutGuard = { claim: () => boolean } | { replace: (stored: unknown) => boolean };

function draftBytes(value: unknown): number {
  // The other stored value is the wipe version, a string outside the draft budget.
  return value === undefined || typeof value === 'string'
    ? 0
    : encoder.encode(JSON.stringify(value)).byteLength;
}

export function putDraft(
  transaction: IDBTransaction,
  store: IDBObjectStore,
  key: string,
  draft: Draft,
  guard: PutGuard,
): void {
  // Overlapping readwrite transactions on this store run serially, even across connections.
  const rows: IDBRequest<unknown[]> = store.getAll();
  const previous: IDBRequest<unknown> = store.get(key);
  previous.onsuccess = () => {
    try {
      if ('claim' in guard && (!guard.claim() || previous.result !== undefined)) {
        transaction.abort();
        return;
      }
      if ('replace' in guard && !guard.replace(previous.result)) return;
      const total = rows.result.reduce<number>((sum, row) => sum + draftBytes(row), 0);
      if (total - draftBytes(previous.result) + draftBytes(draft) <= BYTE_LIMIT) {
        if ('claim' in guard) store.add(draft, key);
        else store.put(draft, key);
        return;
      }
    } catch {
      // Serialization or a synchronous put error also leaves the intent pending.
    }
    transaction.abort();
  };
}
