import { describe, expect, it } from 'vitest';
import { getMissingKrFields, type KrDraft } from '../../src/core/kr';

const filledDraft: KrDraft = {
  statement: 'Reduce cycle time',
  baseline: '10 days',
  dataSource: 'Weekly report',
  target: '5 days',
};

describe('getMissingKrFields', () => {
  it('All required fields are filled', () => {
    expect(getMissingKrFields(filledDraft)).toEqual([]);
  });

  it('Statement is empty', () => {
    const draft: KrDraft = { ...filledDraft, statement: '' };

    expect(getMissingKrFields(draft)).toEqual(['statement']);
  });

  it('Baseline is empty', () => {
    const draft: KrDraft = { ...filledDraft, baseline: '' };

    expect(getMissingKrFields(draft)).toEqual(['baseline']);
  });

  it('Data source is empty', () => {
    const draft: KrDraft = { ...filledDraft, dataSource: '' };

    expect(getMissingKrFields(draft)).toEqual(['dataSource']);
  });

  it('Target is empty', () => {
    const draft: KrDraft = { ...filledDraft, target: '' };

    expect(getMissingKrFields(draft)).toEqual(['target']);
  });

  it('A filled field has surrounding spaces', () => {
    const draft: KrDraft = {
      statement: '  Reduce cycle time  ',
      baseline: '  10 days  ',
      dataSource: '  Weekly report  ',
      target: '  5 days  ',
    };

    expect(getMissingKrFields(draft)).toEqual([]);
  });

  it('Several required fields are empty', () => {
    const draft: KrDraft = {
      target: '',
      dataSource: '',
      baseline: '10 days',
      statement: '',
    };

    expect(getMissingKrFields(draft)).toEqual(['statement', 'dataSource', 'target']);
  });

  it('All required fields are empty', () => {
    const draft: KrDraft = {
      target: '',
      dataSource: '',
      baseline: '',
      statement: '',
    };

    expect(getMissingKrFields(draft)).toEqual(['statement', 'baseline', 'dataSource', 'target']);
  });
});
