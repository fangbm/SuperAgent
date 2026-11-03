# Core-owned QQ composition — 2026-11-04

## Scope
Move QQ runtime, trusted source registry, secret configuration, and HTTP/timer lifecycle into `scripts/core-qq.mjs`. Keep `qq-common.mjs`, `qq-source.mjs`, and `qq-probe.mjs` as compatibility/CLI wrappers. Preserve existing flags, default behavior, health shape, logs, stop IPC, and source capabilities.

## Findings before implementation
- `qq-common.mjs` currently creates an independent `M1Runtime`, registers a source without policy, and hands QQSource a direct ingress host.
- `qq-source.mjs` owns webhook HTTP, health SQL, timer, and shutdown; `qq-webhook.mjs` now provides that transport lifecycle boundary.
- `qq-probe.mjs` and `qq-send-test.mjs` import `openQQ`/`configuredSecrets` from `qq-common.mjs`; those names must remain compatible.
- Root has added `openCoreStore` and configured secret helpers; QQ Core must configure exactly one public/standard source and expose source-scoped health only.

## Validation
Run the QQ CLI integration test and focused build/type checks; distinguish local HTTP fixture results from live platform acceptance.

## Validation/results
- `node --check` passed for `core-qq.mjs`, `qq-common.mjs`, `qq-source.mjs`, `qq-probe.mjs`, and `qq-webhook.mjs`.
- `node --test --test-force-exit tests/integration/qq-cli.test.mjs` passed all 3 tests with loopback permission. The first sandboxed run failed at the local HTTP fetch with `EACCES 127.0.0.1`; rerunning with the requested escalation passed.
- The CLI test used signed local QQ fixture events and verified persistence-before-reply, replay handling, and scoped health. No real QQ API or delivery acceptance was performed.
