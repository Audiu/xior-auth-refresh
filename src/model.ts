import { XiorError, XiorInstance, XiorInterceptorRequestConfig, XiorRequestConfig } from 'xior';

export interface XiorAuthRefreshOptions {
    statusCodes?: Array<number>;
    /**
     * Determine whether to refresh, if "shouldRefresh" is configured, The "statusCodes" logic will be ignored
     * @param error XiorError
     * @returns boolean
     */
    shouldRefresh?(error: XiorError): boolean;
    retryInstance?: XiorInstance;
    interceptNetworkError?: boolean;
    onRetry?: (
        requestConfig: XiorInterceptorRequestConfig,
    ) => XiorInterceptorRequestConfig | Promise<XiorInterceptorRequestConfig>;
}

export interface XiorAuthRefreshCache {
    refreshCall: Promise<any> | undefined;
}

export type XiorAuthRefreshEjector = () => void;

export interface XiorAuthRefreshRequestConfig extends XiorRequestConfig {
    skipAuthRefresh?: boolean;
}
