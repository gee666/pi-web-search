import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bin = process.env.EVERGREEN_PI_BIN || 'pi';
const fixtureModel = 'search-sentinel';
function records(text) { return text.trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); }
async function run(args, env = {}) {
  const child = spawn(bin, ['-ne', '-ns', '-np', '-nc', '--no-mcp', '--offline', '-e', resolve('src/index.ts'), '--mode', 'json', ...args], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const timer = setTimeout(() => child.kill('SIGKILL'), 150000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, `Pi failed: ${stderr}\n${stdout}`);
    return records(stdout);
  } finally { clearTimeout(timer); }
}
function send(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
let serial = 0;
function assistant(res, tool) {
  const id = `resp-${++serial}`;
  const item = tool ? { type: 'function_call', id: `fc-${serial}`, call_id: `call-${serial}`, name: 'web_search', arguments: JSON.stringify({ query: 'QUERY-SENTINEL', urls: ['https://example.com/sentinel'] }), status: 'completed' } : { type: 'message', id: `msg-${serial}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE-SENTINEL', annotations: [] }] };
  send(res, [
    { type: 'response.created', response: { id, model: fixtureModel, output: [], status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: tool ? { ...item, arguments: '' } : { ...item, content: [] } },
    ...(!tool ? [{ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'DONE-SENTINEL' }] : []),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, model: fixtureModel, output: [item], status: 'completed', usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]);
}

test('global Pi: selected-model native search, wire declarations, persisted details and resume', { timeout: 600000 }, async () => {
  const dir = await mkdtemp(resolve('tests/.cli-'));
  const requests = []; let toolNext = true, failNext = true;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const body = JSON.parse(raw); requests.push(body);
    if (body.tools?.[0]?.type === 'web_search') {
      assert.equal(req.headers.authorization, 'Bearer harmless-test-key');
      assert.equal(body.model, fixtureModel);
      assert.match(JSON.stringify(body.input), /QUERY-SENTINEL/);
      assert.match(JSON.stringify(body.input), /https:\/\/example.com\/sentinel/);
      send(res, [{ type: 'response.output_text.delta', delta: 'SEARCH-ANSWER-SENTINEL' }, { type: 'response.completed', response: { output: [{ type: 'web_search_call', id: 'native-search', status: 'completed', action: { type: 'search', queries: ['QUERY-SENTINEL'], sources: [{ title: 'Sentinel source', url: 'https://example.com/source' }] } }] } }]);
    } else if (failNext) { failNext = false; res.writeHead(503); res.end('temporary failure'); }
    else { const tool = toolNext; toolNext = false; assistant(res, tool); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const observer = resolve(dir, 'observer'), tools = resolve(dir, 'tools'), session = resolve(dir, 'session.jsonl');
  const env = { PI_CODING_AGENT_DIR: resolve(dir, 'config'), WEB_SEARCH_TEST_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1`, WEB_SEARCH_TEST_OBSERVER: observer, WEB_SEARCH_TEST_TOOLS: tools };
  const args = ['-e', resolve('tests/cli-fixture.ts'), '--provider', 'evergreen-openai', '--model', fixtureModel, '--session', session, '--tools', 'web_search,url_context'];
  try {
    await mkdir(env.PI_CODING_AGENT_DIR);
    await writeFile(resolve(env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ retry: { enabled: true, baseDelayMs: 1 }, transport: 'sse' }));
    const events = await run([...args, 'TURN-ONE-SENTINEL'], env);
    const end = events.find(e => e.type === 'tool_execution_end' && e.toolName === 'web_search');
    assert.ok(end, JSON.stringify(events)); assert.equal(end.isError, false);
    assert.equal(end.result.details.nativeSearchUsed, true);
    assert.equal(end.result.details.model, fixtureModel);
    assert.equal(end.result.details.sources[0].url, 'https://example.com/source');
    assert.ok(events.some(e => e.type === 'auto_retry_start'), 'real Pi must retry the initial 503');
    await run([...args, 'RESUMED-SENTINEL'], env);
    assert.match(JSON.stringify(requests.at(-1).input), /SEARCH-ANSWER-SENTINEL/);
    assert.match(JSON.stringify(requests.at(-1).input), /RESUMED-SENTINEL/);
    const persisted = await readFile(session, 'utf8');
    assert.match(persisted, /nativeSearchUsed/); assert.match(persisted, /SEARCH-ANSWER-SENTINEL/);
    for (const body of requests.filter(b => b.tools?.[0]?.type !== 'web_search')) {
      assert.deepEqual(body.tools.map(t => t.name), ['web_search'], 'Gemini-only tool must never leak onto OpenAI transport');
    }
    for (const payload of records(await readFile(observer, 'utf8'))) {
      assert.ok(requests.some(b => JSON.stringify(b) === JSON.stringify(payload)), 'public hook must observe actual wire payload');
    }
    for (const [id, expected] of [[fixtureModel, ['web_search']], ['gemini-sentinel', ['web_search', 'url_context']], ['unsupported-sentinel', []]]) {
      await run([...args, '--model', id, '/test-active-tools'], env);
      assert.deepEqual(records(await readFile(tools, 'utf8')).at(-1), expected);
    }
    await run([...args.slice(0, -2), '--session', resolve(dir, 'disabled.jsonl'), '--no-tools', 'DISABLED-SENTINEL'], env);
    assert.deepEqual(requests.at(-1).tools || [], [], 'explicit disable must survive session_start');
  } finally { await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); }
});

test('live global Pi: configured model executes native web search with verified sources', { timeout: 180000 }, async () => {
  assert.ok(process.env.EVERGREEN_E2E_MODEL, 'EVERGREEN_E2E_MODEL must select the live model');
  const dir = await mkdtemp(resolve('tests/.live-'));
  const session = resolve(dir, 'session.jsonl');
  try {
    const events = await run(['--session', session, '--model', process.env.EVERGREEN_E2E_MODEL, '--tools', 'web_search', 'Call web_search exactly once with query "Search the web now for the latest Node.js release as of today; cite official nodejs.org release notes and include URLs." Then reply only OK.']);
    const ends = events.filter(e => e.type === 'tool_execution_end' && e.toolName === 'web_search');
    assert.equal(ends.length, 1, JSON.stringify(events.filter(e => e.type === 'message_end')));
    const end = ends[0]; assert.equal(end.isError, false);
    assert.equal(end.result.details.nativeSearchUsed, true, JSON.stringify(end.result));
    assert.ok(end.result.details.sources.length > 0, 'native search must yield source URLs');
    for (const source of end.result.details.sources) assert.match(source.url, /^https?:\/\//);
    assert.match(await readFile(session, 'utf8'), /nativeSearchUsed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
