import { describe, expect, it } from 'vitest';
import {
  checkBundleInputs,
  checkFileSet,
  checkManifest,
  checkNoTestOnlyFiles,
  checkScriptSyntax,
  checkTemplate,
  findUnknownMethods,
  findWriteMethods,
  parseImageVersion,
  ZIP_FILES,
} from '../../scripts/bundle-checks.mjs';

describe('checkScriptSyntax', () => {
  it('accepts an es2020 IIFE script', () => {
    expect(checkScriptSyntax('ok', '(()=>{const a=b?.c??1;console.log(a)})();')).toEqual([]);
  });

  it('rejects dynamic import()', () => {
    const problems = checkScriptSyntax('dyn', "(()=>{import('x')})();");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no-restricted-syntax');
  });

  it('rejects top-level export as a parse error', () => {
    const problems = checkScriptSyntax('esm', 'export const a = 1;');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('parse error');
  });

  it('rejects syntax newer than es2020', () => {
    expect(checkScriptSyntax('new', 'let a; a ??= 1;')).toHaveLength(1);
  });
});

describe('write methods', () => {
  it('finds write method names as whole words only', () => {
    expect(findWriteMethods('PluginAPI.addTask(x);foo.addTaskList()')).toEqual(['addTask']);
    expect(findWriteMethods('PluginAPI.loadSyncedData()')).toEqual([]);
  });

  it('reports listed methods missing from the type definitions', () => {
    const types = 'addTask(data: X): Promise<string>;\nstartTracking?(id: string): Promise<void>;';
    expect(findUnknownMethods(types, ['addTask', 'startTracking', 'removeEverything'])).toEqual([
      'removeEverything',
    ]);
  });
});

describe('source and template checks', () => {
  it('allows bundle inputs only from src and preact', () => {
    expect(checkBundleInputs(['src/a.ts', 'node_modules/preact/dist/x.js'])).toEqual([]);
    expect(checkBundleInputs(['tests/fakes/x.ts', 'node_modules/other/x.js'])).toHaveLength(2);
  });

  it('rejects test-only files in src', () => {
    expect(checkNoTestOnlyFiles(['core/plan.ts'])).toEqual([]);
    expect(
      checkNoTestOnlyFiles(['core/plan.test.ts', 'ui/a.spec.tsx', 'fakes', 'x/fixtures/a.json']),
    ).toHaveLength(4);
  });

  it('rejects template references to files or URLs', () => {
    expect(checkTemplate('<script>/*JS*/</script>')).toEqual([]);
    expect(checkTemplate('<script src="a.js"></script>')).toHaveLength(1);
  });
});

describe('package checks', () => {
  const base = {
    id: 'sp-telos',
    version: '0.1.0',
    minSupVersion: '20.0.0',
  };

  it('reads the version of the server image', () => {
    expect(parseImageVersion('ghcr.io/org/image:v20.0.0@sha256:abc\n')).toBe('20.0.0');
    expect(parseImageVersion('ghcr.io/org/image:latest')).toBeNull();
  });

  it('accepts a matching manifest', () => {
    expect(checkManifest(base, { version: '0.1.0', imageVersion: '20.0.0' })).toEqual([]);
  });

  it('rejects forbidden keys even when empty, and version drift', () => {
    const problems = checkManifest(
      { ...base, permissions: [], minSupVersion: '19.0.0' },
      { version: '0.2.0', imageVersion: '20.0.0' },
    );
    expect(problems).toHaveLength(3);
  });

  it('requires exactly the allowed files', () => {
    expect(checkFileSet([...ZIP_FILES])).toEqual([]);
    expect(checkFileSet([...ZIP_FILES.slice(1), 'extra.txt'])).toHaveLength(2);
  });
});
