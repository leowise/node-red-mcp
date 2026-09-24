/**
 * Exercise the actual HTTP entry point with an SDK MCP client.
 *
 * Run with: node --import tsx tests/live-mcp-http-smoke.mts <url> <version>
 * Uses a loopback listener and a read-only Node-RED connection.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, expectedVersion] = process.argv.slice(2);
if (!url || !expectedVersion) throw new Error('Usage: live-mcp-http-smoke.mts <url> <version>');

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
    MCP_READ_ONLY: 'true',
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
const report: Record<string, unknown> = { url, expectedVersion };
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
  assert(transport.sessionId);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  for (const name of ['get_flows', 'get_settings', 'get_runtime_info']) assert(names.has(name));
  assert.equal(names.has('create_flow'), false);
  report.toolsListed = tools.tools.length;

  const settings = await call('get_settings');
  assert.equal(settings.version, expectedVersion);
  const runtime = await call('get_runtime_info');
  assert.equal(runtime.version, expectedVersion);
  report.runtimeSource = runtime.source;
  const flows = await call('get_flows', { types: ['tab'] });
  assert(Array.isArray(flows) && flows.length > 0);
  report.tabCount = flows.length;

  const resources = await client.listResources();
  const flowUri = `flow://${flows[0].id}`;
  assert(resources.resources.some(resource => resource.uri === flowUri));
  const resource = await client.readResource({ uri: flowUri });
  assert.equal(JSON.parse(resource.contents[0].text).flow.id, flows[0].id);
  report.flowResourceRead = true;

  const denied = await client.callTool({
    name: 'create_flow',
    arguments: { flowData: { label: 'MCP read-only guard probe' } },
  });
  const body = JSON.parse(denied.content.filter((item: any) => item.type === 'text')[0].text);
  assert.equal(body.success, false);
  assert.match(body.error, /read-only mode/);
  report.writeGuard = 'passed';
  assert.deepEqual(await call('get_flows', { types: ['tab'] }), flows);
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? error.message : String(error);
  report.serverOutput = serverOutput;
  process.exitCode = 1;
} finally {
  await transport.close().catch(() => {});
  server.kill();
  console.log(JSON.stringify(report, null, 2));
}
