import xior, {
    XiorError,
    XiorInstance,
    XiorInterceptorRequestConfig,
    XiorRequestConfig,
    XiorTimeoutError,
} from 'xior';
import errorRetry from 'xior/plugins/error-retry';
import createAuthRefreshInterceptor, { XiorAuthRefreshOptions } from '../index';
import { XiorAuthRefreshCache } from '../model';
import {
    createRefreshCall,
    createRequestQueueInterceptor,
    defaultOptions,
    getRetryInstance,
    mergeOptions,
    resendFailedRequest,
    shouldInterceptError,
    unsetCache,
} from '../utils';

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: any) => void;
};

function deferred<T = void>(): Deferred<T> {
    let resolve!: Deferred<T>['resolve'];
    let reject!: Deferred<T>['reject'];
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const response = (status: number, data: any = { status }) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
    });

function createInstance(fetchImplementation: (input: any, init?: any) => Promise<Response>) {
    const fetch = jest.fn(fetchImplementation);
    return {
        fetch,
        instance: xior.create({ fetch }),
    };
}

function createCache(overrides: Partial<XiorAuthRefreshCache> = {}): XiorAuthRefreshCache {
    return {
        refreshCall: undefined,
        ...overrides,
    };
}

function installTokenHeader(instance: XiorInstance, getToken: () => string) {
    instance.interceptors.request.use((config) => {
        config.headers.authorization = getToken();
        return config;
    });
}

const safeAuthRetry = (config: XiorRequestConfig, error: XiorError) => {
    if (error.response?.status === 401) {
        return false;
    }
    if (config.skipAuthRefresh && !error.response) {
        return false;
    }
    return undefined;
};

describe('options and interception decisions', () => {
    it('merges defaults without mutating either input', () => {
        const defaults: XiorAuthRefreshOptions = { statusCodes: [401] };
        const options: XiorAuthRefreshOptions = { statusCodes: [403] };

        expect(mergeOptions(defaults, options)).toEqual({ statusCodes: [403] });
        expect(defaults).toEqual({ statusCodes: [401] });
        expect(options).toEqual({ statusCodes: [403] });
    });

    it.each([
        ['a missing error', undefined],
        ['an empty error', {}],
        ['a response without status', { response: {} }],
        ['a non-matching status', { response: { status: 403 } }],
    ])('does not intercept %s', (_description, error) => {
        expect(shouldInterceptError(error, defaultOptions)).toBe(false);
    });

    it('matches numeric and numeric-string response statuses', () => {
        expect(shouldInterceptError({ response: { status: 401 } }, defaultOptions)).toBe(true);
        expect(shouldInterceptError({ response: { status: '401' } }, defaultOptions)).toBe(true);
    });

    it('does not accept partially numeric response statuses', () => {
        expect(shouldInterceptError({ response: { status: '401-invalid' } }, defaultOptions)).toBe(false);
    });

    it('does not intercept statuses when no statusCodes are configured', () => {
        expect(shouldInterceptError({ response: { status: 401 } }, {})).toBe(false);
    });

    it('honours skipAuthRefresh', () => {
        const error = { response: { status: 401 }, config: { skipAuthRefresh: true } };
        expect(shouldInterceptError(error, defaultOptions)).toBe(false);
    });

    it('lets shouldRefresh override statusCodes', () => {
        const error = { response: { status: 500, data: { code: 'TOKEN_EXPIRED' } } };
        expect(
            shouldInterceptError(
                error,
                {
                    statusCodes: [401],
                    shouldRefresh: (candidate) => candidate.response?.data.code === 'TOKEN_EXPIRED',
                },
            ),
        ).toBe(true);
        expect(
            shouldInterceptError(
                { response: { status: 401 } },
                { statusCodes: [401], shouldRefresh: () => false },
            ),
        ).toBe(false);
    });

    it('normalizes a replayable network error', () => {
        const config = { url: '/network-error' };
        const error: any = { config };

        expect(shouldInterceptError(error, { ...defaultOptions, interceptNetworkError: true })).toBe(true);
        expect(error.request).toBe(config);
        expect(error.response.config).toBe(config);
    });

    it('preserves a raw network error when xior provides no replay config', () => {
        expect(
            shouldInterceptError(
                new TypeError('fetch failed'),
                { ...defaultOptions, interceptNetworkError: true },
            ),
        ).toBe(false);
    });

    it('does not refresh cancellations or timeouts', () => {
        const timeout = new XiorTimeoutError('timed out', { url: '/slow' });
        expect(shouldInterceptError(timeout, { ...defaultOptions, interceptNetworkError: true })).toBe(false);
    });
});

