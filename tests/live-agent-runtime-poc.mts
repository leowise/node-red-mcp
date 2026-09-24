/**
 * Leave a disabled, agent-created runtime proof on a disposable Node-RED rig.
 *
 * Run with: node --import tsx tests/live-agent-runtime-poc.mts <url> [--allow-remote]
 * The flow has a one-shot inject, pure Function node, and console/debug output.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const [url, ...flags] = process.argv.slice(2);
if (!url || flags.some(flag => flag !== '--allow-remote')) {
  throw new Error('Usage: live-agent-runtime-poc.mts <url> [--allow-remote]');
}
if (!['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) {
  assert(flags.includes('--allow-remote'), 'Remote write requires --allow-remote');
}

const nonce = randomUUID().slice(0, 8);
const marker = `rocky-agent-${nonce}`;
const label = `Rocky MCP Agent POC ${nonce}`;
const injectId = randomUUID().replaceAll('-', '').slice(0, 16);
const functionId = randomUUID().replaceAll('-', '').slice(0, 16);
const debugId = randomUUID().replaceAll('-', '').slice(0, 16);
const client = new Client({ name: 'rocky-agent-poc', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.mjs'],
  cwd: process.cwd(),
  env: {
    ...getDefaultEnvironment(),
    NODERED_URL: url,
    NODERED_RETRIES: '0',
    MCP_TRANSPORT: 'stdio',
    MCP_READ_ONLY: 'false',
    SSE_ENABLED: 'false',
  },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', chunk => {
  stderr = (stderr + String(chunk)).slice(-2000);
});
const report: Record<string, unknown> = { url, label, marker };
let flowId: string | undefined;
let connected = false;

async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const value = result.content.filter((item: any) => item.type === 'text')[0]?.text;
  assert.equal(typeof value, 'string', `${name} returned no text`);
  assert(!result.isError, `${name}: ${value}`);
  if (name === 'create_flow' || name === 'update_flow' || name.endsWith('_flow')) {
    assert(!/"success"\s*:\s*false/.test(value), `${name}: ${value}`);
  }
  if (value.startsWith('{')) {
    const body = JSON.parse(value);
    assert.equal(body.success, true, `${name}: ${body.error ?? 'unknown error'}`);
    return body.data;
  }
  return value;
}

try {
  await client.connect(transport);
  connected = true;
  const before = await tool('get_flows', { types: ['tab'] });
  assert(Array.isArray(before));
  assert(!before.some((flow: any) => flow.label === label));

  const created = await tool('create_flow', {
    validate: true,
    flowData: {
      label,
      disabled: true,
      nodes: [
        {
          id: injectId,
          type: 'inject',
          name: 'Run once when enabled',
          props: [{ p: 'payload' }],
          repeat: '',
          crontab: '',
          once: true,
          onceDelay: 0.5,
          topic: '',
          payload: marker,
          payloadType: 'str',
          x: 150,
          y: 100,
          wires: [[functionId]],
        },
        {
          id: functionId,
          type: 'function',
          name: 'Annotate probe',
          func: "msg.payload = { source: 'Rocky MCP Agent POC', marker: msg.payload, revision: 1 }; return msg;",
          outputs: 1,
          noerr: 0,
          initialize: '',
          finalize: '',
          libs: [],
          x: 350,
          y: 100,
          wires: [[debugId]],
        },
        {
          id: debugId,
          type: 'debug',
          name: 'Runtime proof',
          active: true,
          tosidebar: true,
          console: true,
          tostatus: false,
          complete: 'payload',
          targetType: 'msg',
          x: 550,
          y: 100,
          wires: [],
        },
      ],
    },
  });
  flowId = /^Flow created: ([A-Za-z0-9_.-]+)/.exec(created)?.[1];
  assert(flowId, `Could not identify created flow: ${created}`);
  let flow = await tool('get_flow', { flowId });
  assert.equal(flow.label, label);
  assert.equal(flow.disabled, true);
  assert.equal(flow.nodes.length, 3);
  assert.equal((await tool('validate_flow', { flowId })).valid, true);
  assert.equal((await tool('search_flows', { flowId, type: 'function' })).total, 1);

  flow = {
    ...flow,
    nodes: flow.nodes.map((node: any) =>
      node.id === functionId
        ? {
            ...node,
            func: "msg.payload = { source: 'Rocky MCP Agent POC', marker: msg.payload, revision: 2 }; return msg;",
          }
        : node
    ),
  };
  await tool('update_flow', { flowId, validate: true, flowData: flow });
  flow = await tool('get_flow', { flowId });
  assert.equal(flow.disabled, true);
  assert.match(flow.nodes.find((node: any) => node.id === functionId).func, /revision: 2/);

  await tool('enable_flow', { flowId });
  assert.equal((await tool('get_flow', { flowId })).disabled, false);
  await new Promise(resolve => setTimeout(resolve, 1800));
  await tool('disable_flow', { flowId });
  assert.equal((await tool('get_flow', { flowId })).disabled, true);
  report.flowId = flowId;
  report.initialTabs = before.length;
  report.finalTabs = (await tool('get_flows', { types: ['tab'] })).length;
  assert.equal(report.finalTabs, before.length + 1);
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? error.message : String(error);
  if (stderr) report.serverStderr = stderr;
  process.exitCode = 1;
} finally {
  if (connected) {
    try {
      if (!flowId) {
        const matches = (await tool('get_flows', { types: ['tab'] })).filter(
          (flow: any) => flow.label === label
        );
        if (matches.length === 1) flowId = matches[0].id;
      }
      if (flowId && !(await tool('get_flow', { flowId })).disabled) {
        await tool('disable_flow', { flowId });
        report.cleanup = 'flow disabled after failure';
      }
    } catch (cleanupError) {
      report.success = false;
      report.cleanupError =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      process.exitCode = 1;
    }
  }
  await transport.close();
  console.log(JSON.stringify(report, null, 2));
}
