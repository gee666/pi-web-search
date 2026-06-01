import type { ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type Model } from "@earendil-works/pi-ai";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { getProviderKind } from "./api.ts";

// --- Formatting ---

export function formatResult(text: string, details: any): AgentToolResult<any> {
    const { content, truncated } = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    return {
        content: [{ type: "text", text: content + (truncated ? "\n\n[Truncated]" : "") }],
        details
    };
}

// --- Model Selection ---

function isSupportedSearchModel(model: Model<any> | undefined): model is Model<any> {
    if (!model) return false;
    return getProviderKind(model) !== "unsupported";
}

export async function getModel(ctx: ExtensionContext): Promise<Model<any> | undefined> {
    // Web search must use the currently selected session model only.
    // Do not silently fall back to or select a different configured model.
    if (isSupportedSearchModel(ctx.model)) {
        return ctx.model;
    }

    return undefined;
}

// --- Error Results ---

export function missingConfigResult(ctx: ExtensionContext): AgentToolResult<any> {
    const current = ctx.model ? `${ctx.model.provider} (${ctx.model.api})` : "none";
    const msg = `The currently selected model does not support web search. Current model: ${current}. Select a supported provider: google-generative-ai, openai, or anthropic.`;
    return { content: [{ type: "text", text: `Failed: ${msg}` }], details: { error: "missing_config" } };
}

export function errorResult(e: Error): AgentToolResult<any> {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], details: { error: true } };
}
