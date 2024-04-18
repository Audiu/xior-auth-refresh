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
): number;
```

#### Parameters

-   `xior` - an instance of Xior
-   `refreshAuthLogic` - a Function used for refreshing authorization (**must return a promise**).
    Accepts exactly one parameter, which is the `failedRequest` returned by the original call.
-   `options` - object with settings for interceptor (See [available options](#available-options))

#### Returns

Interceptor anonymous function.

## Usage

In order to activate the interceptors, you need to import a function from `xiorf-auth-refresh`
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
    xior.post('https://www.example.com/auth/token/refresh').then((tokenRefreshResponse) => {
        localStorage.setItem('token', tokenRefreshResponse.data.token);
        failedRequest.response.config.headers['Authorization'] = 'Bearer ' + tokenRefreshResponse.data.token;
        return Promise.resolve();
    });

// Instantiate the interceptor
createAuthRefreshInterceptor(xior, refreshAuthLogic);

// Make a call. If it returns a 401 error, the refreshAuthLogic will be run,
// and the request retried with the new token
xior.get('https://www.example.com/restricted/area').then(/* ... */).catch(/* ... */);
```

#### Skipping the interceptor

There's a possibility to skip the logic of the interceptor for specific calls.
To do this, you need to pass the `skipAuthRefresh` option to the request config for each request you don't want to intercept.

```javascript
xior.get('https://www.example.com/', { skipAuthRefresh: true });
```

#### Request interceptor

Since this plugin automatically stalls additional requests while refreshing the token,
it is a good idea to **wrap your request logic in a function**,
to make sure the stalled requests are using the newly fetched data (like token).

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

#### Pause the instance while "refresh logic" is running

While your refresh logic is running, the interceptor will be triggered for every request
which returns one of the `options.statusCodes` specified (HTTP 401 by default).

In order to prevent the interceptors loop (when your refresh logic fails with any of the status
codes specified in `options.statusCodes`) you need to use a [`skipAuthRefresh`](#skipping-the-interceptor)
flag on your refreshing call inside the `refreshAuthLogic` function.

In case your refresh logic does not make any calls, you should consider using the following flag
when initializing the interceptor to pause the whole xior instance while the refreshing is pending.
This prevents interceptor from running for each failed request.

```javascript
{
    pauseInstanceWhileRefreshing: true, // default: false
}
```

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
