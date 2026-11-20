import type { Project } from '@super-productivity/plugin-api';

export const BASE_READ_METHODS = ['getAppState', 'getTasks', 'getArchivedTasks'] as const;

interface BaseReference {
  readonly id: string;
  readonly title: string;
}

interface ProjectReference extends BaseReference {
  readonly isArchived: boolean;
}

export interface BaseReferences {
  readonly projects?: Readonly<Record<string, ProjectReference>>;
  readonly tags?: Readonly<Record<string, BaseReference>>;
  readonly tasks?: Readonly<Record<string, BaseReference>>;
}

async function available<Value>(read: () => Value | Promise<Value>): Promise<Value | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

function references(prefix: 'tag' | 'task', objects: readonly BaseReference[]) {
  return Object.fromEntries(objects.map(({ id, title }) => [`${prefix}:${id}`, { id, title }]));
}

function projectReferences(projects: readonly Readonly<Project>[]) {
  return Object.fromEntries(
    projects.map(({ id, title, isArchived }) => [
      `project:${id}`,
      { id, title, isArchived: isArchived === true },
    ]),
  );
}

export async function readBaseReferences(
  groups: readonly (keyof BaseReferences)[] = ['projects', 'tags', 'tasks'],
): Promise<BaseReferences> {
  const projectsRequested = groups.includes('projects');
  const tagsRequested = groups.includes('tags');
  const tasksRequested = groups.includes('tasks');
  const [state, active, archived] = await Promise.all([
    projectsRequested || tagsRequested ? available(() => PluginAPI.getAppState()) : undefined,
    tasksRequested
      ? available(async () => references('task', await PluginAPI.getTasks()))
      : undefined,
    tasksRequested
      ? available(async () => references('task', await PluginAPI.getArchivedTasks()))
      : undefined,
  ]);
  const [projects, tags] = await Promise.all([
    state && projectsRequested
      ? available(() => projectReferences(Object.values(state.projects)))
      : undefined,
    state && tagsRequested
      ? available(() => references('tag', Object.values(state.tags)))
      : undefined,
  ]);
  return {
    ...(projects && { projects }),
    ...(tags && { tags }),
    ...((archived || active) && { tasks: { ...archived, ...active } }),
  };
}
