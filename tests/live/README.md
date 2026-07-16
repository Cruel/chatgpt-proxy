# Live ChatGPT tests

Tests in this directory are never included by `pnpm test` or `pnpm test:ci`.
They run serially and only after `scripts/run-live-tests.ts` validates the
environment and the separate live-test configuration gates.

The standard live suite creates one uniquely named conversation in the
configured test project and sends one follow-up. It does not delete the remote
conversation. If the persistent profile is logged out or requires verification,
the headed Chromium window remains open for manual interaction and the suite
waits up to ten minutes for the browser to become ready.
