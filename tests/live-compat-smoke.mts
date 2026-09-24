/**
 * Live Node-RED Admin API compatibility check through the MCP server.
 *
 * Run with: node --import tsx tests/live-compat-smoke.mts http://127.0.0.1:11831 3.1.15 --write
 * The write check creates and removes one uniquely named flow containing only
 * a manual inject and debug node. Remote writes require --allow-remote.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { McpNodeRedServer } from '../src/server/mcp-server.ts';
import { NodeRedAPIClient } from '../src/services/nodered-api.ts';

const [url, expectedVersion, ...flags] = process.argv.slice(2);
if (!url || !expectedVersion) {
  throw new Error('Usage: live-compat-smoke.mts <url> <version> [--write] [--allow-remote]');
}
const parsedUrl = new URL(url);
const write = flags.includes('--write');
if (write && !['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)) {
  assert(flags.includes('--allow-remote'), 'Remote write checks require --allow-remote');
}

const client = new NodeRedAPIClient({ baseURL: url, timeout: 10000, retries: 0 });
const server = new McpNodeRedServer({
  nodeRed: { url, timeout: 10000, retries: 0 },
  sse: { enabled: false, port: 3001, heartbeatInterval: 30000, maxConnections: 1 },
});
const nonce = randomUUID().slice(0, 8);
const label = `MCP compatibility smoke ${nonce}`;
const updatedLabel = `${label} updated`;
const injectId = randomUUID().replaceAll('-', '').slice(0, 16);
const debugId = randomUUID().replaceAll('-', '').slice(0, 16);
const report: Record<string, unknown> = { url, expectedVersion, write };
let flowId: string | undefined;

async function tool(name: string, args: Record<string, unknown> = {}) {
  const response = await server.callTool(name, args);
  const text = response.content.map((item: any) => item.text ?? '').join('\n');
  if (name === 'create_flow') {
    if (!text.startsWith('Flow created: ')) throw new Error(text);
    return text;
  }
  if (name === 'update_flow' || name === 'enable_flow' || name === 'disable_flow') {
    if (/"success"\s*:\s*false/.test(text)) throw new Error(text);
    return text;
  }
  const result = JSON.parse(text);
  if (!result.success) throw new Error(`${name}: ${result.error}`);
  return result.data;
}

async function tabSnapshot() {
  const summaries = await tool('get_flows', { types: ['tab'] });
  return summaries.map((flow: any) => ({
    id: flow.id,
    label: flow.label,
    disabled: Boolean(flow.disabled),
    nodeCount: flow.nodeCount ?? 0,
  }));
}

try {
  const settings = await tool('get_settings');
  assert.equal(settings.version, expectedVersion);
  const runtime = await tool('get_runtime_info');
  assert.equal(runtime.version, expectedVersion);
  report.runtimeInfo = {
    version: runtime.version,
    source: runtime.source,
    diagnosticsAvailable: runtime.diagnosticsAvailable,
  };

  const before = await tabSnapshot();
  report.tabsBefore = before;
  const modules = await tool('get_installed_modules', { limit: 1 });
  report.installedNonCoreModules = modules.total;
  const state = await tool('get_flow_state');
  report.flowStateAvailable = state.available !== false;
  const errors = await tool('get_node_errors', { timeoutMs: 1000 });
  report.nodeErrors = {
    count: errors.errors.length,
    statusesMayBeIncomplete: errors.statusesMayBeIncomplete,
  };

  if (write) {
    const created = await tool('create_flow', {
      validate: true,
      flowData: {
        label,
        disabled: true,
        nodes: [
          {
            id: injectId,
            type: 'inject',
            name: 'manual only',
            props: [{ p: 'payload' }],
            repeat: '',
            crontab: '',
            once: false,
            onceDelay: 0.1,
            topic: '',
            payload: 'compatibility smoke',
            payloadType: 'str',
            x: 140,
            y: 100,
            wires: [[debugId]],
          },
          {
            id: debugId,
            type: 'debug',
            name: 'smoke output',
            active: true,
            tosidebar: true,
            console: false,
            tostatus: false,
            complete: 'payload',
            targetType: 'msg',
            x: 340,
            y: 100,
            wires: [],
          },
        ],
      },
    });
    flowId = /^Flow created: ([A-Za-z0-9_.-]+)/.exec(created)?.[1];
    if (!flowId) {
      const matches = (await tabSnapshot()).filter((flow: any) => flow.label === label);
      assert.equal(matches.length, 1, 'Could not identify the newly created flow');
      flowId = matches[0].id;
    }
    let flow = await client.getFlow(flowId);
    assert.equal(flow.label, label);
    assert.equal(flow.disabled, true);
    assert.equal(flow.nodes.length, 2);
    assert.equal((await tool('validate_flow', { flowId })).valid, true);

    const search = await tool('search_flows', { flowId, type: 'inject' });
    assert.equal(search.total, 1);
    await tool('update_flow', {
      flowId,
      validate: true,
      flowData: { ...flow, label: updatedLabel },
    });
    flow = await client.getFlow(flowId);
    assert.equal(flow.label, updatedLabel);
    assert.equal(flow.disabled, true);

    await tool('enable_flow', { flowId });
    assert.equal((await client.getFlow(flowId)).disabled, false);
    await tool('disable_flow', { flowId });
    assert.equal((await client.getFlow(flowId)).disabled, true);

    const dryRun = await tool('delete_flow', { flowId });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.wouldDelete.id, flowId);
    await tool('delete_flow', { flowId, dryRun: false, confirm: true });

    const after = await tabSnapshot();
    assert.deepEqual(after, before);
    report.lifecycle = 'create, validate, search, update, enable, disable, delete passed';
    report.tabsAfter = after;
  }

  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    // A create request may persist even if its response is lost. Find only this
    // run's unique label before attempting cleanup; never touch other tabs.
    const matches = (await tabSnapshot()).filter(
      (flow: any) => flow.label === label || flow.label === updatedLabel
    );
    if (matches.length === 1) {
      flowId = matches[0].id;
      const flow = await client.getFlow(flowId!);
      if (!flow.disabled) await tool('disable_flow', { flowId });
      await tool('delete_flow', { flowId, dryRun: false, confirm: true });
      report.cleanup = 'temporary flow removed';
    } else if (matches.length > 1) {
      throw new Error('Multiple temporary flows have the same unique label');
    }
  } catch (cleanupError) {
    report.success = false;
    report.cleanupError =
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    process.exitCode = 1;
  }
  await server.stop();
  console.log(JSON.stringify(report, null, 2));
}
