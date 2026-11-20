import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBaseReferences } from '../../src/platform/base-references';
import { baseAppState, baseProject, baseTag, baseTask, createFakeHost } from '../fakes/fake-facade';

const projects = { p: baseProject('p', 'Archived project', true) };
const tags = { release: baseTag('release', 'Release') };
const active = [baseTask('active', 'Active only'), baseTask('shared', 'Active title')];
const archived = [baseTask('archived', 'Archived only'), baseTask('shared', 'Archived title')];

function baseHost() {
  const host = createFakeHost();
  host.api.getAppState.mockResolvedValue(baseAppState(projects, tags));
  host.api.getTasks.mockResolvedValue(active);
  host.api.getArchivedTasks.mockResolvedValue(archived);
  vi.stubGlobal('PluginAPI', host.api);
  return host.api;
}

afterEach(() => vi.unstubAllGlobals());

describe('Resolve archived objects and tolerate an empty archive read', () => {
  it.each(['empty', 'rejected'] as const)(
    'keeps available objects when the archive is %s',
    async (failure) => {
      const api = baseHost();
      const first = await readBaseReferences();
      expect(first).toMatchObject({
        projects: { 'project:p': { title: 'Archived project', isArchived: true } },
        tags: { 'tag:release': { title: 'Release' } },
        tasks: {
          'task:active': { title: 'Active only' },
          'task:archived': { title: 'Archived only' },
          'task:shared': { title: 'Active title' },
        },
      });

      if (failure === 'empty') api.getArchivedTasks.mockResolvedValue([]);
      else api.getArchivedTasks.mockRejectedValue(new Error('Archive read failed.'));
      api.getTasks.mockResolvedValue([baseTask('active', 'Renamed active task'), active[1]!]);

      const refreshed = await readBaseReferences();
      expect(refreshed).toMatchObject({
        projects: first.projects,
        tags: first.tags,
        tasks: {
          'task:active': { title: 'Renamed active task' },
          'task:shared': { title: 'Active title' },
        },
      });
      expect(refreshed.tasks).not.toHaveProperty('task:archived');
      expect(api.getAppState).toHaveBeenCalledTimes(2);
      expect(api.getTasks).toHaveBeenCalledTimes(2);
      expect(api.getArchivedTasks).toHaveBeenCalledTimes(2);
      expect(api.persistDataSynced).not.toHaveBeenCalled();
    },
  );

  it('keeps archive tasks when the active read fails', async () => {
    const api = baseHost();
    api.getTasks.mockRejectedValue(new Error('Active tasks read failed.'));
    const snapshot = await readBaseReferences();
    expect(snapshot).toMatchObject({
      projects: { 'project:p': { isArchived: true } },
      tags: { 'tag:release': { title: 'Release' } },
      tasks: {
        'task:archived': { title: 'Archived only' },
        'task:shared': { title: 'Archived title' },
      },
    });
    expect(snapshot.tasks).not.toHaveProperty('task:active');
    expect(api.persistDataSynced).not.toHaveBeenCalled();
  });

  it('keeps task reads available when the public state read fails', async () => {
    const api = baseHost();
    api.getAppState.mockRejectedValue(new Error('Public state read failed.'));
    const snapshot = await readBaseReferences();
    expect(snapshot).toMatchObject({
      tasks: {
        'task:active': { title: 'Active only' },
        'task:archived': { title: 'Archived only' },
        'task:shared': { title: 'Active title' },
      },
    });
    expect(snapshot.projects ?? {}).not.toHaveProperty('project:p');
    expect(snapshot.tags ?? {}).not.toHaveProperty('tag:release');
    expect(api.persistDataSynced).not.toHaveBeenCalled();
  });
});
