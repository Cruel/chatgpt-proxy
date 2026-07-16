# ChatGPT Playwright Proxy

A local, single-user service that will expose a small HTTP API and CLI over a
persistent Playwright-controlled ChatGPT browser session.

The repository currently contains the Phase 1 through Phase 5 foundations:
validated TOML configuration, domain contracts, versioned SQLite persistence,
durable scheduling, bounded cross-thread concurrency, same-thread serialization,
restart reconciliation, bearer-authenticated Fastify endpoints, a complete HTTP
CLI, conservative deletion behavior, a deterministic fake browser adapter, a
persistent Playwright Chromium lifecycle with login-state gating, bounded tab
leasing, profile reuse, and automatic browser recovery, plus real project
navigation, conversation creation and continuation, submission confirmation,
tool-progress filtering, and final-response extraction. Remote conversation
deletion remains deferred to Phase 7.

## Development

Requirements:

- Node.js 22 or newer
- pnpm 11 or newer

Install and validate:

```bash
pnpm install
pnpm browser:install
pnpm test:ci
pnpm build
```

Authenticate the dedicated profile once in a normal browser session that is
not controlled by Playwright:

```bash
pnpm browser:profile-login
```

Complete Google and ChatGPT login, verify the configured project opens, then
close every browser window completely before starting the proxy or live tests.
The command uses Playwright's installed Chromium when `browser.channel` is
`chromium`, which is the default. Set the channel to `chrome` and run
`pnpm browser:install:chrome` only when branded Google Chrome is preferred. Do
not attempt Google login while the browser is under Playwright control.

On a new Debian/Ubuntu/WSL environment, install Chromium and its operating
system dependencies with:

```bash
pnpm browser:install:with-deps
```

The service uses Playwright-managed Linux Chromium and a dedicated persistent
profile on the Linux/WSL filesystem. Do not point `profile_dir` at a Windows
Chrome profile or a path under `/mnt/<drive>`.

`BrowserManager` keeps one control tab available for login and verification and
leases a separate bounded set of tabs to active operations. When login expires,
its operation gate pauses the durable queue while the headed control tab remains
available for manual login. Status polling resumes queued work only after the
profile is verified as ready again.

Copy `config.example.toml` to `config.toml`. Local config, browser profile data,
databases, and diagnostics are ignored by Git.

Run the Phase 3 service with the fake adapter:

```bash
pnpm server:fake
```

Run the real persistent-browser service with:

```bash
pnpm server:playwright
```

The first run opens headed Playwright Chromium using `profile_dir`. Complete
ChatGPT login or browser verification in that window. The HTTP server remains
available while queued mutations stay paused until the configured project page
is recognized as authenticated.

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

The configuration must also set `live_tests.enabled = true` and provide a direct
`live_tests.project_url`. The standard live suite creates one uniquely marked
conversation and sends one follow-up; it does not delete that conversation.
Destructive live deletion additionally requires `CHATGPT_PROXY_LIVE_DELETE=1`
and `live_tests.allow_remote_deletion = true`.
