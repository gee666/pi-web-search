import test from 'node:test';
import assert from 'node:assert/strict';
import extension, { createModelScopedToolManager } from '../src/index.ts';
import { webSearch, WebSearchSchema } from '../src/web_search.ts';
import { urlContext, UrlContextSchema } from '../src/url_context.ts';
import { callApiStream, applyCitations } from '../src/api.ts';
import { formatResult } from '../src/utils.ts';

const model = (api = 'openai-responses') => ({ id: 'sentinel-model', provider: 'proxy', api, baseUrl: 'https://sentinel.test/v1', maxTokens: 4096, headers: {} });
const ctx = (m = model(), auth = { ok: true, apiKey: 'sentinel-key' }) => ({ model: m, modelRegistry: { getApiKeyAndHeaders: async () => auth, getAvailable() { throw Error('must not fall back'); } } });
const body = { contents: [{ parts: [{ text: 'sentinel-query' }] }] };
function response(events) {
  // Deliberately split UTF-8 code points and SSE lines across network chunks.
  const bytes = new TextEncoder().encode(events.map(x => `data: ${JSON.stringify(x)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close(); } }));
}
async function withFetch(fetch, fn) { const old = globalThis.fetch; globalThis.fetch = fetch; try { await fn(); } finally { globalThis.fetch = old; } }

test('registration and session/model/tree hooks preserve user tool choices without churn', () => {
  const tools = [], hooks = {}; let active = ['read', 'web_search', 'url_context']; let changes = 0;
  extension({ registerTool: t => tools.push(t), on: (n, f) => hooks[n] = f, getActiveTools: () => active, setActiveTools: a => { active = a; changes++; } });
  assert.deepEqual(tools.map(t => t.name), ['web_search', 'url_context']);
  assert.equal(tools[0].execute, webSearch); assert.equal(tools[1].execute, urlContext);
  hooks.session_start({}, ctx()); assert.deepEqual(active, ['read', 'web_search']);
  hooks.session_tree({}, ctx()); assert.equal(changes, 1);
  active = ['read', 'edit']; // external removal of web_search and addition of edit
  hooks.model_select({ model: model('google-generative-ai') });
  assert.deepEqual(active, ['read', 'url_context', 'edit']);
  hooks.model_select({ model: undefined }); assert.deepEqual(active, ['read', 'edit']);
  hooks.session_start({}, ctx(model('google-generative-ai'))); assert.deepEqual(active, ['read', 'url_context', 'edit']);
  const manager = createModelScopedToolManager({ getActiveTools: () => ['read'], setActiveTools() { assert.fail('explicitly disabled tools must stay disabled'); } });
  manager.sync(model('google-generative-ai'));
});

test('tool schemas enforce URL limits and required query', () => {
  assert.deepEqual(WebSearchSchema.required, ['query']);
  assert.equal(WebSearchSchema.properties.urls.maxItems, 20);
  assert.deepEqual(UrlContextSchema.required, ['query', 'urls']);
  assert.equal(UrlContextSchema.properties.urls.minItems, 1);
  assert.equal(UrlContextSchema.properties.urls.maxItems, 20);
});

test('selected model only, missing auth, HTTP/SSE errors and abort remain recoverable', async () => {
  await withFetch(() => assert.fail('no request for unsupported model'), async () => {
    for (const m of [undefined, model('openai-completions')]) {
      const c = ctx(); c.model = m;
      const r = await webSearch('x', { query: 'q' }, undefined, undefined, c);
      assert.equal(r.details.error, 'missing_config');
    }
    const r = await webSearch('x', { query: 'q' }, undefined, undefined, ctx(model(), { ok: false, error: 'auth sentinel' }));
    assert.match(r.content[0].text, /auth sentinel/);
  });
  for (const api of ['openai-responses', 'anthropic-messages', 'google-generative-ai']) {
    await withFetch(async () => new Response('failure sentinel', { status: 429 }), async () => {
      const r = await webSearch('x', { query: 'q' }, undefined, undefined, ctx(model(api)));
      assert.equal(r.details.error, true); assert.match(r.content[0].text, /429.*failure sentinel/);
    });
    const event = api === 'anthropic-messages' ? { type: 'error', error: { message: 'stream sentinel' } } : api === 'google-generative-ai' ? { error: { message: 'stream sentinel' } } : { type: 'response.failed', response: { error: { message: 'stream sentinel' } } };
    await withFetch(async () => response([event]), async () => {
      const r = await webSearch('x', { query: 'q' }, undefined, undefined, ctx(model(api)));
      assert.equal(r.details.error, true); assert.match(r.content[0].text, /stream sentinel/);
    });
  }
  const controller = new AbortController(); controller.abort();
  await withFetch(async (_u, init) => { assert.equal(init.signal, controller.signal); init.signal.throwIfAborted(); }, async () => {
    assert.equal((await webSearch('x', { query: 'q' }, controller.signal, undefined, ctx())).details.error, true);
  });
  await withFetch(async () => response([{ type: 'response.output_text.delta', delta: 'recovered' }]), async () => {
    const r = await webSearch('x', { query: 'q' }, undefined, undefined, ctx());
    assert.match(r.content[0].text, /recovered/); assert.match(r.content[0].text, /No verified native search metadata/); assert.equal(r.details.grounded, false);
  });
});

test('auth headers and legacy registry fallback are honored without leaking into prompts', async () => {
  for (const registry of [{ getApiKeyAndHeaders: async () => ({ ok: true, headers: { Authorization: 'Bearer header-sentinel', 'X-Proxy': 'proxy-sentinel' } }) }, { getApiKey: async () => 'legacy-sentinel' }]) {
    await withFetch(async (url, init) => {
      assert.equal(url, 'https://sentinel.test/v1/responses');
      assert.match(init.headers.Authorization, /sentinel/);
      assert.deepEqual(JSON.parse(init.body).input, [{ role: 'user', content: [{ type: 'input_text', text: 'sentinel-query' }] }]);
      assert.doesNotMatch(init.body, /header-sentinel|legacy-sentinel|proxy-sentinel/);
      return response([{ type: 'response.output_text.delta', delta: '你好 🌍' }]);
    }, async () => {
      assert.equal((await callApiStream({ modelRegistry: registry }, model(), body)).text, '你好 🌍');
    });
  }
});

test('Anthropic OAuth reads fresh identity each call and never forwards unrelated prompt paragraphs', async () => {
  let turn = 0;
  const c = ctx(model('anthropic-messages'), { ok: true, apiKey: 'sk-ant-oat-sentinel' });
  c.getSystemPrompt = () => `PRIVATE-SENTINEL-${turn}\n\nYou are Claude Code, Anthropic's official CLI for Claude. Identity-${turn}\n\nOTHER-PRIVATE-SENTINEL`;
  await withFetch(async (_u, init) => {
    const b = JSON.parse(init.body);
    assert.deepEqual(b.system, [{ type: 'text', text: `You are Claude Code, Anthropic's official CLI for Claude. Identity-${turn}` }]);
    assert.doesNotMatch(init.body, /PRIVATE-SENTINEL/); assert.equal(b.tools[0].max_uses, 1);
    return response([]);
  }, async () => { for (turn = 0; turn < 3; turn++) await callApiStream(c, c.model, body); });
  c.getSystemPrompt = () => 'No OAuth identity here';
  await withFetch(async (_u, init) => { assert.equal(JSON.parse(init.body).system, undefined); return response([]); }, () => callApiStream(c, c.model, body));
});

test('Gemini URL/video inputs, retrieval statuses, search combination and updates survive serialization', async () => {
  const google = ctx(model('google-generative-ai')); const updates = [];
  await withFetch(async (_u, init) => {
    const b = JSON.parse(init.body);
    assert.deepEqual(b.tools, [{ url_context: {} }]);
    assert.deepEqual(b.contents[0].parts[0], { file_data: { file_uri: 'https://youtu.be/abcdefghijk', mime_type: 'video/mp4' } });
    assert.match(b.contents[0].parts[1].text, /https:\/\/example.com/);
    return response([{ candidates: [{ content: { parts: [{ text: 'video sentinel' }] }, url_context_metadata: { url_metadata: [
      { retrieved_url: 'https://example.com', url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS' },
      { retrieved_url: 'https://example.com/fail', url_retrieval_status: 'BLOCKED' }
    ] } }] }]);
  }, async () => {
    const r = await urlContext('x', { query: 'summarize', urls: ['https://youtu.be/abcdefghijk', 'https://example.com'] }, undefined, u => updates.push(u), google);
    assert.deepEqual(r.details.retrieved, ['https://example.com']); assert.equal(r.details.failed[0].status, 'BLOCKED');
    assert.match(r.content[0].text, /Failed: 1/); assert.doesNotMatch(r.content[0].text, /No verified/);
    const persisted = JSON.parse(JSON.stringify(r));
    assert.deepEqual(persisted.content, r.content); assert.deepEqual(persisted.details.retrieved, r.details.retrieved); assert.deepEqual(persisted.details.failed, r.details.failed); assert.ok(updates.length >= 2);
  });
  await withFetch(async (_u, init) => {
    const b = JSON.parse(init.body); assert.deepEqual(b.tools, [{ google_search: {} }, { url_context: {} }]);
    assert.match(b.contents[0].parts[0].text, /Also analyze these URLs:\nhttps:\/\/example.com/);
    return response([]);
  }, () => webSearch('x', { query: 'q', urls: ['https://example.com'] }, undefined, undefined, google));
});

test('citation byte offsets and truncation preserve Unicode and full structured details', () => {
  const metadata = { groundingChunks: [{ web: { title: 'source', uri: 'https://example.com' } }], groundingSupports: [{ segment: { endIndex: 6 }, groundingChunkIndices: [0] }] };
  assert.equal(applyCitations('你好 world', metadata).text, '你好[1] world');
  const details = { sources: [{ url: 'https://example.com' }], raw: 'x'.repeat(100000) };
  const r = formatResult('你好\n'.repeat(10000), details);
  assert.match(r.content[0].text, /\[Truncated\]/); assert.ok(r.content[0].text.length < 10000 * 3); assert.equal(r.details, details);
});
