# xingchiapi-free-bridge

A tiny loopback proxy that fixes **`403 client_not_allowed`** from client-gated
OpenAI-compatible LLM upstreams, so routers like [9Router](https://github.com/decolua/9router)
can finally use them.

Zero dependencies. One file. ~300 lines of Node.js.

```
Without bridge:   router (undici UA) ──────────────► upstream → 403 client_not_allowed
With bridge:      router (undici UA) ─► bridge (injects UA) ─► upstream → 200
```

---

## The problem

Some relay/gateway providers only accept traffic from a whitelist of *coding
clients*. `api.xingchiapi.com` is one of them — it returns:

```json
HTTP 403
{"error":{"code":"client_not_allowed",
          "message":"本站仅支持编程客户端使用：Codex、Claude Code、OpenCode、ZCode、
                     DeepSeek Harness、Hermes Agent、Minis、WorkBuddy、Cursor、pi/omp、
                     Qoder、Kilo、Cline、Roo、Trae、GitHub Copilot、Grok CLI。
                     脚本、SDK 直连和第三方聊天客户端暂不支持"}}
```

> "This site only supports programming clients … script / raw SDK / third-party
> chat clients are not supported."

The gate is the **`User-Agent`** header. LLM routers call upstream with
Node's `fetch` (undici), which sends `user-agent: node` (or nothing), so every
request is rejected *before it ever reaches a model*.

What makes this nasty in practice:

* The router dashboard reports it as `Invalid API key or base URL` or
  `all accounts locked` — nothing like "your User-Agent is blocked".
* Retry logic burns the account pool (in our case 3 accounts got locked in a
  row, each with a 1–2 minute cooldown).
* Most routers expose **no per-provider header override**. In 9Router,
  `open-sse/executors/default.js` builds upstream headers purely from the
  static provider registry or `runtimeTransport`:

  ```js
  buildHeaders(credentials, stream) {
    const headers = { "Content-Type": "application/json",
                      ...(rt ? rt.headers : this.config.headers) };
    ...
  ```

  `providerSpecificData` is never consulted for headers, and the
  *Add/Edit Compatible Node* dialog has no "Extra Headers" field (checked on
  9Router 0.5.116 and 0.5.119).

So the identity has to be fixed **in front of** the router → this bridge.

## Measured behaviour

Same API key, same request body, only `User-Agent` changed — reproduced with
`scripts/probe.js` against `https://api.xingchiapi.com`:

| User-Agent                          | HTTP | Error code           |
| ----------------------------------- | ---- | -------------------- |
| *(none / undici default)*           | 403  | `client_not_allowed` |
| `node`                              | 403  | `client_not_allowed` |
| `curl/8.5.0`                        | 403  | `client_not_allowed` |
| `9router/0.5.119`                   | 403  | `client_not_allowed` |
| `codex_cli_rs/0.48.0`               | 403  | `client_not_allowed` |
| `claude-cli/2.1.92 (external, sdk-cli)` | **200** | —                |
| `opencode/0.15.0`                   | **200** | —                   |
| `hermes-agent/1.0`                  | **200** | —                   |
| `Cursor/1.0`                        | **200** | —                   |

Note the trap: `codex_cli_rs` is named in the whitelist *text* but is still
rejected, so do not assume the message is a literal spec. Probe, don't guess.

Through the bridge, all of the above return 200 — including the undici default,
because the bridge overwrites the header.

## How it works

```
router ──POST /chat/completions──► 127.0.0.1:8792 ──► api.xingchiapi.com
        (any UA)                    │
                                    ├─ drop: user-agent, host, content-length,
                                    │        connection, transfer-encoding, …
                                    ├─ inject: user-agent: claude-cli/2.1.92
                                    │          x-app: cli
                                    └─ pipe body byte-for-byte (SSE safe)
```

Design points that matter in production:

* **Loopback only** by default (`127.0.0.1`). Binding to `0.0.0.0` invites IP
  blocks — you are proxying an identity assertion, keep it local.
* **`accept-encoding: identity`** on the upstream leg, and transport headers
  (`content-encoding`, `content-length`, `transfer-encoding`) stripped from the
  response, so the pipe stays byte-transparent. No gzip re-encoding bugs, no
  truncation, no buffering of streamed tokens.
* **No request/response timeouts** (`requestTimeout = 0`) — LLM SSE streams can
  idle for minutes between chunks. There is a separate hard cap
  (`timeoutMs`, default 10 min) applied to the upstream socket only.
* **`/__health`** endpoint answers locally without touching the upstream, so
  watchdogs can probe it cheaply.
* **Keep-alive pooling** (64 sockets) so the extra hop costs ~1 ms, not a new
  TLS handshake per request.
* **Configurable identity** via `config.json` or env — swap `UA` when the
  upstream changes its allowlist.

## Install

Requirements: Linux with systemd, Node.js ≥ 18. No npm dependencies.

```bash
git clone https://github.com/<your-user>/xingchiapi-free-bridge.git
cd xingchiapi-free-bridge
sudo ./scripts/install.sh
```

Defaults: user = `$SUDO_USER`, port `8792`, upstream `https://api.xingchiapi.com`,
identity `claude-cli/2.1.92 (external, sdk-cli)`.

Override anything:

```bash
sudo PORT=8793 UA='opencode/0.15.0' XAPP='' ./scripts/install.sh
```

Verify:

```bash
curl -s http://127.0.0.1:8792/__health
# {"ok":true,"upstream":"https://api.xingchiapi.com","userAgent":"claude-cli/…", …}
```

## Wire it into 9Router

9Router reads `providerConnections` live, so this needs no restart.

```bash
# all connections of one provider + its providerNode
./scripts/9router-fix.sh openai-compatible-chat-5ddf6535-f293-47e9-8e90-679a6b06ff76
```

The script backs up the DB first, rewrites
`data.providerSpecificData.baseUrl` → `http://127.0.0.1:8792`, and clears
`errorCode` / `lastError` / `rateLimitedUntil` / `modelLock_*` left over from the
old 403s.

Or set it by hand in the dashboard — paste `http://127.0.0.1:8792` as the
**Base URL** of the provider (the router appends `/chat/completions` itself),
then hit *Test*.

Other routers: point any OpenAI-compatible base URL at the bridge. Paths
(`/chat/completions`, `/models`, `/responses`, …) are forwarded unchanged.

## Usage

```bash
# run directly (no systemd)
PORT=8792 node proxy.js

# probe which identities an upstream accepts
node scripts/probe.js --key sk-… --model gpt-6.1-sol

# probe THROUGH the bridge and confirm the injector works
node scripts/probe.js --key sk-… --proxy http://127.0.0.1:8792
```

### Config

Resolution order: built-in defaults → `config.json` (in the app dir, or
`/etc/xingchiapi-free-bridge/config.json`, or `$CONFIG_FILE`) → environment.

| Key            | Env                  | Default                              | Notes                                        |
| -------------- | -------------------- | ------------------------------------ | -------------------------------------------- |
| `host`         | `BIND_HOST`          | `127.0.0.1`                          | keep loopback                                |
| `port`         | `PORT`               | `8792`                               |                                              |
| `upstream`     | `UPSTREAM`           | `https://api.xingchiapi.com`         | path prefix in the URL is preserved          |
| `userAgent`    | `UA`                 | `claude-cli/2.1.92 (external, sdk-cli)` | the actual fix                            |
| `xApp`         | `XAPP`               | `cli`                                | set empty to omit                            |
| `extraHeaders` | `EXTRA_HEADERS` (JSON) | `{}`                               | e.g. `{"originator":"codex_cli_rs"}`         |
| `timeoutMs`    | `UPSTREAM_TIMEOUT_MS`| `600000`                             | upstream socket cap, not a stream idle limit |
| `logRequests`  | `LOG_REQUESTS=0`     | `true`                               |                                              |

## Verify the deployment

```bash
KEY=sk-…

# non-stream
curl -s http://127.0.0.1:8792/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"say ok"}],"max_tokens":8}'

# streaming (must arrive incrementally, not all at once)
curl -sN http://127.0.0.1:8792/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"count 1 to 5"}],"stream":true}'

# tool calling
curl -s http://127.0.0.1:8792/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"weather in Bali?"}],
       "tools":[{"type":"function","function":{"name":"get_weather","description":"weather",
       "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}'
```

Confirmed working: single-shot completions, incremental SSE, tool calls,
`/models` listing — via the bridge directly and through 9Router on both
`:20128` (native) and `:20130` (go) sharing one DB.

## Operational notes

* **Do not** point the router back at `https://api.xingchiapi.com` — that is the
  403 path.
* **Do not** bind the bridge to a public interface. The upstream may treat
  spoofed identities from a single host at volume as abuse.
* Identity headers rotate on upstream policy changes. When 403s return, run
  `scripts/probe.js` and update `UA` / `XAPP` — no code change needed.
* Port collisions are the usual install failure: pick a free loopback port
  (`ss -ltn | grep <port>`) rather than relying on the default.
* If the upstream ever gates on something TLS-fingerprint-shaped rather than a
  header, this bridge will not help; the probe matrix will show *no* accepted
  identity, which is the signal to stop.

## Disclaimer

This is a header-rewriting proxy. It does not create accounts, bypass quotas,
or obtain entitlements you do not have. Whether asserting a client identity
complies with a provider's terms is between you and that provider — the
whitelist in the upstream's own error message is reproduced here purely as
diagnostic evidence. Use at your own risk.

## License

MIT
