/**
 * Exercise the real stdio MCP transport against a Node-RED instance.
 *
 * Run with: node --import tsx tests/live-mcp-stdio-smoke.mts <url> <version>
 * All calls are read-only; the server is started with MCP_READ_ONLY=true.
 */
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const [url, expectedVersion] = process.argv.slice(2);
if (!url || !expectedVersion) {
  throw new Error('Usage: live-mcp-stdio-smoke.mts <url> <version>');
}

const client = new Client({ name: 'node-red-compat-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'src/index.ts'],
  cwd: process.cwd(),
  env: {
    ...getDefaultEnvironment(),
    NODERED_URL: url,
    NODERED_RETRIES: '0',
    MCP_TRANSPORT: 'stdio',
    MCP_READ_ONLY: 'true',
    SSE_ENABLED: 'false',
  },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', chunk => {
  stderr += String(chunk).slice(0, 2000);
});
const report: Record<string, unknown> = { url, expectedVersion };

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const body = JSON.parse(result.content.filter((item: any) => item.type === 'text')[0].text);
  assert.equal(body.success, true, `${name}: ${body.error ?? 'unknown error'}`);
  return body.data;
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  for (const name of ['get_flows', 'get_settings', 'get_runtime_info', 'get_installed_modules']) {
    assert(names.has(name), `Missing ${name} from tools/list`);
  }
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
  const first = await call('get_flow', { flowId: flows[0].id });
  assert.equal(first.id, flows[0].id);

  const modules = await call('get_installed_modules', { limit: 1 });
  assert.equal(typeof modules.total, 'number');
  report.nonCoreModuleCount = modules.total;

  const resources = await client.listResources();
  const flowUri = `flow://${flows[0].id}`;
  assert(resources.resources.some(resource => resource.uri === flowUri));
  const resource = await client.readResource({ uri: flowUri });
  const resourceBody = JSON.parse(resource.contents[0].text);
  assert.equal(resourceBody.flow.id, flows[0].id);
  report.flowResourceRead = true;

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

  const after = await call('get_flows', { types: ['tab'] });
  assert.deepEqual(after, flows);
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? error.message : String(error);
  if (stderr) report.serverStderr = stderr;
  process.exitCode = 1;
} finally {
  await transport.close();
  console.log(JSON.stringify(report, null, 2));
}
