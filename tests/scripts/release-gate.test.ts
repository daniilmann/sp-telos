/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  uses?: string;
  run?: string;
  if?: string | boolean;
  'continue-on-error'?: boolean | string;
  'working-directory'?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

interface Job extends Step {
  name?: string;
  needs?: string | string[];
  permissions?: Permissions;
  steps?: Step[];
}

type Permissions = string | Record<string, string>;

interface Workflow {
  permissions?: Permissions;
  jobs: Record<string, Job>;
}

function read(path: string): string {
  return readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
}

function workflow(file: string): Workflow {
  return parse(read('.github/workflows/' + file)) as Workflow;
}

const gate = workflow('gate.yml');
const jobs = Object.entries(gate.jobs);
const pack = /^npm run pack\b/m;
const stand = /^npm run test:e2e\b/m;
const audit = /^npm audit --omit=dev --audit-level=high\b/m;

function runs(job: Job, command: RegExp): boolean {
  return (job.steps ?? []).some((step) => command.test(step.run ?? ''));
}

function canWriteContents(permissions: Permissions | undefined): boolean {
  return (
    permissions === 'write-all' ||
    (typeof permissions === 'object' && permissions.contents === 'write')
  );
}

function publishes(step: Step): boolean {
  return (
    /\bgh\s+release\s+(?:create|upload)\b/.test(step.run ?? '') ||
    /(?:action-gh-release|actions\/create-release)@/.test(step.uses ?? '')
  );
}

function publishers(): [string, Job][] {
  const candidates = jobs.filter(
    ([, job]) => canWriteContents(job.permissions) || (job.steps ?? []).some(publishes),
  );
  expect(candidates.length, 'gate.yml must define a release publication job').toBeGreaterThan(0);
  return candidates;
}

function needs(job: Job): string[] {
  return typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []);
}

// Check the mandatory conjuncts of the job's actual expression. A disjunction
// cannot establish a mandatory check with this restricted form.
function conjuncts(condition: Job['if']): string[] {
  if (typeof condition !== 'string' || condition.includes('||')) return [];
  const terms = condition
    .replace(/\s/g, '')
    .replace(/^\$\{\{|\}\}$/g, '')
    .split('&&');
  if (terms.some((term) => term.split('(').length !== term.split(')').length)) return [];
  return terms.map((term) => {
    while (term.startsWith('(') && term.endsWith(')')) term = term.slice(1, -1);
    return term;
  });
}

