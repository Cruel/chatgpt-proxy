# Live ChatGPT tests

Tests in this directory are never included by `pnpm test` or `pnpm test:ci`.
They run serially and only after `scripts/run-live-tests.ts` validates the
environment and the separate live-test configuration gates.

The standard live suite creates one uniquely named conversation in the
configured test project and sends one follow-up. It does not delete the remote
conversation. If the persistent profile is logged out or requires verification,
the headed Chromium window remains open for manual interaction and the suite
waits up to ten minutes for the browser to become ready.

The destructive deletion test has three independent gates and only deletes a
conversation created inside the same test process:

```bash
CHATGPT_PROXY_LIVE_TESTS=1 \
CHATGPT_PROXY_LIVE_DELETE=1 \
CHATGPT_PROXY_CONFIG=/absolute/path/to/config.toml \
pnpm test:live:delete
```

The selected config must also set both `chatgpt.delete_remote_thread = true`
and `live_tests.allow_remote_deletion = true`. Production deletion enablement
alone never enables the destructive test. If deletion becomes ambiguous, the
test does not click Delete a second time; the test-created conversation may
remain for manual cleanup.
