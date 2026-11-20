import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlan } from '../../src/core/plan';
import { linkedRecordKey, matchesLinkedRecord } from '../../src/platform/linked-record-keys';
import { collideOnLinkedKey, versionOf } from '../fakes/fake-facade';

// UUIDv5 namespace 6677f4a3-a438-54c4-9e72-a4cf18f83b4d.
const vectors = [
  ['project:V2a91_nAn0XWz4Df79Qre', 'initiative:b072ff74-faf2-5d4d-8422-68048d6bbde4'],
  ['task:rpt_Sk9例', 'task-meta:22ec6855-1751-54b3-bfb6-4b64c14d7ba2'],
  ['project:rpt_Sk9例', 'initiative:36962dde-4b9e-5895-b306-423ea8d371fd'],
  ['project:Alpha', 'initiative:9aadfe07-59b8-50b0-9397-66ba4710ae87'],
  ['project:alpha', 'initiative:ba09e619-3770-5eb9-a687-791b27e7f521'],
  ['task:\u00e9', 'task-meta:9d22cb66-7485-56a3-a4f8-1167962af710'],
  ['task:e\u0301', 'task-meta:7da66cba-7995-5b51-8b61-b6df2fbc1abc'],
] as const;

afterEach(() => vi.restoreAllMocks());

describe('Derive stable keys from opaque project and task IDs', () => {
  it.each(vectors)('derives %s repeatably', async (source, key) => {
    expect(await linkedRecordKey(source)).toBe(key);
    expect(await linkedRecordKey(source)).toBe(key);
  });

  it('keeps the key stable while two plans get their own versions', async () => {
    const source = 'task:rpt_Sk9例';
    const firstVer = '20000000-0000-4000-8000-000000000001';
    const nextVer = '20000000-0000-4000-8000-000000000002';
    const build = async (base: string, ver: string) =>
      buildPlan(
        'manual',
        [
          {
            key: await linkedRecordKey(source),
            base,
            record: { kind: 'task-meta', taskKey: source },
          },
        ],
        { at: 10, newId: () => ver },
      ).writes[0]!;

    const first = await build('absent', firstVer);
    const next = await build(firstVer, nextVer);
    expect(first.key).toBe(vectors[1][1]);
    expect(next.key).toBe(first.key);
    expect(next.base).toBe(firstVer);
    expect(versionOf(first)).toBe(firstVer);
    expect(versionOf(next)).toBe(nextVer);
  });
});

describe('Reject a mismatched canonical key or source reference', () => {
  it('rejects a different key even when both source references match', async () => {
    const [source] = vectors[0];
    expect(await matchesLinkedRecord(vectors[4][1], source, source)).toBe(false);
  });

  it('checks source bytes independently of a hash collision', async () => {
    const [source, key] = vectors[5];
    const [different] = vectors[6];
    await collideOnLinkedKey(source);

    expect(await linkedRecordKey(different)).toBe(key);
    expect(await matchesLinkedRecord(key, source, source)).toBe(true);
    expect(await matchesLinkedRecord(key, different, source)).toBe(false);
  });
});
