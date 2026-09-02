import { XiorError, XiorInstance, XiorResponse } from 'xior';
import {
    XiorAuthRefreshOptions,
    XiorAuthRefreshCache,
    XiorAuthRefreshEjector,
    XiorAuthRefreshRequestConfig,
} from './model';
import {
    unsetCache,
    mergeOptions,
    defaultOptions,
    getRetryInstance,
    createRefreshCall,
    resendFailedRequest,
    shouldInterceptError,
    createRequestQueueInterceptor,
} from './utils';

export type { XiorAuthRefreshEjector, XiorAuthRefreshOptions, XiorAuthRefreshRequestConfig };

declare module 'xior' {
    interface XiorRequestConfig {
        skipAuthRefresh?: boolean;
    }
}

/**
 * Creates an authentication refresh interceptor that binds to any error response.
 * If the response status code is one of the options.statusCodes, interceptor calls the refreshAuthCall
 * which must return a Promise. While refreshAuthCall is running, all the new requests are intercepted and are waiting
 * for the refresh call to resolve. Refresh requests made through the intercepted instance must use the
 * `skipAuthRefresh` flag so they bypass the queue and cannot start an interceptor loop.
 *
 * @param {XiorInstance} instance - Xior HTTP client instance
 * @param {(error: XiorError) => Promise<any>} refreshAuthCall - refresh token call which must return a Promise
 * @param {XiorAuthRefreshOptions} options - options for the interceptor @see defaultOptions
 * @return {XiorAuthRefreshEjector} - Idempotent function that ejects both installed interceptors
 */
export default function createAuthRefreshInterceptor(
    instance: XiorInstance,
    refreshAuthCall: (error: XiorError) => Promise<void | XiorResponse<any>>,
    options: XiorAuthRefreshOptions = {},
): XiorAuthRefreshEjector {
    if (typeof refreshAuthCall !== 'function') {
        throw new Error('xior-auth-refresh requires `refreshAuthCall` to be a function that returns a promise.');
    }

    const mergedOptions = mergeOptions(defaultOptions, options);
    const cache: XiorAuthRefreshCache = {
        refreshCall: undefined,
    };

    // Install one stable gate before requests begin. Moving an interceptor to the
    // front while xior is iterating REQI can repeat or skip handlers on in-flight requests.
    const requestQueueInterceptor = createRequestQueueInterceptor(instance, cache, mergedOptions);

    const responseInterceptor = instance.interceptors.response.use(
        (response) => response,
        (error) => {
            if (!shouldInterceptError(error, mergedOptions)) {
                return Promise.reject(error);
            }

            // Mark the complete auth-refresh cycle as handled. This prevents a
            // surrounding retry plugin from starting another refresh cycle for
            // the same request if refreshing itself fails.
            if (error.config) {
                error.config.skipAuthRefresh = true;
            }

            // If refresh call does not exist, create one
            const refreshing = createRefreshCall(error, refreshAuthCall, cache);

            return refreshing
                .then(() => {
                    const retryInstance = getRetryInstance(instance, mergedOptions);
                    return resendFailedRequest(
                        error,
                        retryInstance,
                        retryInstance !== instance,
                        mergedOptions.onRetry,
                    );
                })
                .finally(() => unsetCache(cache));
        },
    );

    let ejected = false;
    return () => {
        if (ejected) {
            return;
        }

        ejected = true;
        instance.interceptors.response.eject(responseInterceptor);
        instance.interceptors.request.eject(requestQueueInterceptor);
        unsetCache(cache);
    };
}
