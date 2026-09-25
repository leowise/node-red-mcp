import { NodeRedAPIClient } from './nodered-api.js';
import { collectCommsFrames } from './nodered-comms.js';

export interface DebugMessage {
  nodeId: string;
  nodeName: string;
  flowId: string;
  topic: string;
  property: string;
  format: string;
  msg: string;
  receivedAt: string;
}

export interface DebugOutputResult {
  messages: DebugMessage[];
  truncated: boolean;
  mayBeIncomplete: boolean;
  triggered?: { nodeId: string; flowId: string | undefined };
}

export interface DebugOutputOptions {
  durationMs?: number;
  nodeId?: string;
  flowId?: string;
  limit?: number;
  triggerNodeId?: string;
}

const MIN_DURATION_MS = 100;
const MAX_DURATION_MS = 30000;
const DEFAULT_DURATION_MS = 3000;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export class DebugOutputCollector {
  constructor(private readonly apiClient: NodeRedAPIClient) {}

  /**
   * Listen for debug-sidebar output for a short window. With triggerNodeId, the inject is
   * fired only after the socket is open, so its output cannot be missed.
   */
  async collect(opts: DebugOutputOptions = {}): Promise<DebugOutputResult> {
    const durationMs = clamp(
      opts.durationMs ?? DEFAULT_DURATION_MS,
      MIN_DURATION_MS,
      MAX_DURATION_MS
    );
    const limit = clamp(Math.floor(opts.limit ?? DEFAULT_LIMIT), 1, MAX_LIMIT);
    const messages: DebugMessage[] = [];
    let truncated = false;
    let triggered: DebugOutputResult['triggered'];

    const triggerNodeId = opts.triggerNodeId;
    const session = await collectCommsFrames(this.apiClient.getCommsWsUrl(), durationMs, {
      onEvent: ({ topic, data }) => {
        if (topic !== 'debug') return;
        const d = (data ?? {}) as Record<string, unknown>;
        const nodeId = text(d.id);
        const flowId = text(d.z);
        if (opts.nodeId && nodeId !== opts.nodeId) return;
        if (opts.flowId && flowId !== opts.flowId) return;
        if (messages.length >= limit) {
          truncated = true;
          return;
        }
        messages.push({
          nodeId,
          nodeName: text(d.name),
          flowId,
          topic: text(d.topic),
          property: text(d.property),
          format: text(d.format),
          msg: typeof d.msg === 'string' ? d.msg : JSON.stringify(d.msg ?? null),
          receivedAt: new Date().toISOString(),
        });
      },
      ...(triggerNodeId && {
        onReady: async () => {
          triggered = await this.apiClient.triggerInject(triggerNodeId);
        },
      }),
    });

    return {
      messages,
      truncated,
      mayBeIncomplete: !session.connected || (session.authExpected && !session.authConfirmed),
      ...(triggered && { triggered }),
    };
  }
}
