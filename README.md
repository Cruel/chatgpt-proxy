# ChatGPT Playwright Proxy

A local, single-user service that will expose a small HTTP API and CLI over a
persistent Playwright-controlled ChatGPT browser session.

The repository currently contains the Phase 1 through Phase 3 foundations:
validated TOML configuration, domain contracts, versioned SQLite persistence,
durable scheduling, bounded cross-thread concurrency, same-thread serialization,
restart reconciliation, bearer-authenticated Fastify endpoints, a complete HTTP
CLI, conservative deletion behavior, and a deterministic fake browser adapter.
The fake server does not open a browser or contact ChatGPT.

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

Copy `config.example.toml` to `config.toml`. Local config, browser profile data,
databases, and diagnostics are ignored by Git.

Run the Phase 3 service with the fake adapter:

```bash
pnpm server:fake
```

In another terminal, pass the configured token to the CLI:

```bash
export CHATGPT_PROXY_TOKEN=replace-me

pnpm cli health
pnpm cli threads
pnpm cli new example --message "Review this design."
pnpm cli chat example --message "Now focus on failure handling."
pnpm cli info example
pnpm cli delete example
```

`cgpt delete <name>` only tombstones local state. Remote deletion additionally
requires `--remote`, server-side permission, and interactive confirmation or
`--yes`. In Phase 3 the fake adapter exercises this policy without contacting
ChatGPT.

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
