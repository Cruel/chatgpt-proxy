# Manual live acceptance

Use this workflow for release acceptance or after substantial ChatGPT selector
changes. It is not a continuously run test suite.

## Effects

The workflow:

1. starts the persistent browser and verifies login/project readiness;
2. runs the operational doctor checks;
3. creates a uniquely marked conversation;
4. sends a follow-up in that conversation;
5. creates and chats with two additional conversations concurrently;
6. tombstones the primary local mapping and verifies the remote conversation
   still exists;
7. optionally creates and remotely deletes a separate disposable conversation;
8. prints the retained remote URLs and diagnostic artifact directory.

The primary and parallel conversations are intentionally retained for visual
review. Remove them manually after inspection. The optional destructive scenario
never acts on those retained conversations.

## Run

Ensure the dedicated profile is closed in all other browser processes, then run:

```bash
CHATGPT_PROXY_LIVE_TESTS=1 \
CHATGPT_PROXY_CONFIG=/absolute/path/to/config.toml \
pnpm acceptance:live
```

The script pauses before creating remote conversations. If login or Cloudflare
verification is required, complete it in the headed browser; execution resumes
after readiness is verified.

For controlled non-interactive execution, add:

```bash
CHATGPT_PROXY_ACCEPTANCE_YES=1
```

That flag does not enable remote deletion.

## Optional remote-deletion scenario

The operator must choose the optional scenario interactively or set:

```bash
CHATGPT_PROXY_ACCEPTANCE_REMOTE_DELETE=1
CHATGPT_PROXY_LIVE_DELETE=1
```

The selected configuration must also contain:

```toml
[chatgpt]
delete_remote_thread = true

[live_tests]
enabled = true
allow_remote_deletion = true
```

The script creates a new disposable conversation and deletes only that exact
mapping. Missing any gate causes the destructive step to fail closed.

## Review

After completion:

- open every printed retained URL and verify the expected messages;
- verify the locally deleted primary conversation still exists remotely;
- inspect the printed diagnostic artifact directory;
- run `cgpt doctor` against the long-running service configuration;
- remove retained test conversations when review is complete.

Record any unexpected UI state before retrying. Preserve artifacts and convert
the failure to a sanitized browser fixture as described in `OPERATIONS.md`.
