import { isCancel, XiorInstance, XiorRequestConfig } from 'xior';
import { XiorAuthRefreshOptions, XiorAuthRefreshCache } from './model';

export const defaultOptions: XiorAuthRefreshOptions = {
    statusCodes: [401],
    pauseInstanceWhileRefreshing: false,
};

/**
 * Merges two options objects (options overwrites defaults).
 *
 * @return {XiorAuthRefreshOptions}
 */
export function mergeOptions(
    defaults: XiorAuthRefreshOptions,
    options: XiorAuthRefreshOptions,
): XiorAuthRefreshOptions {
    const pauseInstanceWhileRefreshing =
        options.pauseInstanceWhileRefreshing ?? options.skipWhileRefreshing ?? defaults.pauseInstanceWhileRefreshing;

    return {
        ...defaults,
        ...options,
        pauseInstanceWhileRefreshing,
    };
}

/**
 * Returns TRUE: when error.response.status is contained in options.statusCodes
 * Returns FALSE: when error or error.response doesn't exist or options.statusCodes doesn't include response status
 *
 * @return {boolean}
 */
export function shouldInterceptError(
    error: any,
    options: XiorAuthRefreshOptions,
    instance: XiorInstance,
    cache: XiorAuthRefreshCache,
): boolean {
    if (!error) {
        return false;
    }

    if (error.config?.skipAuthRefresh) {
        return false;
    }

    if (!error.response) {
        if (!options.interceptNetworkError || isCancel(error)) {
            return false;
        }

        const requestConfig = error.config || error.request;
        if (!requestConfig) {
            // xior intentionally exposes raw fetch TypeErrors. Without the request config
            // there is no safe way to replay the failed request, so preserve that error.
            return false;
        }

        error.config = requestConfig;
        error.request = requestConfig;
        error.response = {
            config: requestConfig,
        };
    } else if (
        options.shouldRefresh
            ? !options.shouldRefresh(error)
            : !options.statusCodes?.includes(Number(error.response.status))
    ) {
        return false;
    }

    return !options.pauseInstanceWhileRefreshing || !cache.skipInstances.includes(instance);
}

/**
 * Creates refresh call if it does not exist or returns the existing one.
 *
 * @return {Promise<any>}
 */
export function createRefreshCall(
    error: any,
    fn: (error: any) => Promise<any>,
    cache: XiorAuthRefreshCache,
): Promise<any> {
    if (!cache.refreshCall) {
        // Assign the promise before invoking user code so concurrent failures always
        // share one refresh cycle, including when the callback throws synchronously.
        cache.refreshCall = Promise.resolve().then(() => {
            const refreshCall = fn(error);
            if (!refreshCall || typeof refreshCall.then !== 'function') {
                throw new TypeError('xior-auth-refresh requires `refreshAuthCall` to return a promise.');
            }
            return refreshCall;
        });
    }
    return cache.refreshCall;
}

/**
 * Creates request queue interceptor if it does not exist and returns its id.
 *
 * @return {number}
 */
export function createRequestQueueInterceptor(
    instance: XiorInstance,
    cache: XiorAuthRefreshCache,
    options: XiorAuthRefreshOptions,
): ReturnType<XiorInstance['interceptors']['request']['use']> {
    if (typeof cache.requestQueueInterceptorId === 'undefined') {
        const queueInterceptor = async (request: any) => {
            await cache.refreshCall;
            return options.onRetry ? options.onRetry(request) : request;
        };
        cache.requestQueueInterceptorId = instance.interceptors.request.use(queueInterceptor);

        // xior 0.8 runs request interceptors FIFO. Move the refresh queue ahead
        // of existing interceptors so newly stalled requests wait first, then run
        // token/signing/logging interceptors exactly once with post-refresh state.
        const interceptorIndex = instance.REQI.indexOf(queueInterceptor);
        instance.REQI.splice(interceptorIndex, 1);
        instance.REQI.unshift(queueInterceptor);
    }
    return cache.requestQueueInterceptorId;
}

/**
 * Ejects request queue interceptor and unset interceptor cached values.
 *
 * @param {XiorInstance} instance
 * @param {XiorAuthRefreshCache} cache
 */
export function unsetCache(instance: XiorInstance, cache: XiorAuthRefreshCache): void {
    if (typeof cache.requestQueueInterceptorId !== 'undefined') {
        instance.interceptors.request.eject(cache.requestQueueInterceptorId);
    }
    cache.requestQueueInterceptorId = undefined;
    cache.refreshCall = undefined;
    cache.skipInstances = cache.skipInstances.filter((skipInstance) => skipInstance !== instance);
}

/**
 * Returns instance that's going to be used when requests are retried
 *
 * @param instance
 * @param options
 */
export function getRetryInstance(instance: XiorInstance, options: XiorAuthRefreshOptions): XiorInstance {
    return options.retryInstance || instance;
}

/**
 * Resend failed xior request.
 *
 * @param {any} error
 * @param {XiorInstance} instance
 * @return Promise<any>
 */
export function resendFailedRequest(error: any, instance: XiorInstance, useRetryInstanceFetch = false): Promise<any> {
    const requestConfig: XiorRequestConfig | undefined = error.config || error.response?.config;
    if (!requestConfig) {
        return Promise.reject(error);
    }

    const retryConfig = { ...requestConfig, skipAuthRefresh: true };
    if (useRetryInstanceFetch) {
        delete retryConfig.fetch;
    }
    return instance.request(retryConfig);
}
