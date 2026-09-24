import type { NodeRedFlow, NodeRedFlowRecord } from '../types/nodered.js';

/** Convert Node-RED's flat GET /flows records into tab/subflow objects. */
export function normalizeFlowRecords(records: NodeRedFlowRecord[]): NodeRedFlow[] {
  if (records.every(record => Array.isArray(record.nodes))) {
    return records as NodeRedFlow[];
  }

  const containers = records.filter(
    record => record.type === 'tab' || record.type === 'subflow'
  );
  const flows = containers.map(record => ({
    ...record,
    label: record.label ?? record.name,
    nodes: Array.isArray(record.nodes) ? [...record.nodes] : [],
  })) as NodeRedFlow[];
  const byId = new Map(flows.map(flow => [flow.id, flow]));
  const configs = records.filter(
    record => record.type && record.type !== 'tab' && record.type !== 'subflow' && !record.z
  );

  for (const record of records) {
    if (record.z && record.type !== 'tab' && record.type !== 'subflow') {
      const parent = byId.get(record.z);
      if (parent) parent.nodes.push(record as NodeRedFlow['nodes'][number]);
    }
  }

  for (const flow of flows) {
    const ownConfigs = configs.filter(config => {
      // Config records may be referenced from the nodes in this tab. Keeping all
      // config records is useful for inspection and mirrors Node-RED flow exports.
      return flow.nodes.some(node => JSON.stringify(node).includes(`"${config.id}"`));
    });
    if (ownConfigs.length) flow.configs = ownConfigs as NonNullable<NodeRedFlow['configs']>;
  }

  return flows;
}
