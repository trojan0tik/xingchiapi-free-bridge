/**
 * xingchiapi-free-bridge
 * ---------------------------------------------------------------------------
 * Loopback header-injector proxy for OpenAI-compatible upstreams that gate
 * access by client identity (User-Agent).
 *
 * The problem this solves
 *   Some Chinese relay gateways (api.xingchiapi.com among them) only accept
 *   requests whose User-Agent belongs to a whitelisted "coding client"
 *   (Claude Code, OpenCode, Cursor, Codex, ...). Anything else is rejected
 *   with HTTP 403 {"error":{"code":"client_not_allowed"}} before the request
 *   ever reaches a model.
 *
 *   LLM routers (9Router and friends) call upstream through Node/undici,
 *   which sends `user-agent: undici` (or none). The result is a permanent,
 *   confusing 403 that looks like "invalid API key" in most dashboards.
 *   Most routers expose no per-provider header override, so the request
 *   identity has to be fixed in front of them.
 *
 * What this does
 *   Listens on loopback only, injects the configured identity headers, and
 *   pipes request/response bodies through byte-for-byte — streaming (SSE),
 *   tool calls, and large prompts all pass untouched. Zero dependencies.
 *
 * Requires Node.js >= 18.
 */

"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

// --------------------------------------------------------------------------
// Config: defaults <- config.json <- environment variables
// --------------------------------------------------------------------------
const DEFAULTS = {
  host: "127.0.0.1",
  port: 8792,
  upstream: "https://api.xingchiapi.com",
  userAgent: "claude-cli/2.1.92 (external, sdk-cli)",
  xApp: "cli",
  extraHeaders: {},
  timeoutMs: 600000,
  logRequests: true,
};

function readConfigFile() {
  const candidates = [
    process.env.CONFIG_FILE,
    path.join(__dirname, "config.json"),
    "/etc/xingchiapi-free-bridge/config.json",
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return { file, parsed };
      }
    } catch (err) {
      console.error(`[config] cannot read ${file}: ${err.message}`);
    }
  }
  return { file: null, parsed: {} };
}

function loadConfig() {
  const { file, parsed } = readConfigFile();
  const cfg = { ...DEFAULTS, ...parsed };

  const envMap = {
    BIND_HOST: "host",
    PORT: "port",
    UPSTREAM: "upstream",
    UA: "userAgent",
    XAPP: "xApp",
    UPSTREAM_TIMEOUT_MS: "timeoutMs",
  };
  for (const [envKey, cfgKey] of Object.entries(envMap)) {
    const raw = process.env[envKey];
    if (raw === undefined || raw === "") continue;
    cfg[cfgKey] = cfgKey === "port" || cfgKey === "timeoutMs" ? Number(raw) : raw;
  }
  if (process.env.LOG_REQUESTS === "0") cfg.logRequests = false;
  if (process.env.EXTRA_HEADERS) {
    try {
      const extra = JSON.parse(process.env.EXTRA_HEADERS);
      if (extra && typeof extra === "object" && !Array.isArray(extra)) {
        cfg.extraHeaders = { ...cfg.extraHeaders, ...extra };
      }
    } catch (err) {
      console.error(`[config] ignoring invalid EXTRA_HEADERS: ${err.message}`);
    }
  }
  cfg.source = file ? path.resolve(file) : "defaults+env";
  return cfg;
}

const CFG = loadConfig();

let upstreamUrl;
try {
  upstreamUrl = new URL(CFG.upstream);
  if (!/^https?:$/.test(upstreamUrl.protocol)) throw new Error("protocol must be http or https");
} catch (err) {
  console.error(`[config] invalid upstream "${CFG.upstream}": ${err.message}`);
  process.exit(1);
}

if (!Number.isFinite(CFG.port) || CFG.port <= 0) {
  console.error(`[config] invalid port "${CFG.port}"`);
  process.exit(1);
}
if (CFG.host !== "127.0.0.1" && CFG.host !== "::1" && CFG.host !== "localhost") {
  console.warn(`[warn] binding to ${CFG.host} exposes the injector beyond loopback`);
}

const isTls = upstreamUrl.protocol === "https:";
const agent = isTls
  ? new https.Agent({ keepAlive: true, maxSockets: 64 })
  : new http.Agent({ keepAlive: true, maxSockets: 64 });
const forward = isTls ? https.request : http.request;

