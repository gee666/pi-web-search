## Summary
- Provider-native web search uses only the selected Pi session model; never fall back.
- Gemini alone exposes URL Context, including native YouTube video inputs.
- Pi touchpoints: tool registration, lifecycle events, active tools, model/auth context.
- No internal Pi imports or undocumented Pi APIs are used; auth has a legacy fallback.
- Raw provider SSE, OAuth conventions and verification metadata are the main risks.

## Intent
Search with the currently selected Google, OpenAI, Codex OAuth or Anthropic model.
Keep unsupported tools out of the model's declarations while respecting user disables.
Return sources, search evidence and URL retrieval status, not just plausible prose.
Warn explicitly when native search or URL retrieval evidence is absent.
Analyze up to 20 URLs; Gemini YouTube inputs use native video understanding.
History confirms selected-model-only routing and deliberate Codex/Claude OAuth support.

## Pi integration (public APIs)
`ExtensionAPI.registerTool`, `on`, `getActiveTools`, `setActiveTools` register and gate tools.
`session_start`, `session_tree`, `model_select` synchronize capability changes.
`ExtensionContext.model`, `modelRegistry.getApiKeyAndHeaders` resolve selected-model auth.
Legacy registries can use `getApiKey`; `getSystemPrompt` supplies Claude OAuth identity.
Tool schemas use TypeBox; results/updates carry text and structured details.
`truncateHead`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES` bound displayed output.
Model types come from the public `@earendil-works/pi-ai` package.

## Internal Pi APIs
None. No private/deep Pi imports, session-file parsing or credential-file access at runtime.
The registry compatibility cast is feature detection for public auth methods.
Claude identity paragraph matching and Codex JWT account extraction are provider
protocol assumptions, not internal Pi APIs. Tests inspect session JSONL only as evidence.

## Weak points
Provider HTTP/SSE schemas are implemented directly, outside Pi's streaming abstraction.
Codex endpoint/headers and Claude OAuth identity, beta headers and limits can drift.
Google grounding redirects, citation offsets and metadata casing can change.
Tool preference restoration depends on lifecycle ordering and active-set observations.
Errors are returned in text/details; callers must inspect details, not only isError.
Live coverage exercises the configured provider only; fixtures cannot prove service access.

## Tests
`npm run test:evergreen`: unit, TypeScript SDK check, HTTP integration, installed Pi E2E.
`npm test`: parser/citation/auth cases, lifecycle preferences, errors, abort, truncation,
URL/video formatting and fresh OAuth identity; these protect routing and honest evidence.
`npm run test:integration`: registered tools through real local HTTP/SSE for all four
API transports; checks selected-model auth, sources, OAuth privacy, Gemini URL/video
status, no-fallback behavior and warnings for unverified prose.
`npm run test:e2e`: global Pi loads this checkout, executes native search, retries a
503, checks actual wire declarations against public hooks, persists details and resumes.
Also checks model-specific exposure and explicit disable; live search must return sources.
Uses `EVERGREEN_PI_BIN` or `pi` on PATH; `EVERGREEN_E2E_MODEL` selects live model calls.
Pi stdin is ignored. Live tests require normal Pi authentication and may incur charges.
`test:real:*` are optional provider-specific probes, not part of the Evergreen gate.

## Relevant changelog topics
Extension tool execute/result/update contracts; lifecycle and active-tool semantics;
model registry auth/header resolution; effective system prompt behavior; Model API IDs;
TypeBox and package exports; truncation utilities; JSON CLI events and session persistence.
