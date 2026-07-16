# ChatGPT DOM fixture corpus

This directory contains sanitized HTML snapshots derived from diagnostic
artifacts. Never copy a live artifact into the repository directly.

Import a captured HTML artifact with:

```bash
pnpm fixture:import -- \
  --artifact .artifacts/<run>/<capture>.html \
  --name descriptive-regression-name
```

The importer removes scripts and common account, path, token, conversation,
project, and URL-query identifiers. Review the generated file manually before
committing it. Add a browser-fixture regression test that reproduces the
failure, then update selectors or detector rules only after the test fails for
the original reason.

Use `--force` only when intentionally replacing an existing reviewed fixture.
