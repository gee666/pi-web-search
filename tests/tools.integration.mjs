import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import extension from '../src/index.ts';

// Exercise registration -> lifecycle gating -> tool -> real HTTP/SSE -> model-facing result.
// No provider SDK, fetch, request builder or parser is mocked.
test('registered tools preserve selected-provider search evidence and Gemini URL/video retrieval', async () => {
  const requests = [];
  const source = 'https://example.com/source';
  let events = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const tools = new Map(), hooks = {}; let active = ['read', 'web_search', 'url_context'];
  extension({ registerTool: t => tools.set(t.name, t), on: (name, fn) => hooks[name] = fn, getActiveTools: () => active, setActiveTools: names => active = names });
  const ctx = {
    model: undefined,
    getSystemPrompt: () => "PRIVATE-SENTINEL\n\nYou are Claude Code, Anthropic's official CLI for Claude.\n\nOTHER-PRIVATE-SENTINEL",
    modelRegistry: {
      getAvailable() { assert.fail('never select a fallback model'); },
      async getApiKeyAndHeaders(model) { assert.equal(model, ctx.model); return { ok: true, apiKey: model.api === 'anthropic-messages' ? 'sk-ant-oat-harmless' : 'harmless-key' }; },
    },
  };
  try {
    for (const api of ['openai-responses', 'openai-codex-responses', 'anthropic-messages', 'google-generative-ai']) {
      ctx.model = { id: `selected-${api}`, provider: 'proxy', api, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, headers: {}, maxTokens: 4096 };
      hooks.session_start({}, ctx);
      assert.deepEqual(active, api === 'google-generative-ai' ? ['read', 'web_search', 'url_context'] : ['read', 'web_search']);
      events = api === 'anthropic-messages' ? [
        { type: 'content_block_start', content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'intent query' } } },
        { type: 'content_block_start', content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', title: 'Source', url: source }] } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Verified answer' } },
      ] : api === 'google-generative-ai' ? [
        { candidates: [{ content: { parts: [{ text: 'Verified answer' }] }, groundingMetadata: { webSearchQueries: ['intent query'], groundingChunks: [{ web: { title: 'Source', uri: source } }] } }] },
      ] : [
        { type: 'response.output_text.delta', delta: 'Verified answer' },
        { type: 'response.completed', response: { output: [{ type: 'web_search_call', id: 's1', status: 'completed', action: { type: 'search', queries: ['intent query'], sources: [{ title: 'Source', url: source }] } }] } },
      ];
      const updates = [];
      const result = await tools.get('web_search').execute('call', { query: 'intent query', urls: [source] }, undefined, u => updates.push(u), ctx);
      const request = requests.at(-1);
      if (api === 'google-generative-ai') {
        assert.equal(request.path, `/v1/models/${ctx.model.id}:streamGenerateContent?alt=sse`);
        assert.equal(request.headers['x-goog-api-key'], 'harmless-key');
      } else assert.equal(request.body.model, ctx.model.id);
      assert.match(JSON.stringify(request.body), /intent query/); assert.match(JSON.stringify(request.body), /https:\/\/example.com\/source/);
      assert.doesNotMatch(JSON.stringify(request.body), /PRIVATE-SENTINEL/);
      assert.equal(result.details.nativeSearchUsed, true);
      assert.equal(result.details.model, ctx.model.id);
      assert.equal(result.details.grounded, true);
      assert.deepEqual(result.details.sources, [{ title: 'Source', url: source }]);
      assert.match(result.content[0].text, /Verified answer/); assert.match(result.content[0].text, /## Sources/);
      assert.ok(updates.length >= 2);
      if (api === 'openai-codex-responses') assert.equal(request.path, '/v1/codex/responses');
      if (api === 'anthropic-messages') {
        assert.equal(request.headers.authorization, 'Bearer sk-ant-oat-harmless');
        assert.deepEqual(request.body.system, [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }]);
        assert.equal(request.body.tools[0].max_uses, 1);
      }
      if (api === 'google-generative-ai') assert.deepEqual(request.body.tools, [{ google_search: {} }, { url_context: {} }]);
    }
    events = [{ candidates: [{ content: { parts: [{ text: 'Video and page summary' }] }, url_context_metadata: { url_metadata: [
      { retrieved_url: source, url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS' },
      { retrieved_url: 'https://example.com/blocked', url_retrieval_status: 'BLOCKED' },
    ] } }] }];
    const video = 'https://youtu.be/abcdefghijk';
    const result = await tools.get('url_context').execute('url', { query: 'Summarize', urls: [video, source] }, undefined, undefined, ctx);
    assert.deepEqual(requests.at(-1).body.tools, [{ url_context: {} }]);
    assert.deepEqual(requests.at(-1).body.contents[0].parts[0], { file_data: { file_uri: video, mime_type: 'video/mp4' } });
    assert.deepEqual(result.details.retrieved, [source]);
    assert.deepEqual(result.details.failed, [{ url: 'https://example.com/blocked', status: 'BLOCKED' }]);
    assert.match(result.content[0].text, /Failed: 1/);
    // Plain provider prose must never masquerade as verified search/retrieval.
    events = [{ candidates: [{ content: { parts: [{ text: 'Unverified prose' }] } }] }];
    for (const name of ['web_search', 'url_context']) {
      const r = await tools.get(name).execute('plain', { query: 'q', urls: [source] }, undefined, undefined, ctx);
      assert.equal(r.details.grounded, false); assert.match(r.content[0].text, /No verified/);
    }
    const before = requests.length;
    ctx.model = { id: 'unsupported', provider: 'local', api: 'openai-completions' };
    hooks.model_select({ model: ctx.model }); assert.deepEqual(active, ['read']);
    const denied = await tools.get('web_search').execute('denied', { query: 'q' }, undefined, undefined, ctx);
    assert.equal(denied.details.error, 'missing_config'); assert.equal(requests.length, before);
  } finally { await new Promise(r => server.close(r)); }
});
