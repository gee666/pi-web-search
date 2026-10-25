# oira666_pi-web-search

Provider-native web search for [pi](https://github.com/earendil-works/pi-coding-agent), across the currently selected Google Gemini, OpenAI, or Anthropic model, plus Gemini-only URL Context analysis.

## Tools

### `web_search`

Search the web using your currently selected model. Automatically picks the right provider API:

| Provider | API |
|---|---|
| Google Gemini | Grounding with Google Search |
| OpenAI | Responses API web search, including pi's `openai-codex` OAuth Responses backend |
| Anthropic | Messages API web search, including Claude Code OAuth subscription tokens |

Supports passing up to 20 additional URLs to analyze alongside the query.

### `url_context`

Gemini-only. Analyze up to 20 public URLs — web pages, documents, images, and YouTube videos. Uses Gemini's native URL Context retrieval with verified metadata.

When using `google-generative-ai`, YouTube URLs are passed as `file_data` for native video understanding.

## Install

```bash
pi install npm:oira666_pi-web-search
```

## Usage

No extra config needed. Select a supported provider/model in pi and the tools use the currently selected session model.

The extension does not switch models or fall back to another configured model. If the currently selected model does not support provider-native web search, `web_search` is automatically removed from active tools. `url_context` is automatically removed from active tools when using a non-Gemini model.

## Test

```bash
cp .env.example .env   # edit with your models
npm test               # deterministic intent/parser tests
npm run check          # SDK type validation
npm run test:e2e       # installed global Pi: transport/lifecycle + live native search
npm run test:real:web-search
npm run test:real:url-context
```

`test:e2e` requires `PI_EVERGREEN_PI_BIN` pointing to the installed global Pi executable. It never installs a runtime or silently skips live coverage. Model selection honors `PI_EVERGREEN_E2E_PROVIDER` (default `openai`), `PI_EVERGREEN_E2E_MODEL` (default `gpt-6-luna`), and `PI_EVERGREEN_E2E_REASONING` (default `medium`). The live check uses normal Pi provider authentication; tests do not read credential files. It makes a small native-search request, which may incur provider search charges.

The deterministic CLI checks use isolated configuration and harmless credentials against a local HTTP/SSE server, explicitly loading `src/index.ts`. They compare actual transport requests with public request-hook observations, inspect persisted tool details, and cover retries, compaction, model changes, resume, new sessions, explicit tool disabling, and fresh Anthropic OAuth prompt identity across turns. Anthropic/Google/Codex service behavior beyond these fixtures still needs provider-specific live checks (`test:real:*`).

## License

MIT
