/**
 * Exercise the real stdio MCP transport against a Node-RED instance.
 *
 * Run with: node --import tsx tests/live-mcp-stdio-smoke.mts <url> <version> [--write] [--built]
 * The optional write check is limited to a loopback Node-RED instance.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const [url, expectedVersion, ...flags] = process.argv.slice(2);
if (!url || !expectedVersion || flags.some(flag => !['--write', '--built'].includes(flag))) {
  throw new Error('Usage: live-mcp-stdio-smoke.mts <url> <version> [--write] [--built]');
}
const write = flags.includes('--write');
const built = flags.includes('--built');
if (write) {
  assert(
    ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname),
    'Stdio write smoke is limited to loopback Node-RED instances'
  );
}

const client = new Client({ name: 'node-red-compat-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: built ? ['dist/index.mjs'] : ['--import', 'tsx', 'src/index.ts'],
  cwd: process.cwd(),
  env: {
    ...getDefaultEnvironment(),
    NODERED_URL: url,
    NODERED_RETRIES: '0',
    MCP_TRANSPORT: 'stdio',
    MCP_READ_ONLY: write ? 'false' : 'true',
    SSE_ENABLED: 'false',
  },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', chunk => {
  stderr += String(chunk).slice(0, 2000);
});
const report: Record<string, unknown> = { url, expectedVersion, write, built };
const nonce = randomUUID().slice(0, 8);
const label = `MCP stdio compatibility smoke ${nonce}`;
const updatedLabel = `${label} updated`;
let connected = false;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const body = JSON.parse(result.content.filter((item: any) => item.type === 'text')[0].text);
  assert.equal(body.success, true, `${name}: ${body.error ?? 'unknown error'}`);
  return body.data;
}

async function callText(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const value = result.content.filter((item: any) => item.type === 'text')[0]?.text;
  assert.equal(typeof value, 'string', `${name} returned no text`);
  assert(!result.isError, `${name}: ${value}`);
  assert(!/"success"\s*:\s*false/.test(value), `${name}: ${value}`);
  return value as string;
}

async function tabs() {
  const flows = await call('get_flows', { types: ['tab'] });
  return flows.map((flow: any) => ({
    id: flow.id,
    label: flow.label,
    disabled: Boolean(flow.disabled),
    nodeCount: flow.nodeCount ?? 0,
  }));
}

try {
  await client.connect(transport);
  connected = true;
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  for (const name of ['get_flows', 'get_settings', 'get_runtime_info', 'get_installed_modules']) {
    assert(names.has(name), `Missing ${name} from tools/list`);
  }
  assert.equal(names.has('create_flow'), write);
  report.toolsListed = tools.tools.length;

  const settings = await call('get_settings');
  assert.equal(settings.version, expectedVersion);
  const runtime = await call('get_runtime_info');
  assert.equal(runtime.version, expectedVersion);
  report.runtimeSource = runtime.source;

  const before = await tabs();
  assert(before.length > 0);
  report.tabCount = before.length;
  const first = await call('get_flow', { flowId: before[0].id });
  assert.equal(first.id, before[0].id);

  const modules = await call('get_installed_modules', { limit: 1 });
  assert.equal(typeof modules.total, 'number');
  report.nonCoreModuleCount = modules.total;

  const resources = await client.listResources();
  const flowUri = `flow://${before[0].id}`;
  assert(resources.resources.some(resource => resource.uri === flowUri));
  const resource = await client.readResource({ uri: flowUri });
  const resourceBody = JSON.parse(resource.contents[0].text);
  assert.equal(resourceBody.flow.id, before[0].id);
  report.flowResourceRead = true;

  if (write) {
    const injectId = randomUUID().replaceAll('-', '').slice(0, 16);
    const debugId = randomUUID().replaceAll('-', '').slice(0, 16);
    const created = await callText('create_flow', {
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
    assert.match(created, /^Flow created:/);
    const matches = (await tabs()).filter((flow: any) => flow.label === label);
    assert.equal(matches.length, 1);
    const flowId = matches[0].id;
    let flow = await call('get_flow', { flowId });
    assert.equal(flow.label, label);
    assert.equal(flow.disabled, true);
    assert.equal(flow.nodes.length, 2);
    assert.equal((await call('validate_flow', { flowId })).valid, true);

    await callText('update_flow', {
      flowId,
      validate: true,
      flowData: { ...flow, label: updatedLabel },
    });
    flow = await call('get_flow', { flowId });
    assert.equal(flow.label, updatedLabel);
    assert.equal(flow.disabled, true);

    await callText('enable_flow', { flowId });
    assert.equal((await call('get_flow', { flowId })).disabled, false);
    await callText('disable_flow', { flowId });
    assert.equal((await call('get_flow', { flowId })).disabled, true);

    const dryRun = await call('delete_flow', { flowId });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.wouldDelete.id, flowId);
    await call('delete_flow', { flowId, dryRun: false, confirm: true });
    assert.deepEqual(await tabs(), before);
    report.lifecycle = 'create, read, validate, update, enable, disable, dry-run, delete passed';
  } else {
    // Directly calling a hidden write tool must still be rejected by the server.
    const rejected = await client.callTool({
      name: 'create_flow',
      arguments: { flowData: { label: 'MCP read-only guard probe' } },
    });
    const rejection = JSON.parse(
      rejected.content.filter((item: any) => item.type === 'text')[0].text
    );
    assert.equal(rejection.success, false);
    assert.match(rejection.error, /read-only mode/);
    report.writeGuard = 'passed';
    assert.deepEqual(await tabs(), before);
  }
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? error.message : String(error);
  if (stderr) report.serverStderr = stderr;
  process.exitCode = 1;
} finally {
  if (write && connected) {
    try {
      const matches = (await tabs()).filter(
        (flow: any) => flow.label === label || flow.label === updatedLabel
      );
      assert(matches.length <= 1, 'Multiple temporary flows have the unique smoke label');
      if (matches.length === 1) {
        const flowId = matches[0].id;
        if (!(await call('get_flow', { flowId })).disabled) {
          await callText('disable_flow', { flowId });
        }
        await call('delete_flow', { flowId, dryRun: false, confirm: true });
        report.cleanup = 'temporary flow removed';
      }
    } catch (error) {
      report.success = false;
      report.cleanupError = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
  }
  await transport.close();
  console.log(JSON.stringify(report, null, 2));
}
