# ChatGPT Playwright Proxy

A local, single-user service that will expose a small HTTP API and CLI over a
persistent Playwright-controlled ChatGPT browser session.

The repository currently contains the Phase 1 and Phase 2 foundations:
validated TOML configuration, domain and API contracts, a browser-adapter
boundary, structured logging, CLI command parsing, versioned SQLite persistence,
durable scheduling, bounded cross-thread concurrency, same-thread serialization,
restart reconciliation, and idempotency handling. It does not open a browser or
contact ChatGPT.

## Development

Requirements:

- Node.js 22 or newer
- pnpm 11 or newer

Install and validate:

```bash
pnpm install
pnpm test:ci
pnpm build
```

Copy `config.example.toml` to `config.toml` before running future service or live
test phases. Local config, browser profile data, databases, and diagnostics are
ignored by Git.

## Test boundaries

`pnpm test` runs only unit, integration, and local browser-fixture suites. It
does not run tests under `tests/live`.

Live tests require all of the following:

```bash
CHATGPT_PROXY_LIVE_TESTS=1 \
CHATGPT_PROXY_CONFIG=/absolute/path/to/config.toml \
pnpm test:live
```

The configuration must also set `live_tests.enabled = true`. Destructive live
deletion additionally requires `CHATGPT_PROXY_LIVE_DELETE=1` and
`live_tests.allow_remote_deletion = true`.