function requiresSuccess(job: Job, dependency: string): boolean {
  const condition = String(job.if ?? '');
  // Actions supplies success() unless the expression uses a status function.
  if (!/\b(?:always|cancelled|failure|success)\s*\(/i.test(condition)) return true;
  const terms = conjuncts(job.if);
  return terms.includes('success()') || terms.includes(`needs.${dependency}.result=='success'`);
}

function mandatoryJobs(job: Job, visited = new Set<string>()): Set<string> {
  for (const id of needs(job)) {
    const dependency = gate.jobs[id];
    expect(dependency, `Missing dependency job: ${id}`).toBeDefined();
    if (!dependency || visited.has(id) || !requiresSuccess(job, id)) continue;
    expect(dependency['continue-on-error'] ?? false, id).toBe(false);
    visited.add(id);
    mandatoryJobs(dependency, visited);
  }
  return visited;
}

function checkRequiredStep(job: Job, command: RegExp): void {
  const step = job.steps?.find((candidate) => command.test(candidate.run ?? ''));
  expect(step, `Missing required command ${command.source}`).toBeDefined();
  expect(step?.['continue-on-error'] ?? false).toBe(false);
  expect([undefined, true, 'success()', '${{ success() }}']).toContain(step?.if);
}

function checkCandidateCheckout(job: Job): void {
  const checkouts = (job.steps ?? []).filter((step) => step.uses?.startsWith('actions/checkout@'));
  expect(checkouts.length).toBeGreaterThan(0);
  for (const step of checkouts) {
    if (step.with?.path) continue;
    expect([undefined, '${{ github.repository }}']).toContain(step.with?.repository);
    expect([undefined, '${{ github.sha }}']).toContain(step.with?.ref);
  }
  expect(checkouts.some((step) => !step.with?.path)).toBe(true);
}

it('ordinary plugin tag requires stand audit and zip before publication', () => {
  for (const [id, publication] of publishers()) {
    const mandatory = mandatoryJobs(publication);
    expect(
      jobs.some(([candidate, job]) => mandatory.has(candidate) && job.name === 'Fast gate'),
      `${id} must require a successful Fast gate`,
    ).toBe(true);
    for (const command of [stand, audit, pack]) {
      // A mandatory needs edge blocks failure, skipped, and cancelled results.
      const required = jobs.find(
        ([candidate, job]) => mandatory.has(candidate) && runs(job, command),
      );
      expect(required, `${id} must require successful ${command.source}`).toBeDefined();
      if (!required) continue;
      checkRequiredStep(required[1], command);
      if (command === pack) checkCandidateCheckout(required[1]);
    }
    const releaseStep = publication.steps?.find(publishes);
    expect(releaseStep, `${id} must publish the gated ZIP`).toBeDefined();
    const target = releaseStep?.with?.target_commitish;
    if (target !== '${{ github.sha }}') {
      expect(releaseStep?.run).toMatch(
        /--target(?:=|\s+)["']?(?:\$\{?GITHUB_SHA\}?|\$\{\{\s*github\.sha\s*\}\})/,
      );
    }
  }
});

it('branch and manual runs cannot publish', () => {
  expect(canWriteContents(gate.permissions)).toBe(false);
  for (const [id, job] of publishers()) {
    const terms = conjuncts(job.if);
    expect(terms, `${id} must exclude workflow_dispatch even on a tag`).toContain(
      "github.event_name=='push'",
    );
    expect(
      terms.some((term) =>
        ["github.ref_type=='tag'", "startswith(github.ref,'refs/tags/')"].includes(
          term.toLowerCase(),
        ),
      ),
      `${id} must exclude branch pushes`,
    ).toBe(true);
  }
});

it('branch types cannot satisfy the release gate', () => {
  const branchFile = 'plugin-api-branch-gate.yml';
  const branchJobs = Object.keys(workflow(branchFile).jobs);
  for (const [, job] of jobs) {
    expect(needs(job).filter((id) => branchJobs.includes(id))).toEqual([]);
    expect(job.uses ?? '').not.toContain(branchFile);
  }

  const api = '@super-productivity/plugin-api';
  const manifest = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
  const lock = JSON.parse(read('package-lock.json')) as {
    packages: Record<
      string,
      { dependencies?: Record<string, string>; resolved?: string; integrity?: string }
    >;
  };
  const release = manifest.dependencies[api];
  expect(release).toMatch(
    /^https:\/\/github\.com\/[^/]+\/super-productivity\/releases\/download\/[^/]+\/super-productivity-plugin-api-[^/]+\.tgz$/,
  );
  expect(lock.packages['']?.dependencies?.[api]).toBe(release);
  expect(lock.packages['node_modules/' + api]?.resolved).toBe(release);
  expect(lock.packages['node_modules/' + api]?.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);

  for (const command of [pack, stand]) {
    const consumers = jobs.filter(([, job]) => runs(job, command));
    expect(
      consumers.length,
      `gate.yml must run ${command.source} against Release types`,
    ).toBeGreaterThan(0);
    for (const [, job] of consumers) {
      checkCandidateCheckout(job);
      const steps = job.steps ?? [];
      const install = steps.findIndex(
        (step) => /^npm ci$/m.test(step.run ?? '') && !step['working-directory'],
      );
      checkRequiredStep(job, /^npm ci$/m);
      const consume = steps.findIndex((step) => command.test(step.run ?? ''));
      expect(install).toBeGreaterThanOrEqual(0);
      expect(install).toBeLessThanOrEqual(consume);
      for (const step of steps.slice(0, consume + 1)) {
        const script = step.run ?? '';
        expect(script).not.toMatch(/plugin-api-branch-gate|plugin-api-types-|npm pkg set/);
        for (const line of script.split('\n')) {
          if (line.includes('plugin-api')) {
            expect(line).not.toMatch(/npm (?:i|install|link) |file:/);
          }
        }
        if (step.uses?.startsWith('actions/download-artifact@')) {
          expect(step.with?.['run-id']).toBeUndefined();
          expect(step.with?.repository).toBeUndefined();
        }
      }
    }
  }
});
