import { createServer } from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { resolveNodeRedAuthHeader, resolveNodeRedAuthToken } from '../utils/auth.js';

import { DebugOutputCollector } from './debug-collector.js';
import { NodeRedAPIClient } from './nodered-api.js';

vi.mock('../utils/auth.js', () => ({
  resolveNodeRedAuthHeader: vi.fn().mockResolvedValue({}),
  resolveNodeRedAuthToken: vi.fn().mockResolvedValue(undefined),
  getTlsRejectUnauthorized: vi.fn().mockReturnValue(true),
}));

function startWss(): Promise<{ wss: WebSocketServer; url: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      const close = () => new Promise<void>(res => wss.close(() => server.close(() => res())));
      resolve({ wss, url: `ws://localhost:${port}/comms`, close });
    });
  });
}

function makeClient(url: string, triggerInject = vi.fn()): NodeRedAPIClient {
  return { getCommsWsUrl: () => url, triggerInject } as unknown as NodeRedAPIClient;
}

// Exactly what Node-RED 1.3.5 through 4.1.15 publish for a debug node (captured live).
const debugFrame = (data: Record<string, unknown> = {}) =>
  JSON.stringify({
    topic: 'debug',
    data: {
      id: 'dbg1',
      z: 'flow-1',
      path: 'flow-1',
      name: 'my debug',
      topic: 'spike/topic',
      property: 'payload',
      msg: 'hello',
      format: 'string[5]',
      ...data,
    },
  });

describe('DebugOutputCollector', () => {
  beforeEach(() => {
    vi.mocked(resolveNodeRedAuthHeader).mockResolvedValue({});
    vi.mocked(resolveNodeRedAuthToken).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the debug messages that arrive during the window, with their source node', async () => {
    const { wss, url, close } = await startWss();
    wss.on('connection', ws => ws.send(debugFrame()));

    const result = await new DebugOutputCollector(makeClient(url)).collect({ durationMs: 200 });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      nodeId: 'dbg1',
      nodeName: 'my debug',
      flowId: 'flow-1',
      topic: 'spike/topic',
      property: 'payload',
      format: 'string[5]',
      msg: 'hello',
    });
    expect(new Date(result.messages[0]!.receivedAt).toISOString()).toBe(
      result.messages[0]!.receivedAt
    );
    expect(result.truncated).toBe(false);
    expect(result.mayBeIncomplete).toBe(false);
    await close();
  });

  it('reads debug frames from a batched WebSocket message and ignores other topics', async () => {
    const { wss, url, close } = await startWss();
    wss.on('connection', ws =>
      ws.send(
        JSON.stringify([
          { topic: 'status/abc', data: { fill: 'red', text: 'boom' } },
          JSON.parse(debugFrame({ msg: 'first' })),
          { topic: 'notification/runtime-state', data: {} },
          JSON.parse(debugFrame({ msg: 'second' })),
        ])
      )
    );

    const result = await new DebugOutputCollector(makeClient(url)).collect({ durationMs: 200 });

    expect(result.messages.map(m => m.msg)).toEqual(['first', 'second']);
    await close();
  });

  it('keeps only messages from the requested debug node', async () => {
    const { wss, url, close } = await startWss();
    wss.on('connection', ws => {
      ws.send(debugFrame({ id: 'dbg1', msg: 'mine' }));
      ws.send(debugFrame({ id: 'dbg2', msg: 'other' }));
    });

    const result = await new DebugOutputCollector(makeClient(url)).collect({
      durationMs: 200,
      nodeId: 'dbg1',
    });

    expect(result.messages.map(m => m.msg)).toEqual(['mine']);
    await close();
  });

  it('keeps only messages from the requested flow', async () => {
    const { wss, url, close } = await startWss();
    wss.on('connection', ws => {
      ws.send(debugFrame({ z: 'flow-1', msg: 'in flow 1' }));
      ws.send(debugFrame({ z: 'flow-2', msg: 'in flow 2' }));
    });

    const result = await new DebugOutputCollector(makeClient(url)).collect({
      durationMs: 200,
      flowId: 'flow-2',
    });

    expect(result.messages.map(m => m.msg)).toEqual(['in flow 2']);
    await close();
  });

  it('stops at the limit, keeps the first messages, and says it truncated', async () => {
    const { wss, url, close } = await startWss();
    wss.on('connection', ws => {
      for (const n of [1, 2, 3, 4, 5]) ws.send(debugFrame({ msg: `m${n}` }));
    });

    const result = await new DebugOutputCollector(makeClient(url)).collect({
      durationMs: 200,
      limit: 3,
    });

    expect(result.messages.map(m => m.msg)).toEqual(['m1', 'm2', 'm3']);
    expect(result.truncated).toBe(true);
    await close();
  });

  it('flags the result as possibly incomplete when it cannot connect', async () => {
    const result = await new DebugOutputCollector(makeClient('ws://localhost:1/comms')).collect({
      durationMs: 200,
    });

    expect(result.messages).toEqual([]);
    expect(result.mayBeIncomplete).toBe(true);
  });

  it('caps durationMs at 30000 instead of waiting that long', async () => {
    const { wss, url, close } = await startWss();
    wss.on('connection', ws => ws.close());

    const result = await new DebugOutputCollector(makeClient(url)).collect({ durationMs: 99999 });

    expect(result.messages).toEqual([]);
    await close();
  });

  describe('triggerNodeId', () => {
    it('fires the inject once the socket is open, so its debug output is captured', async () => {
      const { wss, url, close } = await startWss();
      let clientsAtTrigger = -1;
      const triggerInject = vi.fn(async (nodeId: string) => {
        clientsAtTrigger = wss.clients.size;
        for (const client of wss.clients) client.send(debugFrame({ msg: 'from the inject' }));
        return { nodeId, flowId: 'flow-1' };
      });

      const result = await new DebugOutputCollector(makeClient(url, triggerInject)).collect({
        durationMs: 300,
        triggerNodeId: 'inj1',
      });

      expect(triggerInject).toHaveBeenCalledTimes(1);
      expect(triggerInject).toHaveBeenCalledWith('inj1');
      expect(clientsAtTrigger).toBe(1);
      expect(result.triggered).toEqual({ nodeId: 'inj1', flowId: 'flow-1' });
      expect(result.messages.map(m => m.msg)).toEqual(['from the inject']);
      await close();
    });

    it('does not trigger anything when triggerNodeId is not given', async () => {
      const { wss, url, close } = await startWss();
      wss.on('connection', () => {});
      const triggerInject = vi.fn();

      const result = await new DebugOutputCollector(makeClient(url, triggerInject)).collect({
        durationMs: 150,
      });

      expect(triggerInject).not.toHaveBeenCalled();
      expect(result.triggered).toBeUndefined();
      await close();
    });

    it('fails right away with the trigger error when the inject is refused', async () => {
      const { wss, url, close } = await startWss();
      wss.on('connection', () => {});
      const triggerInject = vi
        .fn()
        .mockRejectedValue(new Error("Node 'fn' is a 'function' node, not an inject node"));
      const started = Date.now();

      await expect(
        new DebugOutputCollector(makeClient(url, triggerInject)).collect({
          durationMs: 10000,
          triggerNodeId: 'fn',
        })
      ).rejects.toThrow('not an inject node');

      expect(Date.now() - started).toBeLessThan(2000);
      await close();
    });
  });
});