// Hop-by-hop headers and identity headers we own ourselves.
const REQUEST_HEADERS_TO_DROP = new Set([
  "user-agent",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "accept-encoding",
  "upgrade",
]);

// Response framing headers Node recomputes for us.
const RESPONSE_HEADERS_TO_DROP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "upgrade",
]);

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function log(level, message) {
  console.log(`[${new Date().toISOString()}] ${level.padEnd(4)} ${message}`);
}

function buildForwardHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!REQUEST_HEADERS_TO_DROP.has(name.toLowerCase())) headers[name] = value;
  }
  headers["user-agent"] = CFG.userAgent;
  if (CFG.xApp) headers["x-app"] = CFG.xApp;
  for (const [name, value] of Object.entries(CFG.extraHeaders || {})) {
    if (value !== null && value !== undefined) headers[name.toLowerCase()] = String(value);
  }
  headers["host"] = upstreamUrl.host;
  // identity: keeps the body pipe byte-transparent (no gzip re-streaming)
  headers["accept-encoding"] = "identity";
  return headers;
}

function buildForwardPath(reqUrl) {
  const incoming = reqUrl || "/";
  // If the upstream URL carries a path prefix (e.g. https://host/v1), keep it.
  const prefix = upstreamUrl.pathname.replace(/\/+$/, "");
  if (!prefix) return incoming;

  const [rawPath, ...rest] = incoming.split("?");
  const query = rest.length ? `?${rest.join("?")}` : "";
  const p = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (p === prefix || p.startsWith(`${prefix}/`)) return `${p}${query}`;
  return `${prefix}${p}${query}`;
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

// --------------------------------------------------------------------------
// Server
// --------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // internal liveness probe — never hits the upstream, needs no auth
  if (req.url === "/__health" || req.url === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      upstream: CFG.upstream,
      userAgent: CFG.userAgent,
      xApp: CFG.xApp || null,
      extraHeaders: Object.keys(CFG.extraHeaders || {}),
      configSource: CFG.source,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
    });
    return;
  }

  const startedAt = Date.now();
  const forwardPath = buildForwardPath(req.url);
  const headers = buildForwardHeaders(req);

  let settled = false;
  const finishWithError = (status, message) => {
    if (settled) return;
    settled = true;
    sendJson(res, status, {
      error: { message, type: "xingchiapi_free_bridge_error" },
    });
    log("ERR", `${req.method} ${forwardPath} -> ${status} ${message}`);
  };

  const upstreamReq = forward(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isTls ? 443 : 80),
      method: req.method,
      path: forwardPath,
      headers,
      agent,
    },
    (upstreamRes) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!RESPONSE_HEADERS_TO_DROP.has(name.toLowerCase())) responseHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);

      upstreamRes.on("end", () => {
        settled = true;
        if (CFG.logRequests) {
          const ms = Date.now() - startedAt;
          const level = (upstreamRes.statusCode || 0) >= 400 ? "FAIL" : "OK";
          log(level, `${req.method} ${forwardPath} -> ${upstreamRes.statusCode} ${ms}ms`);
        }
      });
      upstreamRes.on("aborted", () => {
        settled = true;
        res.end();
      });
      upstreamRes.on("error", () => {
        settled = true;
        res.end();
      });
    }
  );

  const timer = setTimeout(() => {
    upstreamReq.destroy(new Error(`upstream timeout after ${CFG.timeoutMs}ms`));
  }, CFG.timeoutMs);
  timer.unref();

  upstreamReq.on("close", () => clearTimeout(timer));
  upstreamReq.on("error", (err) => {
    clearTimeout(timer);
    finishWithError(502, `upstream error: ${err.message}`);
  });

  // stream the request body straight through (large prompts, multipart, ...)
  req.pipe(upstreamReq);
  req.on("error", () => upstreamReq.destroy());
});

// streaming responses (SSE) must never be cut by per-request timeouts
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;

server.on("clientError", (err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(CFG.port, CFG.host, () => {
  log("BOOT", `listening on http://${CFG.host}:${CFG.port} -> ${CFG.upstream}`);
  log(
    "BOOT",
    `inject user-agent="${CFG.userAgent}"` +
      (CFG.xApp ? ` x-app="${CFG.xApp}"` : "") +
      (Object.keys(CFG.extraHeaders || {}).length
        ? ` extra=${JSON.stringify(CFG.extraHeaders)}`
        : "")
  );
  log("BOOT", `config source: ${CFG.source}`);
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("EXIT", `received ${signal}, draining`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
