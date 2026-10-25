#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadEnv, getCsvEnv } from './env.js';

loadEnv();

function usage() {
  console.log(`Usage:
  node tests/real-url-context.mjs [--help]

This script reads its configuration from .env / process.env.

Required env:
  PI_URL_CONTEXT_MODEL

Optional env:
  PI_BIN=pi
  PI_WEB_SEARCH_EXTENSION=./src/index.ts
  PI_PROVIDER_EXTENSIONS=/path/a.ts,/path/b.ts
  PI_URL_CONTEXT_PROMPT=...`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage();
  process.exit(0);
}

const model = process.env.PI_URL_CONTEXT_MODEL;
if (!model) {
  usage();
  throw new Error('Missing PI_URL_CONTEXT_MODEL in .env');
}

const piBin = process.env.PI_BIN || 'pi';
const prompt = process.env.PI_URL_CONTEXT_PROMPT || '请调用 url_context，总结这个 URL 的核心内容：https://developers.openai.com/api/docs/guides/tools-web-search，并列出来源。';
const pluginExtension = process.env.PI_WEB_SEARCH_EXTENSION || './src/index.ts';
const providerExtensions = getCsvEnv('PI_PROVIDER_EXTENSIONS');
const extensions = [...providerExtensions, pluginExtension];

const args = [
  '--no-session', '-ne', '-ns', '-np', '-nc', '--mode', 'json',
  ...extensions.flatMap((ext) => ['-e', ext]),
  '--model', model,
  '--tools', 'url_context',
  prompt,
];

const run = spawnSync(piBin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const output = `${run.stdout || ''}${run.stderr || ''}`;
const toolStarts = [];
const toolEnds = [];

for (const line of output.split('\n')) {
  if (!line.trim().startsWith('{')) continue;
  try {
    const event = JSON.parse(line);
    if (event.type === 'tool_execution_start' && event.toolName === 'url_context') toolStarts.push(event);
    if (event.type === 'tool_execution_end' && event.toolName === 'url_context') toolEnds.push(event);
  } catch {}
}

const latest = toolEnds.at(-1);
const details = latest?.result?.details || {};
const contentText = latest?.result?.content?.[0]?.text || '';
const unsupported = details.error === 'unsupported_provider';
const urls = [
  ...(details.sources || []).map((item) => item.url),
  ...(details.retrieved || []),
  ...(details.searchResults || []).map((item) => item.url),
  ...(details.citations || []).map((item) => item.url),
].filter(Boolean);
const uniqueUrls = [...new Set(urls)];
const verified = details.grounded === true || uniqueUrls.length > 0;
const warned = /No verified URL context metadata/i.test(contentText);

console.log(JSON.stringify({
  model,
  exitCode: run.status,
  toolStarted: toolStarts.length > 0,
  toolEnded: toolEnds.length > 0,
  providerKind: details.providerKind,
  unsupported,
  grounded: details.grounded,
  resultCount: details.resultCount,
  retrieved: details.retrieved || [],
  urls: uniqueUrls,
  warned,
}, null, 2));

assert.equal(toolStarts.length > 0, true, 'url_context tool was not called');
assert.equal(toolEnds.length > 0, true, 'url_context tool did not finish');
assert.equal(unsupported, false, 'url_context unexpectedly reported unsupported_provider');
assert.equal(verified || warned, true, 'url_context returned neither verified metadata nor an explicit warning');
