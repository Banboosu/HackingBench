import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { ROOT, defaults, configSchema } from '../src/config.js';
import { temporaryDirectory } from './fixtures.js';
import { endpointIdentity, projectKey, validateProjectAuth, controllerEnvironment } from '../src/pi/project.js';
import { discoverModels, parseModels } from '../src/pi/discovery.js';

async function serverFor(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
test('endpoint-bound native auth identity changes with origin, path, port and protocol', () => {
  const config = defaults(); const id = endpointIdentity(config);
  assert.equal(endpointIdentity({ ...config, baseUrl: config.baseUrl + '/' }), id);
  for (const change of [{ baseUrl: 'https://api.openai.com/other' }, { baseUrl: 'https://other.example/v1' }, { baseUrl: 'https://api.openai.com:444/v1' }, { api: 'openai-completions' as const }]) assert.notEqual(endpointIdentity({ ...config, ...change }), id);
  assert.match(endpointIdentity({ api: 'openai-completions', baseUrl: 'https://api.commandcode.ai/provider/v1' }), /^commandcode-/);
  assert.equal('keyEnv' in configSchema.parse({ keyEnv: 'OLD_VARIABLE' }), false);
});
test('headless reads native auth.json literally, with endpoint binding and safe failure messages', async () => {
  const dir = await temporaryDirectory('auth-'); const file = path.join(dir, 'auth.json'); const config = defaults();
  try {
    assert.equal(await projectKey(config, file), '');
    const key = 'fixture-only-key';
    await writeFile(file, JSON.stringify({ [endpointIdentity(config)]: { type: 'api_key', key } }));
    assert.equal(await projectKey(config, file), key); await validateProjectAuth(file);
    assert.equal(await projectKey({ ...config, baseUrl: 'https://other.example/v1' }, file), '');
    for (const bad of ['!do-not-execute', '$NO_VARIABLES', 'embedded-${NO_VARIABLES}', 'line\nbreak', 'bad\x1bkey']) {
      await writeFile(file, JSON.stringify({ [endpointIdentity(config)]: { type: 'api_key', key: bad } }));
      await assert.rejects(() => projectKey(config, file)); await assert.rejects(() => validateProjectAuth(file));
    }
    await writeFile(file, 'sensitive-broken-json');
    await assert.rejects(() => projectKey(config, file), error => !(error as Error).message.includes('sensitive-broken-json'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('controller environment points native pi at project storage and excludes unrelated keys', () => {
  const env = controllerEnvironment();
  assert.match(env.PI_CODING_AGENT_DIR!, /runtime[\\/]controller$/);
  assert.equal(env.PI_TELEMETRY, '0'); assert.equal(env.PI_OFFLINE, '1');
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.HACKINGBENCH_API_KEY, undefined);
});
test('model parser whitelists metadata and never imports remote executable config', () => {
  const models = parseModels({ data: [
    { id: 'deepseek-v4.1-flash', name: 'model\x1b\u202e', apiKey: '!evil', baseUrl: 'https://evil.example', headers: { authorization: 'secret' }, context_length: 1000000, max_output_tokens: 400000, reasoning: true },
    { id: '!powershell' }, { id: 'bad\nmodel' }, { id: 'bad model' }, { id: 'normal', reasoning: 'yes', max_tokens: -1 },
  ] });
  assert.equal(models.length, 2);
  assert.equal(models[0]!.reasoning, true); assert.equal(models[0]!.contextWindow, 1000000); assert.equal(models[0]!.maxTokens, 65536);
  assert.equal(models[0]!.name, 'model'); assert.equal('apiKey' in models[0]!, false); assert.equal('baseUrl' in models[0]!, false);
  assert.equal(models[1]!.reasoning, false);
  assert.throws(() => parseModels({ data: [{ id: '!only-bad' }] }), /No safe/);
  assert.throws(() => parseModels({ models: [] }), /data array/);
});
test('model discovery fetches bearer-authenticated catalog and strips echoed secrets', async () => {
  const key = 'fixture-key-never-log';
  const server = await serverFor((req, res) => {
    assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash', name: key }, { id: key }] }));
  });
  try {
    const models = await discoverModels({ ...defaults(), api: 'openai-completions', baseUrl: server.url }, key);
    assert.equal(models.length, 1); assert.ok(!JSON.stringify(models).includes(key));
  } finally { await server.close(); }
});
test('Anthropic discovery adds /v1 for native SDK-style base URLs and sends required headers', async () => {
  const server = await serverFor((req, res) => {
    assert.equal(req.url, '/v1/models'); assert.equal(req.headers['x-api-key'], 'fixture-anthropic'); assert.equal(req.headers['anthropic-version'], '2023-06-01');
    res.end(JSON.stringify({ data: [{ id: 'fixture-claude' }] }));
  });
  try { assert.equal((await discoverModels({ ...defaults(), api: 'anthropic-messages', baseUrl: server.url.replace('/v1', '') }, 'fixture-anthropic'))[0]!.id, 'fixture-claude'); }
  finally { await server.close(); }
});
test('discovery refuses redirects, omits HTTP error bodies and rejects malformed/oversized catalogs', async () => {
  let mode = 'redirect'; let redirected = false;
  const server = await serverFor((req, res) => {
    if (req.url !== '/v1/models') { redirected = true; res.end('{}'); return; }
    if (mode === 'redirect') { res.writeHead(302, { location: '/other' }); res.end(); }
    else if (mode === 'http') { res.writeHead(401); res.end('fixture-sensitive-body'); }
    else if (mode === 'json') res.end('fixture-sensitive-body');
    else res.end('x'.repeat(2 * 1024 * 1024 + 1));
  });
  const config = { ...defaults(), baseUrl: server.url };
  try {
    await assert.rejects(() => discoverModels(config, 'fixture-key'), /refused redirect/); assert.equal(redirected, false);
    mode = 'http'; await assert.rejects(() => discoverModels(config, 'fixture-key'), error => /HTTP 401/.test((error as Error).message) && !(error as Error).message.includes('fixture-sensitive-body'));
    mode = 'json'; await assert.rejects(() => discoverModels(config, 'fixture-key'), /not valid JSON/);
    mode = 'large'; await assert.rejects(() => discoverModels(config, 'fixture-key'), /exceeds 2 MiB/);
  } finally { await server.close(); }
});
test('discovery cancellation stops a blocked HTTP response', async () => {
  const server = await serverFor(() => {}); const controller = new AbortController();
  try {
    const request = discoverModels({ ...defaults(), baseUrl: server.url }, 'fixture-key', controller.signal);
    controller.abort(); await assert.rejects(request, /cancelled/);
  } finally { await server.close(); }
});
test('git ignores native auth files as well as runtime', async () => {
  const ignore = await readFile(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^auth\.json$/m); assert.match(ignore, /^runtime\/$/m);
});
