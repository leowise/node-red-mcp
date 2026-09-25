import WebSocket from 'ws';

import {
  resolveNodeRedAuthHeader,
  resolveNodeRedAuthToken,
  getTlsRejectUnauthorized,
} from '../utils/auth.js';
import { AuthenticationError } from '../utils/error-handling.js';

export interface CommsEvent {
  topic: string;
  data?: unknown;
}

export interface CommsSession {
  connected: boolean;
  authExpected: boolean;
  authConfirmed: boolean;
}

interface CommsFrame {
  topic?: string;
  data?: unknown;
  auth?: 'ok' | 'fail';
}

// With a token, Node-RED normally acks the handshake; some setups only start streaming.
const AUTH_ACK_GRACE_MS = 500;

/**
 * Listen on Node-RED's /comms WebSocket for timeoutMs, passing every event to onEvent.
 * onReady runs once the connection is usable (open, and authenticated when a token is
 * in use); a rejection from it aborts the collection with that error.
 */
export async function collectCommsFrames(
  wsUrl: string,
  timeoutMs: number,
  handlers: { onEvent: (event: CommsEvent) => void; onReady?: () => Promise<void> | void }
): Promise<CommsSession> {
  const [headers, token] = await Promise.all([
    resolveNodeRedAuthHeader(),
    resolveNodeRedAuthToken(),
  ]);
  const authExpected = token !== undefined;

  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let settled = false;
    let connected = false;
    let authConfirmed = false;
    let readyFired = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      ws?.terminate();
      if (err) reject(err);
      else resolve({ connected, authExpected, authConfirmed });
    };

    const fireReady = () => {
      if (readyFired || settled) return;
      readyFired = true;
      clearTimeout(graceTimer);
      Promise.resolve()
        .then(() => handlers.onReady?.())
        .catch(err => finish(err instanceof Error ? err : new Error(String(err))));
    };

    const timer = setTimeout(finish, timeoutMs);

    try {
      ws = new WebSocket(wsUrl, {
        rejectUnauthorized: getTlsRejectUnauthorized(),
        // Still sent for a reverse proxy in front of Node-RED that gates the
        // WS upgrade on it — Node-RED's own adminAuth ignores it, see below.
        headers,
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }

    ws.on('open', () => {
      connected = true;
      // Node-RED's /comms auth is entirely in-band, not header-based: send
      // { auth: "<token>" } as the first message per Node-RED's own docs.
      if (token) {
        ws.send(JSON.stringify({ auth: token }));
        graceTimer = setTimeout(fireReady, AUTH_ACK_GRACE_MS);
      } else {
        fireReady();
      }
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const parsed: unknown = JSON.parse(raw.toString());
        // Node-RED batches multiple events into a JSON array per WS message;
        // the auth handshake reply is always a single flat object.
        const frames: CommsFrame[] = Array.isArray(parsed) ? parsed : [parsed];

        for (const msg of frames) {
          if (typeof msg.auth === 'string') {
            // Trusting the WebSocket peer's own auth-handshake reply is
            // inherent to implementing Node-RED's documented /comms protocol
            // — there is no alternative, signed proof Node-RED provides. The
            // actual trust boundary is the TLS connection to NODERED_URL
            // (see getTlsRejectUnauthorized), not this in-band message; a
            // party able to inject frames on this socket without breaking
            // TLS has already compromised the channel this check depends on.
            // authConfirmed also only affects statusesMayBeIncomplete, a
            // diagnostic-completeness signal — it grants no access, since
            // the socket already receives whatever Node-RED sends regardless.
            if (msg.auth === 'ok') {
              // codeql[js/user-controlled-bypass] see comment above
              authConfirmed = true;
              fireReady();
            } else {
              // Invalidate the cached token so the *next* check() call
              // re-exchanges instead of retrying with the same bad token.
              resolveNodeRedAuthToken(true).catch(() => {});
              finish(new AuthenticationError('Node-RED WebSocket auth failed'));
            }
            continue;
          }

          if (typeof msg.topic !== 'string') continue;
          // Any real event arriving is itself proof of authorization — an
          // unauthenticated /comms connection receives nothing at all
          // (confirmed empirically against a live instance). This covers
          // NODERED_API_TOKEN setups where Node-RED never bothers to send
          // an explicit { auth: "ok" } ack but still streams data.
          authConfirmed = true;
          handlers.onEvent({ topic: msg.topic, data: msg.data });
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on('close', () => finish());
    ws.on('error', () => finish());
  });
}
