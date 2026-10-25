import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bin = process.env.PI_EVERGREEN_PI_BIN;
assert.ok(bin, 'PI_EVERGREEN_PI_BIN must name the installed global Pi CLI');
const provider = process.env.PI_EVERGREEN_E2E_PROVIDER || 'openai';
const model = process.env.PI_EVERGREEN_E2E_MODEL || 'gpt-6-luna';
const reasoning = process.env.PI_EVERGREEN_E2E_REASONING || 'medium';
function records(text) { return text.trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); }
function start(args, env = {}) {
  const child = spawn(bin, ['-ne', '-ns', '-np', '-nc', '--no-mcp', '--offline', '-e', resolve('src/index.ts'), ...args], { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '', stderr = ''; const events = []; const waits = new Set();
  child.stderr.on('data', b => stderr += b);
  child.stdout.on('data', b => {
    pending += b;
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i); pending = pending.slice(i + 1);
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      events.push(e);
      for (const w of waits) if (w.match(e)) { clearTimeout(w.timer); waits.delete(w); w.resolve(e); }
    }
  });
  const wait = (match, from = events.length) => {
    const existing = events.slice(from).find(match); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { match, resolve, timer: setTimeout(() => { waits.delete(w); reject(Error(`CLI timeout; stderr=${stderr}; last events=${JSON.stringify(events.slice(-3))}`)); }, 90000) }; waits.add(w);
    });
  };
  let id = 0;
  const command = async (type, fields = {}) => {
    const commandId = `cmd-${++id}`; const result = wait(e => e.type === 'response' && e.id === commandId);
    child.stdin.write(JSON.stringify({ type, id: commandId, ...fields }) + '\n');
    const r = await result; assert.equal(r.success, true, r.error); return r.data;
  };
  const prompt = async message => { const done = wait(e => e.type === 'agent_settled'); await command('prompt', { message }); await done; };
  return { child, events, command, prompt, wait, async close() { for (const w of waits) clearTimeout(w.timer); waits.clear(); child.stdin.end(); await new Promise(r => { if (child.exitCode !== null) r(); else { const t = setTimeout(() => child.kill('SIGKILL'), 3000); child.once('exit', () => { clearTimeout(t); r(); }); } }); } };
}
function send(res, events) { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); }
let serial = 0;
function assistant(res, tool) {
  const id = `resp-${++serial}`;
  const item = tool ? { type: 'function_call', id: `fc-${serial}`, call_id: `call-${serial}`, name: 'web_search', arguments: JSON.stringify({ query: 'QUERY-SENTINEL', urls: ['https://example.com/sentinel'] }), status: 'completed' } : { type: 'message', id: `msg-${serial}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE-SENTINEL', annotations: [] }] };
  send(res, [
    { type: 'response.created', response: { id, model, output: [], status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: tool ? { ...item, arguments: '' } : { ...item, content: [] } },
    ...(!tool ? [ { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'DONE-SENTINEL' } ] : []),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, model, output: [item], status: 'completed', usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]);
}

test('global Pi: provider-bound tools, execution, retry, compaction, model changes and resumed session', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(resolve('tests/.cli-'));
  await mkdir(resolve(dir, 'config'));
  await writeFile(resolve(dir, 'config/settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 0 }, retry: { baseDelayMs: 1 }, transport: 'sse' }));
  const requests = []; let failNext = false, toolNext = true;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const body = JSON.parse(raw); requests.push({ path: req.url, body });
    if (body.tools?.[0]?.type === 'web_search') {
      assert.ok(req.headers.authorization === 'Bearer harmless-test-key', 'fixture must use only harmless test credentials');
      assert.ok(Array.isArray(body.input), 'Responses input must use the portable message-list form');
      send(res, [ { type: 'response.output_text.delta', delta: 'SEARCH-ANSWER-SENTINEL' }, { type: 'response.completed', response: { output: [{ type: 'web_search_call', id: 'native-search', status: 'completed', action: { type: 'search', queries: ['QUERY-SENTINEL'], sources: [{ title: 'Sentinel source', url: 'https://example.com/source' }] } }] } } ]);
    } else if (failNext) { failNext = false; res.writeHead(503); res.end('temporary failure sentinel'); }
    else { const tool = toolNext; toolNext = false; assistant(res, tool); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const observer = resolve(dir, 'observer.jsonl'), tools = resolve(dir, 'tools.jsonl');
  const args = ['--mode', 'rpc', '--session-dir', dir, '-e', resolve('tests/cli-fixture.ts'), '--provider', provider, '--model', model, '--thinking', reasoning, '--tools', 'web_search,url_context'];
  const env = { PI_CODING_AGENT_DIR: resolve(dir, 'config'), WEB_SEARCH_TEST_ENDPOINT: endpoint, WEB_SEARCH_TEST_OBSERVER: observer, WEB_SEARCH_TEST_TOOLS: tools };
  let cli = start(args, env);
  try {
    await cli.command('set_auto_retry', { enabled: true });
    await cli.prompt('TURN-ONE-SENTINEL');
    let ends = cli.events.filter(e => e.type === 'tool_execution_end' && e.toolName === 'web_search');
    assert.equal(ends.length, 1, 'scripted provider must really invoke local extension');
    assert.equal(ends[0].isError, false); assert.equal(ends[0].result.details.nativeSearchUsed, true);
    assert.equal(ends[0].result.details.model, model); assert.equal(ends[0].result.details.sources[0].url, 'https://example.com/source');
    const nested = requests.find(r => r.body.tools?.[0]?.type === 'web_search');
    assert.match(JSON.stringify(nested.body.input), /QUERY-SENTINEL/); assert.match(JSON.stringify(nested.body.input), /https:\/\/example.com\/sentinel/);
    failNext = true;
    await cli.prompt('TURN-TWO-SENTINEL');
    assert.ok(cli.events.some(e => e.type === 'auto_retry_start'), '503 must cause real Pi retry');
    await cli.command('compact', { customInstructions: 'Keep sentinel facts.' });
    await cli.prompt('AFTER-COMPACTION-SENTINEL');
    // Observe actual active state across API transitions, then verify the next wire declaration.
    for (const id of ['gemini-sentinel', 'unsupported-sentinel', model]) {
      await cli.command('set_model', { provider, modelId: id });
      await cli.command('prompt', { message: '/test-active-tools' });
    }
    assert.deepEqual(records(await readFile(tools, 'utf8')), [['web_search', 'url_context'], [], ['web_search']]);
    await cli.prompt('AFTER-MODEL-CHANGE-SENTINEL');
    const state = await cli.command('get_state');
    const sessionFile = state.sessionFile; assert.ok(sessionFile);
    const entries = await readFile(sessionFile, 'utf8');
    assert.match(entries, /SEARCH-ANSWER-SENTINEL/); assert.match(entries, /nativeSearchUsed/); assert.match(entries, /compaction/);
    await cli.close();
    cli = start([...args, '--session', sessionFile], env);
    await cli.prompt('RESUMED-SENTINEL');
    const outer = requests.filter(r => r.body.tools?.[0]?.type !== 'web_search');
    assert.ok(outer.length >= 7);
    const observed = records(await readFile(observer, 'utf8'));
    assert.ok(observed.length >= 6, 'observer must see real multi-turn requests');
    const unmatched = [...outer];
    for (const payload of observed) {
      const index = unmatched.findIndex(r => JSON.stringify(r.body) === JSON.stringify(payload));
      assert.ok(index >= 0, 'observer payload must match a real HTTP request exactly');
      unmatched.splice(index, 1);
    }
    // Summarization uses registry streaming outside the agent request hooks.
    for (const r of unmatched) assert.ok(!(r.body.tools || []).length, 'unobserved requests may only be tool-free summaries');
    // No url_context declaration may leak on OpenAI, on any turn/retry/checkpoint.
    for (const { body } of outer) {
      const names = (body.tools || []).map(t => t.name);
      assert.ok(!names.includes('url_context'));
      if (names.length) assert.deepEqual(names, ['web_search']);
    }
    assert.deepEqual(outer.at(-1).body.tools.map(t => t.name), ['web_search']);
    assert.match(JSON.stringify(outer.at(-1).body.input), /RESUMED-SENTINEL/);
    // Negative control: the wire assertion rejects an accidentally exposed unsupported tool.
    assert.throws(() => assert.deepEqual([...outer.at(-1).body.tools, { name: 'url_context' }].map(t => t.name), ['web_search']));
    await cli.command('new_session');
    await cli.prompt('NEW-SESSION-SENTINEL');
    assert.deepEqual(requests.at(-1).body.tools.map(t => t.name), ['web_search']);
    await cli.close();
    cli = start([...args.slice(0, -2), '--no-tools'], env);
    await cli.prompt('EXPLICITLY-DISABLED-SENTINEL');
    assert.deepEqual(requests.at(-1).body.tools || [], [], '--no-tools must not be undone at session_start');
  } finally { await cli.close(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); }
});

test('global Pi: Anthropic OAuth subrequests use the current forced prompt identity on every turn', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(resolve('tests/.oauth-'));
  let toolNext = true; const native = []; const outer = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const b = JSON.parse(raw);
    const nested = b.tools?.[0]?.type === 'web_search_20250305';
    (nested ? native : outer).push(b);
    const tool = !nested && toolNext; if (tool) toolNext = false;
    const block = tool ? { type: 'tool_use', id: `tool-${outer.length}`, name: 'web_search', input: { query: 'QUERY-SENTINEL' } } : { type: 'text', text: 'ANSWER-SENTINEL' };
    send(res, [
      { type: 'message_start', message: { id: `msg-${outer.length}-${nested}`, type: 'message', role: 'assistant', content: [], model: 'claude-sentinel', stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: tool ? { ...block, input: {} } : block },
      ...(tool ? [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }] : []),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ]);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { PI_CODING_AGENT_DIR: resolve(dir, 'config'), WEB_SEARCH_TEST_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1`, WEB_SEARCH_TEST_OBSERVER: resolve(dir, 'observer'), WEB_SEARCH_TEST_TOOLS: resolve(dir, 'tools') };
  const cli = start(['--mode', 'rpc', '--session-dir', dir, '-e', resolve('tests/cli-fixture.ts'), '--provider', 'evergreen-anthropic', '--model', 'claude-sentinel', '--tools', 'web_search'], env);
  try {
    for (let turn = 1; turn <= 3; turn++) { toolNext = true; await cli.prompt(`OAUTH-TURN-${turn}`); }
    assert.equal(native.length, 3, `every turn must execute the real extension with real ExtensionContext: ${JSON.stringify(cli.events.filter(e => e.type === 'tool_execution_end' || (e.type === 'message_end' && e.message?.errorMessage)))}`);
    native.forEach((b, i) => {
      assert.deepEqual(b.system, [{ type: 'text', text: `You are Claude Code, Anthropic's official CLI for Claude. Identity-${i + 1}` }]);
      assert.doesNotMatch(JSON.stringify(b), /PRIVATE-SENTINEL/);
      assert.equal(b.max_tokens, 1024); assert.equal(b.tools[0].max_uses, 1);
    });
    assert.ok(outer.some(b => JSON.stringify(b).includes('PRIVATE-SENTINEL')), 'outer requests must prove the forced prompt really entered the provider transport');
    const state = await cli.command('get_state');
    const session = await readFile(state.sessionFile, 'utf8');
    assert.match(session, /ANSWER-SENTINEL/); assert.match(session, /nativeSearchUsed/);
  } finally { await cli.close(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); }
});

test('live global Pi: configured model executes native web search and exposes verified sources', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(resolve('tests/.live-'));
  const cli = start(['--mode', 'rpc', '--session-dir', dir, '--provider', provider, '--model', model, '--thinking', reasoning, '--tools', 'web_search']);
  try {
    await cli.command('set_auto_retry', { enabled: false });
    await cli.prompt('Call web_search exactly once with query "Search the web now for the latest Node.js release as of today; cite official nodejs.org release notes and include URLs." Then reply only OK.');
    const end = cli.events.find(e => e.type === 'tool_execution_end' && e.toolName === 'web_search');
    assert.ok(end, 'live model must execute web_search'); assert.equal(end.isError, false);
    assert.equal(end.result.details.nativeSearchUsed, true, JSON.stringify(end.result));
    assert.ok(end.result.details.sources.length > 0, 'native search must yield source URLs');
    const state = await cli.command('get_state');
    assert.match(await readFile(state.sessionFile, 'utf8'), /nativeSearchUsed/);
  } finally { await cli.close(); await rm(dir, { recursive: true, force: true }); }
});
