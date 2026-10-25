// Test-only provider configuration. The real Pi transport sends HTTP to the test server.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync } from 'node:fs';
export default function(pi: ExtensionAPI) {
  const provider = process.env.PI_EVERGREEN_E2E_PROVIDER || 'openai';
  const id = process.env.PI_EVERGREEN_E2E_MODEL || 'gpt-6-luna';
  const endpoint = process.env.WEB_SEARCH_TEST_ENDPOINT;
  if (!endpoint) throw new Error('Test endpoint required');
  pi.registerProvider(provider, {
    baseUrl: endpoint, apiKey: 'harmless-test-key', api: 'openai-responses',
    models: [
      { id, name: id, api: 'openai-responses', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: 'unsupported-sentinel', name: 'unsupported', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: 'gemini-sentinel', name: 'gemini', api: 'google-generative-ai', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
  });
  pi.registerProvider('evergreen-anthropic', {
    baseUrl: endpoint, apiKey: 'sk-ant-oat-harmless-sentinel', api: 'anthropic-messages',
    models: [{ id: 'claude-sentinel', name: 'Claude sentinel', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  let turn = 0;
  pi.on('before_agent_start', (_event, ctx) => {
    if (ctx.model?.provider === 'evergreen-anthropic') return {
      systemPrompt: `You are Claude Code, Anthropic's official CLI for Claude. Identity-${++turn}\n\nPRIVATE-SENTINEL-${turn}`,
    };
  });
  pi.on('before_provider_request', event => {
    appendFileSync(process.env.WEB_SEARCH_TEST_OBSERVER!, JSON.stringify(event.payload) + '\n');
  });
  pi.registerCommand('test-active-tools', { description: 'Record real active tool state', handler: async () => {
    appendFileSync(process.env.WEB_SEARCH_TEST_TOOLS!, JSON.stringify(pi.getActiveTools()) + '\n');
  } });
}
