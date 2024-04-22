import { XiorError, XiorInstance, XiorResponse } from 'xior';
import { XiorAuthRefreshOptions, XiorAuthRefreshCache, XiorAuthRefreshRequestConfig } from './model';
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

export type { XiorAuthRefreshOptions, XiorAuthRefreshRequestConfig };

declare module 'xior' {
    interface XiorRequestConfig {
        skipAuthRefresh?: boolean;
    }
}

/**
 * Creates an authentication refresh interceptor that binds to any error response.
 * If the response status code is one of the options.statusCodes, interceptor calls the refreshAuthCall
 * which must return a Promise. While refreshAuthCall is running, all the new requests are intercepted and are waiting
 * for the refresh call to resolve. While running the refreshing call, instance provided is marked as a paused instance
 * which indicates the interceptor to not intercept any responses from it. This is because you'd otherwise need to mark
 * the specific requests you make by yourself in order to make sure it's not intercepted. This behavior can be
 * turned off, but use it with caution as you need to mark the requests with `skipAuthRefresh` flag yourself in order to
 * not run into interceptors loop.
 *
 * @param {XiorInstance} instance - Xior HTTP client instance
 * @param {(error: XiorError) => Promise<any>} refreshAuthCall - refresh token call which must return a Promise
 * @param {XiorAuthRefreshOptions} options - options for the interceptor @see defaultOptions
 * @return {func} - Anonymous interceptor function
 */
export default function createAuthRefreshInterceptor(
    instance: XiorInstance,
    refreshAuthCall: (error: XiorError) => Promise<void | XiorResponse<any>>,
    options: XiorAuthRefreshOptions = {}
): any {
    if (typeof refreshAuthCall !== 'function') {
        throw new Error('xior-auth-refresh requires `refreshAuthCall` to be a function that returns a promise.');
    }

    const cache: XiorAuthRefreshCache = {
        skipInstances: [],
        refreshCall: undefined,
        requestQueueInterceptorId: undefined,
    };

    return instance.interceptors.response.use(
        (response) => response,
        (error) => {
            options = mergeOptions(defaultOptions, options);

            if (!shouldInterceptError(error, options, instance, cache)) {
                // https://github.com/suhaotian/xior/issues/15 - in current version this will stop the reject chain
                //return Promise.reject(error);
                return;
            }

            if (options.pauseInstanceWhileRefreshing) {
                cache.skipInstances.push(instance);
            }

            // If refresh call does not exist, create one
            const refreshing = createRefreshCall(error, refreshAuthCall, cache);

            // Create interceptor that will bind all the others requests until refreshAuthCall is resolved
            createRequestQueueInterceptor(instance, cache, options);

            return (
                refreshing
                    // https://github.com/suhaotian/xior/issues/15 - in current version this will stop the reject chain
                    //.catch((error) => Promise.reject(error))
                    .then(() => resendFailedRequest(error, getRetryInstance(instance, options)))
                    // However, if we were successful, we now want to stop the reject chain
                    // This will break any response intercepts which run for successful responses after, but that is
                    // broken currently anyway (it isn't the same as axios - https://github.com/axios/axios?tab=readme-ov-file#multiple-interceptors)
                    .then(() => Promise.reject(error))
                    .finally(() => unsetCache(instance, cache))
            );
        }
    );
}