describe('refresh and queue primitives', () => {
    it('deduplicates concurrent refresh calls', async () => {
        const cache = createCache();
        const refresh = jest.fn(async () => 'new-token');

        const first = createRefreshCall({}, refresh, cache);
        const second = createRefreshCall({}, refresh, cache);

        expect(first).toBe(second);
        await expect(first).resolves.toBe('new-token');
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('turns a synchronous refresh throw into a rejected promise', async () => {
        const failure = new Error('synchronous refresh failure');
        await expect(
            createRefreshCall(
                {},
                () => {
                    throw failure;
                },
                createCache(),
            ),
        ).rejects.toBe(failure);
    });

    it('rejects a refresh callback that does not return a promise', async () => {
        await expect(createRefreshCall({}, (() => undefined) as any, createCache())).rejects.toThrow(
            'refreshAuthCall` to return a promise',
        );
    });

    it('propagates the refresh rejection to queued requests unchanged', async () => {
        const failure = new Error('refresh rejected');
        const gate = deferred<void>();
        const { instance, fetch } = createInstance(async () => response(200));
        const cache = createCache({ refreshCall: gate.promise });
        createRequestQueueInterceptor(instance, cache, {});

        const request = instance.get('/queued');
        gate.reject(failure);

        await expect(request).rejects.toBe(failure);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('lets requests marked with skipAuthRefresh bypass an active queue', async () => {
        const gate = deferred<void>();
        const { instance, fetch } = createInstance(async () => response(200));
        const cache = createCache({ refreshCall: gate.promise });
        createRequestQueueInterceptor(instance, cache, {});

        await expect(instance.get('/refresh', { skipAuthRefresh: true })).resolves.toMatchObject({ status: 200 });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('releases a queued request unchanged when no onRetry callback is configured', async () => {
        const gate = deferred<void>();
        const { instance, fetch } = createInstance(async () => response(200));
        const cache = createCache({ refreshCall: gate.promise });
        createRequestQueueInterceptor(instance, cache, {});

        const request = instance.get('/queued');
        gate.resolve();
        await request;

        expect(fetch.mock.calls[0][0]).toBe('/queued');
    });

    it('runs an asynchronous onRetry before releasing a queued request', async () => {
        const gate = deferred<void>();
        const { instance, fetch } = createInstance(async () => response(200));
        const cache = createCache({ refreshCall: gate.promise });
        const onRetry = jest.fn(async (config: XiorInterceptorRequestConfig) => ({ ...config, url: '/changed' }));
        createRequestQueueInterceptor(instance, cache, { onRetry });

        const request = instance.get('/original');
        gate.resolve();
        await request;

        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toBe('/changed');
    });

    it('clears refresh state', () => {
        const cache = createCache();
        cache.refreshCall = Promise.resolve();

        unsetCache(cache);
        unsetCache(cache);

        expect(cache).toEqual({ refreshCall: undefined });
    });

    it('selects the configured retry instance', () => {
        const primary = xior.create();
        const retry = xior.create();
        expect(getRetryInstance(primary, {})).toBe(primary);
        expect(getRetryInstance(primary, { retryInstance: retry })).toBe(retry);
    });

    it('rejects an unreplayable error without throwing another error', async () => {
        const original = new TypeError('unreplayable');
        await expect(resendFailedRequest(original, xior.create())).rejects.toBe(original);
    });

    it('replays from response.config when config is not present on the error', async () => {
        const { instance, fetch } = createInstance(async () => response(200));
        const config: XiorRequestConfig = { url: '/response-config' };

        await expect(resendFailedRequest({ response: { config } }, instance)).resolves.toMatchObject({ status: 200 });
        expect(config.skipAuthRefresh).toBeUndefined();
        expect(fetch.mock.calls[0][1].skipAuthRefresh).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('xior 0.8 authentication refresh integration', () => {
    it('rejects a missing refresh callback during setup', () => {
        expect(() => createAuthRefreshInterceptor(xior.create(), undefined as any)).toThrow(
            'refreshAuthCall` to be a function',
        );
    });

    it('refreshes a 401 and replays the original request with the new token', async () => {
        let token = 'expired';
        const { instance, fetch } = createInstance(async (_input, init) =>
            init.headers.authorization === 'fresh'
                ? response(200, { authenticated: true })
                : response(401, { authenticated: false }),
        );
        const tokenInterceptor = jest.fn((config) => {
            config.headers.authorization = token;
            return config;
        });
        instance.interceptors.request.use(tokenInterceptor);
        const refresh = jest.fn(async () => {
            token = 'fresh';
        });
        createAuthRefreshInterceptor(instance, refresh);

        const result = await instance.get('/protected');

        expect(result.data).toEqual({ authenticated: true });
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(tokenInterceptor).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls.map((call) => call[1].headers.authorization)).toEqual(['expired', 'fresh']);
    });

    it('allows a skipped refresh request to use the intercepted instance after asynchronous work', async () => {
        let token = 'expired';
        const { instance, fetch } = createInstance(async (input, init) => {
            if (input === '/auth/refresh') {
                token = 'fresh';
                return response(200);
            }
            return init.headers.authorization === 'fresh' ? response(200) : response(401);
        });
        installTokenHeader(instance, () => token);
        createAuthRefreshInterceptor(instance, async () => {
            await nextTurn();
            return instance.post('/auth/refresh', undefined, { skipAuthRefresh: true });
        });

        await expect(instance.get('/protected')).resolves.toMatchObject({ status: 200 });
        expect(fetch.mock.calls.map((call) => call[0])).toEqual(['/protected', '/auth/refresh', '/protected']);
    });

    it('deduplicates a concurrent wave and stalls requests arriving during refresh', async () => {
        const requestCount = 25;
        let token = 'expired';
        const refreshStarted = deferred<void>();
        const releaseRefresh = deferred<void>();
        const { instance, fetch } = createInstance(async (_input, init) =>
            init.headers.authorization === 'fresh' ? response(200) : response(401),
        );
        const tokenInterceptor = jest.fn((config) => {
            config.headers.authorization = token;
            return config;
        });
        instance.interceptors.request.use(tokenInterceptor);
        const refresh = jest.fn(async () => {
            refreshStarted.resolve();
            await releaseRefresh.promise;
            token = 'fresh';
        });
        const onRetry = jest.fn((config: XiorInterceptorRequestConfig) => config);
        createAuthRefreshInterceptor(instance, refresh, { onRetry });

        const wave = Array.from({ length: requestCount }, (_, index) => instance.get(`/wave/${index}`));
        await refreshStarted.promise;
        await nextTurn();
        const lateRequest = instance.get('/late');
        await nextTurn();

        expect(fetch).toHaveBeenCalledTimes(requestCount);
        releaseRefresh.resolve();
        const results = await Promise.all([...wave, lateRequest]);

        expect(results.every((result) => result.status === 200)).toBe(true);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(requestCount * 2 + 1);
        expect(onRetry).toHaveBeenCalledTimes(requestCount + 1);
        expect(tokenInterceptor).toHaveBeenCalledTimes(requestCount * 2 + 1);
    });

    it('does not reorder request interceptors while another request is awaiting one', async () => {
        let token = 'expired';
        const slowInterceptorEntered = deferred<void>();
        const releaseSlowInterceptor = deferred<void>();
        const refreshStarted = deferred<void>();
        const releaseRefresh = deferred<void>();
        const interceptorRuns = new Map<string, number>();
        const { instance, fetch } = createInstance(async (_input, init) =>
            init.headers.authorization === 'fresh' ? response(200) : response(401),
        );

        instance.interceptors.request.use(async (config) => {
            const run = (interceptorRuns.get(config.url) || 0) + 1;
            interceptorRuns.set(config.url, run);
            if (config.url === '/slow' && run === 1) {
                slowInterceptorEntered.resolve();
                await releaseSlowInterceptor.promise;
            }
            return config;
        });
        installTokenHeader(instance, () => token);
        createAuthRefreshInterceptor(instance, async () => {
            refreshStarted.resolve();
            await releaseRefresh.promise;
            token = 'fresh';
        });

        const slowRequest = instance.get('/slow');
        await slowInterceptorEntered.promise;
        const refreshTrigger = instance.get('/trigger');
        await refreshStarted.promise;

        releaseSlowInterceptor.resolve();
        await nextTurn();
        expect(interceptorRuns.get('/slow')).toBe(1);

        releaseRefresh.resolve();
        await expect(Promise.all([slowRequest, refreshTrigger])).resolves.toEqual([
            expect.objectContaining({ status: 200 }),
            expect.objectContaining({ status: 200 }),
        ]);
        expect(interceptorRuns.get('/slow')).toBe(2);
        expect(interceptorRuns.get('/trigger')).toBe(2);
        expect(fetch).toHaveBeenCalledTimes(4);
    });

    it('rejects all waiters with the refresh error, cleans up, and recovers on the next wave', async () => {
        let token = 'expired';
        let refreshAttempt = 0;
        const refreshStarted = deferred<void>();
        const firstRefresh = deferred<void>();
        const failure = new Error('refresh service unavailable');
        const { instance, fetch } = createInstance(async (_input, init) =>
            init.headers.authorization === 'fresh' ? response(200) : response(401),
        );
        installTokenHeader(instance, () => token);
        const refresh = jest.fn(async () => {
            refreshAttempt += 1;
            if (refreshAttempt === 1) {
                refreshStarted.resolve();
                await firstRefresh.promise;
            } else {
                token = 'fresh';
            }
        });
        createAuthRefreshInterceptor(instance, refresh);

        const original = instance.get('/original');
        await refreshStarted.promise;
        const queued = instance.get('/queued');
        await nextTurn();
        expect(fetch).toHaveBeenCalledTimes(1);
        firstRefresh.reject(failure);

        const failed = await Promise.allSettled([original, queued]);
        expect(failed.map((result) => (result.status === 'rejected' ? result.reason : undefined))).toEqual([
            failure,
            failure,
        ]);

        const recovered = await instance.get('/recovered');
        expect(recovered.status).toBe(200);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('cleans up after a synchronous refresh failure', async () => {
        let token = 'expired';
        let attempt = 0;
        const failure = new Error('refresh threw');
        const { instance } = createInstance(async (_input, init) =>
            init.headers.authorization === 'fresh' ? response(200) : response(401),
        );
        installTokenHeader(instance, () => token);
        const refresh = jest.fn(() => {
            attempt += 1;
            if (attempt === 1) {
                throw failure;
            }
            token = 'fresh';
            return Promise.resolve();
        });
        createAuthRefreshInterceptor(instance, refresh);

        await expect(instance.get('/first')).rejects.toBe(failure);
        await expect(instance.get('/second')).resolves.toMatchObject({ status: 200 });
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('cleans up after a non-Promise refresh result', async () => {
        let token = 'expired';
        let attempt = 0;
        const { instance } = createInstance(async (_input, init) =>
            init.headers.authorization === 'fresh' ? response(200) : response(401),
        );
        installTokenHeader(instance, () => token);
        const refresh = jest.fn(() => {
            attempt += 1;
            if (attempt === 1) {
                return undefined;
            }
            token = 'fresh';
            return Promise.resolve();
        });
        createAuthRefreshInterceptor(instance, refresh as any);

        await expect(instance.get('/first')).rejects.toThrow('refreshAuthCall` to return a promise');
        await expect(instance.get('/second')).resolves.toMatchObject({ status: 200 });
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('allows only one auth replay when the refreshed credentials are still rejected', async () => {
        const { instance, fetch } = createInstance(async () => response(401));
        const refresh = jest.fn(async () => undefined);
        createAuthRefreshInterceptor(instance, refresh);

        await expect(instance.get('/still-unauthorized')).rejects.toMatchObject({
            response: { status: 401 },
            config: { skipAuthRefresh: true },
        });
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('skips refresh for requests marked with skipAuthRefresh', async () => {
        const { instance, fetch } = createInstance(async () => response(401));
        const refresh = jest.fn(async () => undefined);
        createAuthRefreshInterceptor(instance, refresh);

        await expect(instance.get('/public', { skipAuthRefresh: true })).rejects.toBeInstanceOf(XiorError);
        expect(refresh).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('supports custom status codes and asynchronous onRetry mutation', async () => {
        const { instance, fetch } = createInstance(async (input) =>
            input === '/healthy' ? response(200) : response(403),
        );
        const refresh = jest.fn(async () => undefined);
        const onRetry = jest.fn(async ({ skipAuthRefresh: _skipAuthRefresh, ...config }: XiorInterceptorRequestConfig) => ({
            ...config,
            url: '/healthy',
        }));
        createAuthRefreshInterceptor(instance, refresh, { statusCodes: [403], onRetry });

        await expect(instance.get('/forbidden')).resolves.toMatchObject({ status: 200 });
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls.map((call) => call[0])).toEqual(['/forbidden', '/healthy']);
        expect(fetch.mock.calls[1][1].skipAuthRefresh).toBe(true);
    });

    it('replays through a custom retry instance', async () => {
        const { instance: primary, fetch: primaryFetch } = createInstance(async () => response(401));
        const { instance: retry, fetch: retryFetch } = createInstance(async () => response(200));
        const primaryInterceptor = jest.fn((config) => config);
        const retryInterceptor = jest.fn((config) => config);
        primary.interceptors.request.use(primaryInterceptor);
        retry.interceptors.request.use(retryInterceptor);
        createAuthRefreshInterceptor(primary, async () => undefined, { retryInstance: retry });

        await expect(primary.get('/retry-instance')).resolves.toMatchObject({ status: 200 });
        expect(primaryFetch).toHaveBeenCalledTimes(1);
        expect(retryFetch).toHaveBeenCalledTimes(1);
        expect(primaryInterceptor).toHaveBeenCalledTimes(1);
        expect(retryInterceptor).toHaveBeenCalledTimes(1);
    });

    it('replays a network error when the custom fetch supplies request config', async () => {
        let currentConfig: XiorRequestConfig | undefined;
        let attempt = 0;
        const { instance, fetch } = createInstance(async () => {
            attempt += 1;
            if (attempt === 1) {
                throw Object.assign(new TypeError('network unavailable'), { config: currentConfig });
            }
            return response(200);
        });
        instance.interceptors.request.use((config) => {
            currentConfig = config;
            return config;
        });
        const refresh = jest.fn(async () => undefined);
        createAuthRefreshInterceptor(instance, refresh, { interceptNetworkError: true });

        await expect(instance.get('/network')).resolves.toMatchObject({ status: 200 });
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('preserves raw xior fetch errors instead of masking them', async () => {
        const failure = new TypeError('raw fetch failure');
        const { instance } = createInstance(async () => {
            throw failure;
        });
        const refresh = jest.fn(async () => undefined);
        createAuthRefreshInterceptor(instance, refresh, { interceptNetworkError: true });

        await expect(instance.get('/network')).rejects.toBe(failure);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('returns an idempotent ejector that removes both interceptors', async () => {
        const { instance, fetch } = createInstance(async () => response(401));
        const refresh = jest.fn(async () => undefined);
        const eject = createAuthRefreshInterceptor(instance, refresh);

        expect(instance.REQI).toHaveLength(1);
        expect(instance.RESI).toHaveLength(1);
        eject();
        eject();
        expect(instance.REQI).toHaveLength(0);
        expect(instance.RESI).toHaveLength(0);

        await expect(instance.get('/after-eject')).rejects.toBeInstanceOf(XiorError);
        expect(refresh).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('composition with xior 0.8 error-retry', () => {
    function useSafeRetries(instance: XiorInstance) {
        instance.plugins.use(
            errorRetry({
                retryTimes: 2,
                retryInterval: 0,
                enableRetry: safeAuthRetry,
            }),
        );
    }

    it('does not multiply attempts when refreshed credentials remain unauthorized', async () => {
        const { instance, fetch } = createInstance(async () => response(401));
        useSafeRetries(instance);
        const refresh = jest.fn(async () => undefined);
        createAuthRefreshInterceptor(instance, refresh);

        await expect(instance.get('/invalid-token')).rejects.toMatchObject({ response: { status: 401 } });
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry a rejected refresh cycle', async () => {
        const { instance, fetch } = createInstance(async () => response(401));
        useSafeRetries(instance);
        const failure = new Error('refresh rejected');
        const refresh = jest.fn(async () => {
            throw failure;
        });
        createAuthRefreshInterceptor(instance, refresh);

        await expect(instance.get('/refresh-fails')).rejects.toBe(failure);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('still retries transient non-auth failures', async () => {
        let call = 0;
        const { instance, fetch } = createInstance(async () => {
            call += 1;
            return call === 1 ? response(503) : response(200);
        });
        useSafeRetries(instance);
        const refresh = jest.fn(async () => undefined);
        createAuthRefreshInterceptor(instance, refresh);

        await expect(instance.get('/transient')).resolves.toMatchObject({ status: 200 });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('retries a transient failure after a successful auth replay', async () => {
        let call = 0;
        const { instance, fetch } = createInstance(async () => {
            call += 1;
            if (call === 1) return response(401);
            if (call === 2) return response(503);
            return response(200);
        });
        useSafeRetries(instance);
        const refresh = jest.fn(async () => undefined);
        createAuthRefreshInterceptor(instance, refresh);

        await expect(instance.get('/auth-then-transient')).resolves.toMatchObject({ status: 200 });
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(3);
    });
});
