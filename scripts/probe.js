#!/usr/bin/env node
/**
 * probe.js — diagnose a client-gated OpenAI-compatible upstream.
 *
 * Sends the same chat request with a matrix of User-Agent values so you can
 * see exactly which identity the upstream accepts. No dependencies.
 *
 * Usage:
 *   node scripts/probe.js --key sk-xxx [--base https://api.xingchiapi.com] \
 *                         [--model gpt-6.1-sol] [--proxy http://127.0.0.1:8792]
 *
 * When --proxy is given the requests are routed through the bridge (proving
 * the injector works); otherwise they go straight to the upstream.
 */
"use strict";

const { URL } = require("node:url");

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const KEY = arg("key", process.env.XINGCHI_KEY || "");
const BASE = arg("base", process.env.XINGCHI_BASE || "https://api.xingchiapi.com");
const MODEL = arg("model", process.env.XINGCHI_MODEL || "gpt-6.1-sol");
const PROXY = arg("proxy", process.env.XINGCHI_PROXY || "");
const TIMEOUT_MS = Number(arg("timeout", "45000"));

if (!KEY) {
  console.error("error: --key (or XINGCHI_KEY) is required");
  process.exit(2);
}

const ENDPOINT = `${(PROXY || BASE).replace(/\/+$/, "")}/chat/completions`;

const CANDIDATES = [
  { label: "no-ua (undici-like)", ua: null, xApp: null },
  { label: "node", ua: "node", xApp: null },
  { label: "curl/8.5.0", ua: "curl/8.5.0", xApp: null },
  { label: "9router/0.5.119", ua: "9router/0.5.119", xApp: null },
  { label: "codex_cli_rs/0.48.0", ua: "codex_cli_rs/0.48.0 (Linux 6.12; x86_64)", xApp: null },
  { label: "claude-cli/2.1.92", ua: "claude-cli/2.1.92 (external, sdk-cli)", xApp: "cli" },
  { label: "opencode/0.15.0", ua: "opencode/0.15.0", xApp: null },
  { label: "hermes-agent/1.0", ua: "hermes-agent/1.0", xApp: null },
  { label: "Cursor/1.0", ua: "Cursor/1.0", xApp: null },
];

async function probe({ ua, xApp }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${KEY}`,
  };
  if (ua) headers["user-agent"] = ua;
  if (xApp) headers["x-app"] = xApp;

  const startedAt = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "reply with the single word: ok" }],
        max_tokens: 8,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    let code = "";
    try {
      const parsed = JSON.parse(text);
      code = parsed?.error?.code || parsed?.error?.type || "";
    } catch {
      /* non-JSON body */
    }
    return {
      status: res.status,
      ms: Date.now() - startedAt,
      code,
      snippet: text.slice(0, 90).replace(/\s+/g, " "),
    };
  } catch (err) {
    return {
      status: 0,
      ms: Date.now() - startedAt,
      code: "ERR",
      snippet: err.name === "AbortError" ? `timeout ${TIMEOUT_MS}ms` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const parsed = new URL(ENDPOINT);
  console.log(`endpoint : ${ENDPOINT}`);
  console.log(`model    : ${MODEL}`);
  console.log(`via proxy: ${PROXY || "(direct)"}`);
  console.log("");
  console.log("user-agent                          status   latency  note");
  console.log("-".repeat(78));

  const accepted = [];
  for (const candidate of CANDIDATES) {
    const result = await probe(candidate);
    const ok = result.status === 200;
    if (ok) accepted.push(candidate.label);
    const line = `${candidate.label.padEnd(34)} ${String(result.status).padEnd(7)} ${String(
      result.ms + "ms"
    ).padEnd(8)} ${ok ? "accepted" : result.code || result.snippet}`;
    console.log(line);
  }

  console.log("-".repeat(78));
  if (accepted.length) {
    console.log(`accepted identities: ${accepted.join(", ")}`);
    console.log("=> set UA in config.json to one of the accepted values above.");
  } else {
    console.log("no identity accepted — the gate is not (only) User-Agent based.");
  }
  process.exit(accepted.length ? 0 : 1);
})();
