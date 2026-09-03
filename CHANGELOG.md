# Changelog

## 0.8.0

### Compatibility

- Targets xior `^0.8.4` and the xior 0.8 interceptor APIs.
- Returns an idempotent ejector that removes both the response interceptor and the request-queue interceptor.
- Builds CommonJS, ESM and TypeScript declaration outputs from the same strict TypeScript source.

### Refresh and retry reliability

- Shares one refresh operation across concurrent authentication failures and queues requests until it settles.
- Lets refresh requests reuse the intercepted instance when marked with `skipAuthRefresh`; a separate refresh instance
  remains optional.
- Places the refresh gate ahead of xior's FIFO request interceptors during setup so token and signing interceptors run
  once, after refreshed credentials are available.
- Preserves the original refresh rejection for every queued request and reliably clears failed refresh state,
  including synchronous throws and invalid non-Promise return values.
- Marks authentication retries so a second authentication failure is returned to the caller instead of starting a loop.
- Replays through a configured `retryInstance` without retaining the original instance's custom `fetch` function.
- Does not treat cancellation or timeout errors as network-authentication failures. Raw fetch errors without request
  configuration are returned unchanged because they cannot be replayed safely.
- Remains compatible with xior's `error-retry` plugin when authentication responses are excluded from that plugin;
  see [Retry plugin composition](README.md#composing-with-xiors-error-retry-plugin).

### Verification and tooling

- Adds deterministic coverage for successful refreshes, concurrency, queued requests, refresh failures and recovery,
  loop prevention, custom status handling, network failures, ejection, retry instances and retry-plugin composition.
- Enforces 100% statement, branch, function and line coverage in the test configuration.
- Runs type checking, tests, coverage, package builds, audit checks and package-content checks in CI on supported Node.js
  versions.
- Replaces the legacy webpack build with bunchee and modernises the TypeScript, Jest, Prettier and Husky toolchain.

### Upgrading from 0.6.x

1. Install xior 0.8 and this package's 0.8 release together:

    ```bash
    npm install xior@^0.8.4 xior-auth-refresh@^0.8.0
    ```

2. Treat the value returned by `createAuthRefreshInterceptor` as an ejector function. Call it to remove both installed
   interceptors.
3. If xior's `error-retry` plugin is enabled, exclude authentication statuses as shown in
   [Retry plugin composition](README.md#composing-with-xiors-error-retry-plugin), leaving authentication replay
   ownership with this package.
4. If a refresh request uses the intercepted instance, set `skipAuthRefresh: true` on that request. A separate refresh
   instance does not need this flag.
5. If `interceptNetworkError` is enabled for a custom transport, ensure rejected errors include the originating xior
   request configuration. A raw fetch `TypeError` has no safe replay target and is intentionally not intercepted.
