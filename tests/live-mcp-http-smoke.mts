/**
 * Exercise the actual HTTP entry point with an SDK MCP client.
 *
 * Run with: node --import tsx tests/live-mcp-http-smoke.mts <url> <version> [--write]
 * The optional write check is limited to a loopback Node-RED instance.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, expectedVersion, ...flags] = process.argv.slice(2);
if (!url || !expectedVersion || flags.some(flag => flag !== '--write')) {
  throw new Error('Usage: live-mcp-http-smoke.mts <url> <version> [--write]');
}
const write = flags.includes('--write');
if (write) {
  assert(
    ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname),
    'HTTP write smoke is limited to loopback Node-RED instances'
  );
}

const port = await new Promise<number>((resolve, reject) => {
  const socket = createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address();
    if (!address || typeof address === 'string') return reject(new Error('No test port'));
    socket.close(() => resolve(address.port));
  });
});
const base = `http://127.0.0.1:${port}`;
const username = 'compat-smoke';
const password = randomBytes(24).toString('hex');
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODERED_URL: url,
    NODERED_RETRIES: '0',
    MCP_TRANSPORT: 'http',
    MCP_READ_ONLY: write ? 'false' : 'true',
    SSE_ENABLED: 'false',
    CLAUDE_AUTH_REQUIRED: 'false',
    HOST: '127.0.0.1',
    PORT: String(port),
    MCP_USERNAME: username,
    MCP_PASSWORD: password,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', chunk => {
    serverOutput = (serverOutput + String(chunk)).slice(-4000);
  });
}
const report: Record<string, unknown> = { url, expectedVersion, write };
const client = new Client({ name: 'node-red-http-compat-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: authorization } },
});

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

const nonce = randomUUID().slice(0, 8);
const label = `MCP HTTP compatibility smoke ${nonce}`;
const updatedLabel = `${label} updated`;
const injectId = randomUUID().replaceAll('-', '').slice(0, 16);
const debugId = randomUUID().replaceAll('-', '').slice(0, 16);
let connected = false;

try {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`HTTP server exited: ${serverOutput}`);
    try {
      const health = await fetch(`${base}/health`);
      if (health.ok) break;
    } catch {
      // Wait for the listener.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (Date.now() >= deadline) throw new Error(`HTTP server did not start: ${serverOutput}`);

  const unauthenticated = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(unauthenticated.status, 401);
  report.authGuard = 'passed';

  await client.connect(transport);
  connected = true;
  assert(transport.sessionId);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  for (const name of ['get_flows', 'get_settings', 'get_runtime_info']) assert(names.has(name));
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

  const resources = await client.listResources();
  const flowUri = `flow://${before[0].id}`;
  assert(resources.resources.some(resource => resource.uri === flowUri));
  const resource = await client.readResource({ uri: flowUri });
  assert.equal(JSON.parse(resource.contents[0].text).flow.id, before[0].id);
  report.flowResourceRead = true;

  if (write) {
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
    const denied = await client.callTool({
      name: 'create_flow',
      arguments: { flowData: { label: 'MCP read-only guard probe' } },
    });
    const body = JSON.parse(denied.content.filter((item: any) => item.type === 'text')[0].text);
    assert.equal(body.success, false);
    assert.match(body.error, /read-only mode/);
    report.writeGuard = 'passed';
    assert.deepEqual(await tabs(), before);
  }
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? error.message : String(error);
  report.serverOutput = serverOutput;
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
  await transport.close().catch(() => {});
  server.kill();
  console.log(JSON.stringify(report, null, 2));
}
