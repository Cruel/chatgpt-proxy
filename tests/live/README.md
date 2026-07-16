# Live ChatGPT tests

Tests in this directory are never included by `pnpm test` or `pnpm test:ci`.
They run serially and only after `scripts/run-live-tests.ts` validates the
environment and the separate live-test configuration gates.
