![Package version](https://img.shields.io/npm/v/xior-auth-refresh?label=version)
![Package size](https://img.shields.io/bundlephobia/min/xior-auth-refresh)
![Package downloads](https://img.shields.io/npm/dm/xior-auth-refresh)
![Package types definitions](https://img.shields.io/npm/types/xior-auth-refresh)

# xior-auth-refresh

This library is a fork of the brilliant [axios-auth-refresh](https://github.com/Flyrell/axios-auth-refresh) library by Dawid Zbiński.

Library that helps you implement automatic refresh of authorization
via xior [interceptors](https://github.com/suhaotian/xior?tab=readme-ov-file#using-interceptors).
You can easily intercept the original request when it fails, refresh the authorization and continue with the original request,
without any user interaction.

What happens when the request fails due to authorization is all up to you.
You can either run a refresh call for a new authorization token or run a custom logic.

The plugin stalls additional requests that have come in while waiting for a new authorization token
and resolves them when a new token is available.

Version 0.8.x of this package targets xior 0.8.4 and later within the xior 0.8 release line.
See the [changelog](CHANGELOG.md#080) for compatibility notes and guidance when upgrading from 0.6.x.

## Installation

Using [npm](https://www.npmjs.com/get-npm) or [yarn](https://yarnpkg.com/en/docs/install):

```bash
npm install xior-auth-refresh --save
# or
yarn add xior-auth-refresh
```

## Syntax

```typescript
createAuthRefreshInterceptor(
    xior: XiorInstance,
    refreshAuthLogic: (failedRequest: any) => Promise<any>,
    options: XiorAuthRefreshOptions = {}
): XiorAuthRefreshEjector;
```

#### Parameters

- `xior` - an instance of Xior
- `refreshAuthLogic` - a Function used for refreshing authorization (**must return a promise**).
  Accepts exactly one parameter, which is the `failedRequest` returned by the original call.
- `options` - object with settings for interceptor (See [available options](#available-options))

#### Returns

An idempotent function that ejects both the response interceptor and the request-queue interceptor.

## Usage

In order to activate the interceptors, you need to import a function from `xior-auth-refresh`
which is _exported by default_ and call it with the **xior instance** you want the interceptors for,
as well as the **refresh authorization function** where you need to write the logic for refreshing the authorization.

The interceptors will then be bound onto the xior instance, and the specified logic will be run whenever a [401 (Unauthorized)](https://httpstatuses.com/401) status code
is returned from a server (or any other status code you provide in options). All the new requests created while the refreshAuthLogic has been processing will be bound onto the
Promise returned from the refreshAuthLogic function. This means that the requests will be resolved when a new access token has been fetched or when the refreshing logic failed.

```javascript
import xior from 'xior';
import createAuthRefreshInterceptor from 'xior-auth-refresh';

// Function that will be called to refresh authorization
const refreshAuthLogic = (failedRequest) =>
    xior
        .post('https://www.example.com/auth/token/refresh', undefined, {
            // Required when the refresh call uses the intercepted instance.
            skipAuthRefresh: true,
        })
        .then((tokenRefreshResponse) => {
            localStorage.setItem('token', tokenRefreshResponse.data.token);
            failedRequest.response.config.headers['Authorization'] = 'Bearer ' + tokenRefreshResponse.data.token;
        });

// Instantiate the interceptor
const ejectAuthRefresh = createAuthRefreshInterceptor(xior, refreshAuthLogic);

// Make a call. If it returns a 401 error, the refreshAuthLogic will be run,
// and the request retried with the new token
xior.get('https://www.example.com/restricted/area').then(/* ... */).catch(/* ... */);

// Remove both interceptors when they are no longer needed.
ejectAuthRefresh();
```

#### Skipping the interceptor

There's a possibility to skip the queue and refresh logic for specific calls.
Pass the `skipAuthRefresh` option to the request config for each request you don't want to intercept. A refresh request
made with the intercepted instance must use this option so it can run while other requests wait for it.

```javascript
xior.get('https://www.example.com/', { skipAuthRefresh: true });
```

#### Request interceptor

Since this plugin automatically stalls additional requests while refreshing the token,
it is a good idea to **wrap your request logic in a function**,
to make sure the stalled requests are using the newly fetched data (like token).

With xior 0.8, request interceptors run in registration order. This package places its refresh queue
ahead of existing request interceptors so stalled requests wait first, then read the new token exactly once before
they are sent.

Example of sending the tokens:

```javascript
// Obtain the fresh token each time the function is called
function getAccessToken() {
    return localStorage.getItem('token');
}

// Use interceptor to inject the token to requests
xior.interceptors.request.use((request) => {
    request.headers['Authorization'] = `Bearer ${getAccessToken()}`;
    return request;
});
```

## Available options

#### Status codes to intercept

You can specify multiple status codes that you want the interceptor to run for.

```javascript
{
    statusCodes: [401, 403], // default: [ 401 ]
}
```

#### Customize intercept logic

You can specify multiple status codes that you want the interceptor to run for.

```javascript
{
    shouldRefresh: (error) =>
        error?.response?.data?.business_error_code === 100385,
}
```

#### Retry instance for stalled requests

You can specify the instance which will be used for retrying the stalled requests.
Default value is `undefined` and the instance passed to `createAuthRefreshInterceptor` function is used.

```javascript
{
    retryInstance: someXiorInstance, // default: undefined
}
```

#### `onRetry` callback before sending the stalled requests

You can specify the `onRetry` callback which will be called before each
stalled request is called with the request configuration object.

```javascript
{
    onRetry: (requestConfig) => ({ ...requestConfig, baseURL: '' }), // default: undefined
}
```

#### Refresh client

Using a separate xior instance for the refresh request is recommended when it has different transport, retry or error
handling requirements. It is not required. When the intercepted instance is reused, mark the refresh request with
[`skipAuthRefresh`](#skipping-the-interceptor) so it bypasses the active request queue and cannot start a refresh loop.

#### Intercept on network error

Some CORS APIs may not return CORS response headers when an HTTP 401 Unauthorized response is returned.
In this scenario, the browser won't be able to read the response headers to determine the response status code.

To intercept _any_ network error, enable the `interceptNetworkError` option.

CAUTION: This should be used as a last resort. If this is used to work around an API that doesn't support CORS
with an HTTP 401 response, your retry logic can test for network connectivity attempting refresh authentication.

```javascript
{
    interceptNetworkError: true, // default: undefined
}
```

xior exposes failures from the native `fetch` implementation as their original error. A network request can only
be replayed when the custom fetch implementation attaches the failed `XiorRequestConfig` as `error.config` or
`error.request`. Raw fetch errors without request configuration are preserved and are not refreshed, because safely
reconstructing the request is impossible. Abort and timeout errors are never treated as authentication failures.

#### Composing with xior's error-retry plugin

This package already replays a request once after authentication is refreshed. Configure xior's generic retry plugin
to exclude authentication responses and failed refresh cycles; otherwise a retry plugin can wrap and repeat the whole
refresh flow.

```typescript
import xior, { XiorError, XiorRequestConfig } from 'xior';
import errorRetry from 'xior/plugins/error-retry';
import createAuthRefreshInterceptor from 'xior-auth-refresh';

const client = xior.create();

client.plugins.use(
    errorRetry({
        enableRetry(config: XiorRequestConfig, error: XiorError) {
            // Authentication replay is owned by xior-auth-refresh.
            if (error.response?.status === 401) return false;

            // Do not repeat a request whose refresh callback failed.
            if (config.skipAuthRefresh && !error.response) return false;

            // `undefined` keeps xior's default retry behaviour for other GET failures.
            return undefined;
        },
    }),
);

createAuthRefreshInterceptor(client, refreshAuthLogic);
```
