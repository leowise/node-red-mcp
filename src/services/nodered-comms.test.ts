import { createServer } from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { resolveNodeRedAuthHeader, resolveNodeRedAuthToken } from '../utils/auth.js';

import { collectCommsFrames } from './nodered-comms.js';

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

describe('collectCommsFrames onReady', () => {
  beforeEach(() => {
    vi.mocked(resolveNodeRedAuthHeader).mockResolvedValue({});
    vi.mocked(resolveNodeRedAuthToken).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs onReady once, after the server has accepted the connection', async () => {
    const { wss, url, close } = await startWss();
    const order: string[] = [];
    wss.on('connection', () => order.push('server saw connection'));

    await collectCommsFrames(url, 150, {
      onEvent: () => {},
      onReady: () => {
        order.push('ready');
      },
    });

    expect(order).toEqual(['server saw connection', 'ready']);
    await close();
  });

  it('with a token, waits for the auth ack before running onReady', async () => {
    vi.mocked(resolveNodeRedAuthToken).mockResolvedValue('some-token');
    const { wss, url, close } = await startWss();
    const order: string[] = [];
    wss.on('connection', ws => {
      ws.on('message', () => {
        setTimeout(() => {
          order.push('ack sent');
          ws.send(JSON.stringify({ auth: 'ok' }));
        }, 100);
      });
    });

    await collectCommsFrames(url, 400, {
      onEvent: () => {},
      onReady: () => {
        order.push('ready');
      },
    });

    expect(order).toEqual(['ack sent', 'ready']);
    await close();
  });

  it('with a token that is never acked, still runs onReady after a short grace period', async () => {
    vi.mocked(resolveNodeRedAuthToken).mockResolvedValue('some-token');
    const { wss, url, close } = await startWss();
    wss.on('connection', () => {});
    const onReady = vi.fn();

    await collectCommsFrames(url, 1200, { onEvent: () => {}, onReady });

    expect(onReady).toHaveBeenCalledTimes(1);
    await close();
  });

  it('rejects with the onReady error immediately instead of waiting out the timeout', async () => {
    const { wss, url, close } = await startWss();
    wss.on('connection', () => {});
    const started = Date.now();

    await expect(
      collectCommsFrames(url, 10000, {
        onEvent: () => {},
        onReady: () => Promise.reject(new Error('trigger refused')),
      })
    ).rejects.toThrow('trigger refused');

    expect(Date.now() - started).toBeLessThan(2000);
    await close();
  });
});
