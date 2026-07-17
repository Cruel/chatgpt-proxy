# ChatGPT Playwright Proxy

A local, single-user service that will expose a small HTTP API and CLI over a
persistent Playwright-controlled ChatGPT browser session.

The repository currently contains the Phase 1 through Phase 8 implementation:
validated TOML configuration, domain contracts, versioned SQLite persistence,
durable scheduling, bounded cross-thread concurrency, same-thread serialization,
restart reconciliation, bearer-authenticated Fastify endpoints, a complete HTTP
CLI, conservative deletion behavior, a deterministic fake browser adapter, a
persistent Playwright Chromium lifecycle with login-state gating, bounded tab
leasing, profile reuse, and automatic browser recovery, plus real project
navigation, conversation creation and continuation, submission confirmation,
tool-progress filtering, final-response extraction, selector and error
registries, non-duplicating submission/response recovery, persisted diagnostic
artifacts, retention pruning, a sanitized fixture-corpus workflow, and
conservative real ChatGPT conversation deletion with confirmation validation,
absence verification, ambiguity preservation, atomic local tombstoning,
operational diagnostics, graceful signal handling, explicit queue-draining
behavior, and a guided release-acceptance workflow.

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
pnpm auth
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
pnpm server
```

The first run opens headed Playwright Chromium using `profile_dir`. Complete
ChatGPT login or browser verification in that window. The HTTP server remains
available while queued mutations stay paused until the configured project page
is recognized as authenticated.

## Diagnostics and recovery

Unexpected browser failures can capture a full-page PNG, HTML snapshot,
bounded JSON DOM/selector metadata, console and failed-request summaries, and a
Playwright trace ZIP according to `[diagnostics]` in `config.toml`. Files are
written under `artifact_dir` with mode `0600`; their SHA-256 hashes and paths are
recorded in SQLite. Artifacts older than `retain_days` are pruned at startup.

Ambiguous submissions are never retried by sending the prompt again. Recovery
reopens the known conversation and proceeds only when the latest remote user
turn exactly matches the requested message. The same inspection path recovers a
completed response after the original page or response wait was interrupted.

Convert a captured HTML artifact into a reviewed regression fixture with:

```bash
pnpm fixture:import -- \
  --artifact .artifacts/<run>/<capture>.html \
  --name descriptive-regression-name
```

The importer strips scripts and common account, token, path, project,
conversation, and URL-query identifiers. Review the generated file under
`tests/fixtures/chatgpt/` before committing it.

By default, pass the configured token to the CLI:

```bash
export CHATGPT_PROXY_TOKEN=replace-me

pnpm cli health
pnpm cli doctor
pnpm cli threads
pnpm cli new example --message "Review this design."
pnpm cli chat example --message "Now focus on failure handling."
pnpm cli chat example --message "Analyze this carefully." --thinking high
pnpm cli info example
pnpm cli delete example
```

By default, an exact repeat of the most recently submitted message in a thread
returns the existing durable run instead of creating another submission. This
protects callers that retry after a timeout or lost connection. Set
`chatgpt.deduplicate_last_message = false` to permit consecutive identical
messages intentionally.

`new` and `chat` submit the durable run without holding one long HTTP request
open, then poll the returned run ID internally until it completes. They still
wait and print the final response by default. Pass `--no-wait` to return
immediately with the run ID, and use `pnpm cli run <run-id> --wait` to reattach.

For a strictly local tokenless setup, disable authentication explicitly:

```toml
[server]
listen_host = "127.0.0.1"
require_api_token = false
api_token = ""
```

The CLI then works without `CHATGPT_PROXY_TOKEN`. Token authentication remains
enabled by default, and an empty token is rejected unless
`require_api_token = false`. The listener is restricted to loopback addresses in
either mode.

`cgpt delete <name>` only tombstones local state. Remote deletion additionally
requires `--remote`, server-side permission, and interactive confirmation or
`--yes`. The browser adapter activates Delete only after it verifies the loaded
conversation ID, the action menu, and a recognizable deletion confirmation. It
then verifies remote absence; an inconclusive result preserves the local mapping
in `needs_attention` rather than clicking Delete again.

`cgpt doctor` reports SQLite integrity, filesystem permissions, browser/login
state, queue state, authentication mode, placeholder credentials, and
deletion-policy warnings. It prints remediation guidance for every non-healthy
check.

## Shutdown and recovery

`SIGINT` and `SIGTERM` initiate graceful shutdown. The server stops HTTP intake,
allows already active work to finish, closes the browser cleanly, and leaves
undispatched durable runs queued in SQLite for the next startup. A second signal
forces process termination and should be reserved for a genuinely stuck
shutdown.

When ChatGPT login expires or browser verification is required, queue dispatch
pauses without resubmitting prompts. Complete the interaction in the headed
browser and run `pnpm cli doctor` or `pnpm cli browser-status` to verify recovery.

Operational backup, restore, selector-failure, and long-running service guidance
is documented in `docs/OPERATIONS.md`.

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
plus both `chatgpt.delete_remote_thread = true` and
`live_tests.allow_remote_deletion = true`:

```bash
CHATGPT_PROXY_LIVE_TESTS=1 \
CHATGPT_PROXY_LIVE_DELETE=1 \
CHATGPT_PROXY_CONFIG=/absolute/path/to/config.toml \
pnpm test:live:delete
```

That suite creates a uniquely marked conversation and deletes only the exact
conversation reference returned by its own create operation.

The guided manual acceptance workflow is separate from the normal live suite:

```bash
CHATGPT_PROXY_LIVE_TESTS=1 \
CHATGPT_PROXY_CONFIG=/absolute/path/to/config.toml \
pnpm acceptance:live
```

It exercises browser/project readiness, create, follow-up chat, parallel work,
local-only deletion, optional separately gated remote deletion, and artifact
inspection. See `docs/MANUAL_ACCEPTANCE.md` before running it.
