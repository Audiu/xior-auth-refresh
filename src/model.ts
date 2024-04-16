import { XiorError, XiorInstance, XiorRequestConfig } from 'xior';

export interface AxiosAuthRefreshOptions {
    statusCodes?: Array<number>;
    /**
     * Determine whether to refresh, if "shouldRefresh" is configured, The "statusCodes" logic will be ignored
     * @param error AxiosError
     * @returns boolean
     */
    shouldRefresh?(error: XiorError): boolean;
    retryInstance?: XiorInstance;
    interceptNetworkError?: boolean;
    pauseInstanceWhileRefreshing?: boolean;
    onRetry?: (requestConfig: XiorRequestConfig) => XiorRequestConfig | Promise<XiorRequestConfig>;

    /**
     * @deprecated
     * This flag has been deprecated in favor of `pauseInstanceWhileRefreshing` flag.
     * Use `pauseInstanceWhileRefreshing` instead.
     */
    skipWhileRefreshing?: boolean;
}

export interface AxiosAuthRefreshCache {
    skipInstances: XiorInstance[];
    refreshCall: Promise<any> | undefined;
    requestQueueInterceptorId: any;
}

export interface AxiosAuthRefreshRequestConfig extends XiorRequestConfig {
    skipAuthRefresh?: boolean;
}
