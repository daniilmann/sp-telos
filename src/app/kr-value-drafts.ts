import { isPlan, type Plan, type PlanState } from '../core/plan';
import * as records from '../core/records';
import type { Draft, DraftStore } from '../platform/draft-store';
import { absent, krValueWrite } from './commands';

export const action = 'record-kr-value';

export interface KrValueDraft {
  readonly key: string;
  readonly krKey: string;
  readonly value: string;
  readonly expectedWipe: string;
  draft: Draft;
  readonly sent?: { plan: Plan; write: Plan['writes'][number]; ver: string };
}

function readFact(key: string, raw: string) {
  const decoded = records.decodeRecord(key, raw);
  return decoded.ok && 'kind' in decoded.value && decoded.value.kind === 'kr-value'
    ? { ...decoded.value, key }
    : undefined;
}

export function readDraft(key: string, draft?: Draft): KrValueDraft | undefined {
  if (!draft || !records.isRecordKeyOfKind(key, 'kr-value')) return undefined;
  const { krKey, value, expectedWipe, plan } = draft.fields;
  if (
    draft.fields.action !== action ||
    typeof krKey !== 'string' ||
    !records.isRecordKeyOfKind(krKey, 'kr') ||
    typeof value !== 'string' ||
    (expectedWipe !== absent && !records.isUuid(expectedWipe))
  )
    return undefined;
  const input = { key, krKey, value, expectedWipe, draft };
  if (!isPlan(plan)) return plan === undefined && draft.baseVer === absent ? input : undefined;
  const write = krValueWrite(plan);
  if (write?.key !== key || write.krKey !== krKey) return undefined;
  const fact = readFact(key, write.value);
  if (fact?.value !== value || ![absent, fact.ver].includes(draft.baseVer)) return undefined;
  return { ...input, sent: { plan, write, ver: fact.ver } };
}

export async function listKrValueDrafts(drafts: DraftStore, keys: readonly string[]) {
  const read = async (key: string) => readDraft(key, (await drafts.read(key)).value);
  const rows = await Promise.all(
    keys.filter((key) => key.startsWith(records.KR_VALUE_PREFIX)).map(read),
  );
  return rows.filter((item) => item !== undefined).sort((a, b) => b.draft.at - a.draft.at);
}

export function readMeasurements(krKey: string, entries?: PlanState['entries']) {
  return Object.entries(entries ?? {})
    .flatMap(([key, raw]) => {
      if (!key.startsWith(records.KR_VALUE_PREFIX)) return [];
      const fact = readFact(key, raw);
      return fact?.krKey === krKey ? [fact] : [];
    })
    .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
