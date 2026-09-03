import { isCancel, XiorInstance, XiorInterceptorRequestConfig, XiorRequestConfig } from 'xior';
import { XiorAuthRefreshOptions, XiorAuthRefreshCache } from './model';

export const defaultOptions: XiorAuthRefreshOptions = {
    statusCodes: [401],
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
    return {
        ...defaults,
        ...options,
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
): boolean {
    if (!error) {
        return false;
    }

    if (error.config?.skipAuthRefresh || error.request?.skipAuthRefresh) {
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

    return true;
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
        try {
            // Invoke the callback before publishing its promise to the request gate.
            // This lets a refresh request started with the intercepted instance pass
            // through before subsequent requests are queued behind it.
            const refreshCall = fn(error);
            if (!refreshCall || typeof refreshCall.then !== 'function') {
                cache.refreshCall = Promise.reject(
                    new TypeError('xior-auth-refresh requires `refreshAuthCall` to return a promise.'),
                );
            } else {
                cache.refreshCall = refreshCall;
            }
        } catch (error) {
            cache.refreshCall = Promise.reject(error);
        }
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
    const queueInterceptor = async (request: XiorInterceptorRequestConfig) => {
        if (request.skipAuthRefresh) {
            return request;
        }

        const refreshCall = cache.refreshCall;
        if (!refreshCall) {
            return request;
        }

        await refreshCall;
        return options.onRetry ? options.onRetry(request) : request;
    };
    const requestQueueInterceptor = instance.interceptors.request.use(queueInterceptor);

    // xior 0.8 runs request interceptors FIFO. Install the stable refresh gate
    // ahead of existing interceptors so requests wait before token/signing work.
    // This ordering is established once during setup, never during live iteration.
    const interceptorIndex = instance.REQI.indexOf(queueInterceptor);
    instance.REQI.splice(interceptorIndex, 1);
    instance.REQI.unshift(queueInterceptor);

    return requestQueueInterceptor;
}

/**
 * Clears the cached refresh operation.
 *
 * @param {XiorAuthRefreshCache} cache
 */
export function unsetCache(cache: XiorAuthRefreshCache): void {
    cache.refreshCall = undefined;
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
export async function resendFailedRequest(
    error: any,
    instance: XiorInstance,
    useRetryInstanceFetch = false,
    onRetry?: XiorAuthRefreshOptions['onRetry'],
): Promise<any> {
    const requestConfig: XiorRequestConfig | undefined = error.config || error.response?.config;
    if (!requestConfig) {
        throw error;
    }

    const retryConfig = { ...requestConfig, skipAuthRefresh: true };
    if (useRetryInstanceFetch) {
        delete retryConfig.fetch;
    }

    const finalConfig = onRetry
        ? await onRetry(retryConfig as XiorInterceptorRequestConfig)
        : retryConfig;
    return instance.request({ ...finalConfig, skipAuthRefresh: true });
}
