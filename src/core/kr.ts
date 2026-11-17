export interface KrDraft {
  readonly statement: string;
  readonly baseline: string;
  readonly dataSource: string;
  readonly target: string;
}

export function getMissingKrFields(draft: KrDraft): (keyof KrDraft)[] {
  const requiredFields: (keyof KrDraft)[] = ['statement', 'baseline', 'dataSource', 'target'];
  return requiredFields.filter((key) => draft[key] === '');
}
