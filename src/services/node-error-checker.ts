import { NodeRedAPIClient } from './nodered-api.js';
import { CommsSession, collectCommsFrames } from './nodered-comms.js';

export interface NodeErrorEntry {
  nodeId: string;
  nodeType: string;
  label: string;
  status: { fill: string; shape?: string; text?: string };
  flowId: string;
  flowName: string;
}

export interface NodeErrorCheckResult {
  errors: NodeErrorEntry[];
  warnings: NodeErrorEntry[];
  statusesMayBeIncomplete: boolean;
}

interface RawStatus {
  fill?: string;
  shape?: string;
  text?: string;
}

async function collectStatuses(
  wsUrl: string,
  timeoutMs: number
): Promise<{ statuses: Map<string, RawStatus> } & CommsSession> {
  const statuses = new Map<string, RawStatus>();
  const session = await collectCommsFrames(wsUrl, timeoutMs, {
    onEvent: ({ topic, data }) => {
      if (!topic.startsWith('status/')) return;
      const nodeId = topic.slice('status/'.length);
      const d = (data ?? {}) as Record<string, unknown>;
      const fill = typeof d.fill === 'string' ? d.fill : undefined;
      const shape = typeof d.shape === 'string' ? d.shape : undefined;
      const text = typeof d.text === 'string' ? d.text : undefined;
      if (!fill && !text) {
        statuses.delete(nodeId);
      } else {
        const s: RawStatus = {};
        if (fill !== undefined) s.fill = fill;
        if (shape !== undefined) s.shape = shape;
        if (text !== undefined) s.text = text;
        statuses.set(nodeId, s);
      }
    },
  });
  return { statuses, ...session };
}

export class NodeErrorChecker {
  constructor(private readonly apiClient: NodeRedAPIClient) {}

  async check(
    opts: {
      includeWarnings?: boolean;
      timeoutMs?: number;
    } = {}
  ): Promise<NodeErrorCheckResult> {
    const includeWarnings = opts.includeWarnings ?? false;
    const timeoutMs = Math.min(opts.timeoutMs ?? 2000, 30000);

    const [statusResult, flowResult] = await Promise.all([
      collectStatuses(this.apiClient.getCommsWsUrl(), timeoutMs),
      this.apiClient.getNormalizedFlows().then(
        flows => ({ flows, available: true }),
        () => ({ flows: [], available: false })
      ),
    ]);
    const { statuses, connected, authExpected, authConfirmed } = statusResult;
    const flows = flowResult.flows;

    const nodeIndex = new Map<
      string,
      { nodeType: string; label: string; flowId: string; flowName: string }
    >();
    for (const flow of flows) {
      const flowName = flow.label ?? flow.id;
      for (const node of flow.nodes ?? []) {
        nodeIndex.set(node.id, {
          nodeType: node.type ?? 'unknown',
          label: node.name ?? '',
          flowId: flow.id,
          flowName,
        });
      }
    }

    const errors: NodeErrorEntry[] = [];
    const warnings: NodeErrorEntry[] = [];

    for (const [nodeId, rawStatus] of statuses) {
      const { fill, shape, text } = rawStatus;
      if (!fill) continue;
      const meta = nodeIndex.get(nodeId);
      const status: NodeErrorEntry['status'] = { fill };
      if (shape !== undefined) status.shape = shape;
      if (text !== undefined) status.text = text;
      const entry: NodeErrorEntry = {
        nodeId,
        nodeType: meta?.nodeType ?? 'unknown',
        label: meta?.label ?? '',
        status,
        flowId: meta?.flowId ?? '',
        flowName: meta?.flowName ?? '',
      };
      if (fill === 'red') {
        errors.push(entry);
      } else if (fill === 'yellow' && includeWarnings) {
        warnings.push(entry);
      }
    }

    // Two independent reasons the status snapshot might be incomplete: the
    // WS transport never connected, or it connected but never confirmed auth.
    const authIncomplete = authExpected && !authConfirmed;

    return {
      errors,
      warnings,
      statusesMayBeIncomplete: !connected || authIncomplete || !flowResult.available,
    };
  }
}
