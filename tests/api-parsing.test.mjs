import test from 'node:test';
import assert from 'node:assert/strict';
import { callApiStream } from '../src/api.ts';
import { createModelScopedToolManager } from '../src/index.ts';
import { urlContext } from '../src/url_context.ts';

function sse(events) {
  return events.map((event) => {
    const name = event.event ? `event: ${event.event}\n` : '';
    return `${name}data: ${JSON.stringify(event.data)}\n\n`;
  }).join('');
}

function mockCtx(apiKey = 'test-key', model = undefined) {
  return {
    model,
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey };
      },
      getAvailable() {
        return model ? [model] : [];
      },
    },
  };
}

function makeResponse(events) {
  return new Response(sse(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('OpenAI stream exposes native search calls, queries, URLs, and citations', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools[0].type, 'web_search');
    assert.deepEqual(body.include, ['web_search_call.action.sources', 'web_search_call.results']);
    assert.equal(body.tool_choice, undefined);
    return makeResponse([
      { data: { type: 'response.web_search_call.in_progress', item_id: 'ws_1' } },
      { data: { type: 'response.web_search_call.searching', item_id: 'ws_1' } },
      { data: { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_1', status: 'searching', action: { type: 'search', query: 'OpenAI docs', queries: ['OpenAI docs'], sources: [{ type: 'url', url: 'https://platform.openai.com/docs/guides/tools-web-search' }] } } } },
      { data: { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1', content: [] } } },
      { data: { type: 'response.content_part.added', part: { type: 'output_text', text: '', annotations: [] } } },
      { data: { type: 'response.output_text.delta', delta: 'See OpenAI docs' } },
      { data: { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', start_index: 4, end_index: 15, url_citation: { title: 'OpenAI docs', url: 'https://platform.openai.com/docs/guides/tools-web-search' } } } },
      { data: { type: 'response.web_search_call.completed', item_id: 'ws_1' } },
      { data: { type: 'response.completed', response: { output: [
        { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['OpenAI docs'], sources: [{ type: 'url', url: 'https://platform.openai.com/docs/guides/tools-web-search' }] } },
        { type: 'message', content: [{ type: 'output_text', text: 'See OpenAI docs', annotations: [{ type: 'url_citation', start_index: 4, end_index: 15, url_citation: { title: 'OpenAI docs', url: 'https://platform.openai.com/docs/guides/tools-web-search' } }] }] },
      ] } } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(), {
      id: 'gpt-test',
      provider: 'proxy-provider',
      api: 'openai-responses',
      baseUrl: 'https://example.test/v1',
      reasoning: false,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search OpenAI docs' }] }] });

    assert.equal(result.providerKind, 'openai');
    assert.equal(result.nativeSearchUsed, true);
    assert.deepEqual(result.nativeSearchEvents, [
      'response.web_search_call.in_progress',
      'response.web_search_call.searching',
      'response.web_search_call.completed',
    ]);
    assert.deepEqual(result.searchQueries, ['OpenAI docs']);
    assert.equal(result.nativeSearchCalls.length >= 1, true);
    assert.equal(result.searchResults.some((item) => item.url === 'https://platform.openai.com/docs/guides/tools-web-search' && item.title === 'OpenAI docs'), true);
    assert.equal(result.citations.some((item) => item.title === 'OpenAI docs' && item.url.includes('/tools-web-search')), true);
    assert.equal(result.sources[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
    assert.equal(result.sources[0].title, 'OpenAI docs');
    assert.equal(result.sources.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI Codex OAuth stream uses codex endpoint and exposes web search', async () => {
  const previousFetch = globalThis.fetch;
  const tokenPayload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test' } })).toString('base64url');
  const token = `header.${tokenPayload}.sig`;

  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.headers['chatgpt-account-id'], 'acct_test');
    assert.equal(init.headers['OpenAI-Beta'], 'responses=experimental');
    const body = JSON.parse(init.body);
    assert.equal(body.instructions.length > 0, true);
    assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'Search current news' }] }]);
    assert.equal(body.tools[0].type, 'web_search');
    return makeResponse([
      { data: { type: 'response.web_search_call.searching', item_id: 'ws_codex' } },
      { data: { type: 'response.output_text.delta', delta: 'Codex found news' } },
      { data: { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', end_index: 16, url_citation: { title: 'News source', url: 'https://example.com/news' } } } },
      { data: { type: 'response.done', response: { output: [
        { type: 'web_search_call', id: 'ws_codex', status: 'completed', action: { type: 'search', queries: ['current news'], sources: [{ type: 'url', title: 'News source', url: 'https://example.com/news' }] } },
      ] } } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(token), {
      id: 'gpt-5.4-mini',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: true,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search current news' }] }] });

    assert.equal(result.providerKind, 'openai');
    assert.equal(result.nativeSearchUsed, true);
    assert.deepEqual(result.searchQueries, ['current news']);
    assert.equal(result.sources[0].url, 'https://example.com/news');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Anthropic stream exposes server web search, result URLs, and citation details', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 10 });
    assert.equal(body.tool_choice, undefined);
    return makeResponse([
      { data: { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'OpenAI docs' } } } },
      { data: { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', title: 'OpenAI docs', url: 'https://platform.openai.com/docs/guides/tools-web-search', page_age: null, encrypted_content: 'x' }] } } },
      { data: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
      { data: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'OpenAI docs explain web search.' } } },
      { data: { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', cited_text: 'OpenAI docs', title: 'OpenAI docs', url: 'https://platform.openai.com/docs/guides/tools-web-search', encrypted_index: 'abc' } } } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(), {
      id: 'claude-test',
      provider: 'proxy-provider',
      api: 'anthropic-messages',
      baseUrl: 'https://example.test/anthropic',
      maxTokens: 4096,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search OpenAI docs' }] }] });

    assert.equal(result.providerKind, 'anthropic');
    assert.equal(result.nativeSearchUsed, true);
    assert.deepEqual(result.nativeSearchEvents, [
      'anthropic.content_block_start.server_tool_use.web_search',
      'anthropic.content_block_start.web_search_tool_result',
    ]);
    assert.deepEqual(result.searchQueries, ['OpenAI docs']);
    assert.equal(result.nativeSearchCalls[0].id, 'srv_1');
    assert.equal(result.searchResults.some((item) => item.url === 'https://platform.openai.com/docs/guides/tools-web-search'), true);
    assert.equal(result.citations.some((item) => item.citedText === 'OpenAI docs'), true);
    assert.equal(result.sources[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Google stream exposes grounding queries, chunks, support citations, and resolves redirect URLs', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'HEAD') {
      assert.equal(url, 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc');
      return new Response('', {
        status: 302,
        headers: { location: 'https://platform.openai.com/docs/guides/tools-web-search' },
      });
    }
    assert.equal(JSON.parse(init.body).tools[0].google_search instanceof Object, true);
    return makeResponse([
      { data: { candidates: [{ content: { parts: [{ text: 'Gemini grounded answer' }] } }] } },
      { data: { candidates: [{ groundingMetadata: {
        webSearchQueries: ['OpenAI docs'],
        groundingChunks: [{ web: { title: 'OpenAI docs', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc' } }],
        groundingSupports: [{ segment: { text: 'Gemini grounded answer', endIndex: 22 }, groundingChunkIndices: [0] }],
      } }] } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(), {
      id: 'gemini-test',
      provider: 'proxy-provider',
      api: 'google-generative-ai',
      baseUrl: 'https://example.test/gemini/v1beta',
      headers: {},
    }, {
      contents: [{ role: 'user', parts: [{ text: 'Search OpenAI docs' }] }],
      tools: [{ google_search: {} }],
    });

    assert.equal(result.providerKind, 'google');
    assert.equal(result.nativeSearchUsed, true);
    assert.deepEqual(result.searchQueries, ['OpenAI docs']);
    assert.equal(result.searchResults[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
    assert.equal(result.citations[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
    assert.equal(result.citations[0].citedText, 'Gemini grounded answer');
    assert.equal(result.sources[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('url_context rejects non-Gemini providers with a clear error', async () => {
  const model = {
    id: 'gpt-test',
    provider: 'proxy-provider',
    api: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    headers: {},
  };

  const result = await urlContext(
    'tool-1',
    { query: 'Summarize this URL', urls: ['https://example.com'] },
    new AbortController().signal,
    undefined,
    mockCtx('test-key', model),
  );

  assert.match(result.content[0].text, /requires a Google Gemini-compatible model/i);
  assert.equal(result.details.error, 'unsupported_provider');
  assert.equal(result.details.providerKind, 'openai');
  assert.equal(result.details.grounded, false);
});

test('url_context warns when Gemini returns no verified URL context metadata', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse([
    { data: { candidates: [{ content: { parts: [{ text: 'Plain summary without metadata' }] } }] } },
  ]);

  try {
    const model = {
      id: 'gemini-test',
      provider: 'proxy-provider',
      api: 'google-generative-ai',
      baseUrl: 'https://example.test/gemini/v1beta',
      headers: {},
    };

    const result = await urlContext(
      'tool-2',
      { query: 'Summarize this URL', urls: ['https://example.com'] },
      new AbortController().signal,
      undefined,
      mockCtx('test-key', model),
    );

    assert.match(result.content[0].text, /No verified URL context metadata/i);
    assert.equal(result.details.providerKind, 'google');
    assert.equal(result.details.grounded, false);
    assert.deepEqual(result.details.sources, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('model-scoped tool manager removes unsupported tools and restores them when supported', async () => {
  let activeTools = ['read', 'web_search', 'url_context'];
  const changes = [];
  const manager = createModelScopedToolManager({
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(toolNames) {
      activeTools = [...toolNames];
      changes.push([...toolNames]);
    },
  });

  manager.sync({ id: 'local-test', provider: 'local', api: 'local' });
  assert.deepEqual(activeTools, ['read']);

  manager.sync({ id: 'gpt-test', provider: 'proxy-provider', api: 'openai-responses' });
  assert.deepEqual(activeTools, ['read', 'web_search']);

  manager.sync({ id: 'gemini-test', provider: 'proxy-provider', api: 'google-generative-ai' });
  assert.deepEqual(activeTools, ['read', 'web_search', 'url_context']);
  assert.equal(changes.length >= 3, true);
});
