# Operations guide

This service stores durable queue state in SQLite and treats the persistent
browser profile as an account credential. Operate both as private local data.

## Startup diagnostics

Both server entrypoints run operational diagnostics before reporting that the
listener is ready. The same checks are available through:

```bash
pnpm cli doctor
```

The doctor report covers:

- SQLite `quick_check` integrity;
- database file permissions;
- browser-profile and diagnostic-artifact directory access and permissions;
- current ChatGPT authentication or verification state;
- durable queue state and queued/active counts;
- API authentication mode and placeholder tokens;
- whether remote deletion is enabled.

Warnings do not prevent the local HTTP service from starting because login and
verification can be resolved interactively. Errors should be investigated before
submitting new work.

## Local API authentication

Bearer authentication is enabled by default:

```toml
[server]
require_api_token = true
api_token = "use-a-long-random-value"
```

For a strictly local single-user setup, it may be disabled explicitly:

```toml
[server]
listen_host = "127.0.0.1"
require_api_token = false
api_token = ""
```

In tokenless mode, `CHATGPT_PROXY_TOKEN` and `--api-token` are unnecessary. The
service remains restricted to loopback listeners, but any local process or web
page capable of reaching the loopback port can invoke the API. Keep remote
deletion disabled unless it is actively needed. `doctor` reports tokenless mode
as a warning so unattended deployments do not enable it accidentally.

For a long-running service manager, build first and execute Node directly so the
service process receives signals without an additional package-runner layer:

```bash
pnpm build
CHATGPT_PROXY_CONFIG=/absolute/path/to/config.toml \
  node dist/playwright-server-main.js
```

Use an equivalent direct `node` command in systemd, supervisord, or another
process manager.

## Login expiration and browser verification

When the browser detects an expired login or interactive verification:

1. New durable runs remain queued.
2. The scheduler stops assigning work to browser pages.
3. The headed browser remains available for manual interaction.
4. Existing ambiguous submissions are inspected rather than resent.
5. Dispatch resumes only after the authenticated ChatGPT UI is recognized.

Check state with:

```bash
pnpm cli browser-status
pnpm cli doctor
```

Complete login or verification in the dedicated browser profile. Do not open a
second browser process against the same profile directory and do not point the
service at a normal Windows Chrome profile.

## Graceful shutdown and durable queue policy

The first `SIGINT` or `SIGTERM` starts graceful shutdown:

1. Fastify stops accepting new HTTP work.
2. Existing HTTP requests are allowed to complete.
3. Active browser operations finish.
4. The scheduler stops dispatching further work.
5. Undispatched runs remain `queued` in SQLite.
6. Browser context, SQLite, and other resources close cleanly.

On the next startup, durable queued runs are reconciled and dispatched when the
browser is ready. A second signal forces process exit and may leave an active run
for restart reconciliation, so use it only when normal shutdown is stuck.

## SQLite backup

Preferred online backup while the service is running:

```bash
mkdir -p /secure/backup
chmod 700 /secure/backup
sqlite3 /path/to/state.sqlite3 ".backup '/secure/backup/state-$(date +%Y%m%d-%H%M%S).sqlite3'"
chmod 600 /secure/backup/state-*.sqlite3
```

For a filesystem copy, stop the service cleanly first. Copy the main database
and any existing `-wal` and `-shm` sidecars as one backup set:

```bash
cp --preserve=mode,timestamps /path/to/state.sqlite3* /secure/backup/
```

Do not copy only the main database while the service is writing in WAL mode.
After restore, ensure the service user owns the files, set the database to mode
`0600`, start the service, and run `cgpt doctor`.

## Browser-profile backup

The profile contains cookies and authenticated browser storage. Treat a backup
as a live account credential.

1. Stop the service and close every browser using the profile.
2. Archive the entire profile directory, not selected files.
3. Encrypt the archive at rest.
4. Restrict the archive and restored directory to the service user.

Example:

```bash
profile_dir=/path/to/.playwright-profile
tar --create --zstd --file /secure/backup/chatgpt-profile.tar.zst \
  --directory "$(dirname "$profile_dir")" "$(basename "$profile_dir")"
chmod 600 /secure/backup/chatgpt-profile.tar.zst
```

After restoration, set the profile directory to mode `0700`, launch
`pnpm auth` if authentication must be renewed, then run the
doctor command.

## Selector or unexpected-UI failures

`ui_changed`, unexpected dialogs, and unclassified pages should produce
diagnostic artifacts according to configuration. Inspect:

- the run's error code and phase;
- screenshot and HTML artifacts;
- bounded DOM/selector metadata;
- console and failed-request summaries;
- trace ZIP when enabled.

Do not blindly retry a prompt after a submission-ambiguous failure. Preserve the
artifacts, import a sanitized fixture, add a regression test, and only then
update centralized selectors or detectors:

```bash
pnpm fixture:import -- \
  --artifact .artifacts/<run>/<capture>.html \
  --name descriptive-regression-name
```

Review every generated fixture before committing it. Never commit browser
profile data, account identifiers, tokens, or unsanitized private content.

## Test boundaries

`pnpm test`, `pnpm test:ci`, and browser-fixture tests do not contact ChatGPT.
Real-account suites require explicit environment gates and a live-test project.
Remote deletion requires the additional destructive environment variable and
both configuration permissions. The guided release procedure is documented in
`MANUAL_ACCEPTANCE.md`.
