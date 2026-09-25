import type { NodeRedFlow, NodeRedFlowRecord } from '../types/nodered.js';

function isGraphNode(record: NodeRedFlowRecord): boolean {
  return (
    Boolean(record.z) &&
    record.type !== 'tab' &&
    record.type !== 'subflow' &&
    typeof record.x === 'number' &&
    typeof record.y === 'number'
  );
}

/** Convert Node-RED's flat GET /flows records into tab/subflow objects. */
export function normalizeFlowRecords(records: NodeRedFlowRecord[]): NodeRedFlow[] {
  if (records.every(record => Array.isArray(record.nodes))) {
    return records as NodeRedFlow[];
  }

  const containers = records.filter(record => record.type === 'tab' || record.type === 'subflow');
  const flows = containers.map(record => ({
    ...record,
    label: record.label ?? record.name,
    nodes: Array.isArray(record.nodes) ? [...record.nodes] : [],
  })) as NodeRedFlow[];
  const byId = new Map(flows.map(flow => [flow.id, flow]));
  const configs = records.filter(
    record =>
      record.type && record.type !== 'tab' && record.type !== 'subflow' && !isGraphNode(record)
  );

  for (const record of records) {
    if (record.z && isGraphNode(record)) {
      const parent = byId.get(record.z);
      if (parent && !parent.nodes.some(node => node.id === record.id)) {
        parent.nodes.push(record as NodeRedFlow['nodes'][number]);
      }
    }
  }

  for (const flow of flows) {
    const ownConfigs = configs.filter(config => {
      // Config nodes can carry z in Node-RED 1.x exports, but they have no
      // canvas coordinates and belong under configs in GET /flow/:id responses.
      return (
        config.z === flow.id ||
        flow.nodes.some(node => JSON.stringify(node).includes(`"${config.id}"`))
      );
    });
    if (ownConfigs.length) flow.configs = ownConfigs as NonNullable<NodeRedFlow['configs']>;
  }

  return flows;
}
