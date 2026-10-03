import { act, renderHook } from '@testing-library/react-native';

import type { HerdrClient } from '@/lib/herdr/client';
import type { WorkspaceCreation } from '@/lib/herdr/models';
import { useStartChat } from '../useNewChat';

const mockDb = {
  runAsync: jest.fn(async () => undefined),
  getFirstAsync: jest.fn(async () => null),
};
jest.mock('expo-sqlite', () => ({ useSQLiteContext: () => mockDb }));

const creation = (id: string): WorkspaceCreation =>
  ({ workspace: { workspaceId: id, label: 'app' }, rootPane: { paneId: `${id}:p1` } }) as unknown as WorkspaceCreation;

function fakeClient() {
  let workspaces = 0;
  return {
    createWorkspace: jest.fn(async () => creation(`w${(workspaces += 1)}`)),
    closeWorkspace: jest.fn(async () => undefined),
    startNamedAgent: jest.fn(async () => true),
    installIntegration: jest.fn(async () => undefined),
  };
}

const choice = { directory: '/srv/app', label: '', agent: 'claude' as const, mode: 'acceptEdits' as const };

// #101: an agent start that failed after the workspace was created made a
// second workspace on retry.
it('retries the agent start in the workspace it already created', async () => {
  const client = fakeClient();
  client.startNamedAgent.mockRejectedValueOnce(new Error('agent_not_ready'));
  const { result } = await renderHook(() => useStartChat('host'));
  await act(async () => { await result.current.start(client as unknown as HerdrClient, choice); });
  expect(result.current.error).toContain('agent_not_ready');
  let started: WorkspaceCreation | null = null;
  await act(async () => { started = await result.current.start(client as unknown as HerdrClient, choice); });
  expect(client.createWorkspace).toHaveBeenCalledTimes(1);
  expect(client.startNamedAgent).toHaveBeenCalledTimes(2);
  expect(started).toMatchObject({ workspace: { workspaceId: 'w1' } });
});

it('closes the half-made workspace when the retry is for another folder', async () => {
  const client = fakeClient();
  client.startNamedAgent.mockRejectedValueOnce(new Error('agent_not_ready'));
  const { result } = await renderHook(() => useStartChat('host'));
  await act(async () => { await result.current.start(client as unknown as HerdrClient, choice); });
  await act(async () => {
    await result.current.start(client as unknown as HerdrClient, { ...choice, directory: '/srv/other' });
  });
  expect(client.closeWorkspace).toHaveBeenCalledWith('w1');
  expect(client.createWorkspace).toHaveBeenCalledTimes(2);
});

// Non-Claude agents launch directly, without Claude's permission arguments.
it.each(['codex', 'hermes', 'omp'] as const)('starts %s without Claude permission arguments', async (agent) => {
  const client = fakeClient();
  const { result } = await renderHook(() => useStartChat('host'));
  await act(async () => {
    await result.current.start(client as unknown as HerdrClient, { ...choice, agent });
  });
  expect(client.startNamedAgent).toHaveBeenCalledWith('w1:p1', expect.any(String), agent, [], agent);
  if (agent === 'hermes') {
    expect(client.installIntegration).toHaveBeenCalledWith('hermes');
    expect(client.installIntegration.mock.invocationCallOrder[0]).toBeLessThan(client.createWorkspace.mock.invocationCallOrder[0]!);
  } else expect(client.installIntegration).not.toHaveBeenCalled();
  expect(mockDb.runAsync).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO settings'), 'agent.host', agent);
});

it('creates no workspace when Hermes cannot be prepared on the host', async () => {
  const client = fakeClient();
  client.installIntegration.mockRejectedValue(new Error('custom Hermes detector needs review'));
  const { result } = await renderHook(() => useStartChat('host'));
  await act(async () => { await result.current.start(client as unknown as HerdrClient, { ...choice, agent: 'hermes' }); });
  expect(result.current.error).toContain('custom Hermes detector needs review');
  expect(client.createWorkspace).not.toHaveBeenCalled();
  expect(client.startNamedAgent).not.toHaveBeenCalled();
});
