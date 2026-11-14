const AUTH_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bounds passwordless OTP sends and verification at the network layer.
 * Aborting the actual request prevents a timed-out verification response from
 * being processed later and persisting a session after the UI offered retry.
 */
export function createAuthTimeoutFetch(
  fetcher: typeof fetch,
  timeoutMs = AUTH_REQUEST_TIMEOUT_MS,
): typeof fetch {
  return async (input, init) => {
    let url: URL;
    try {
      const requestUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      url = new URL(requestUrl);
    } catch {
      return fetcher(input, init);
    }

    if (url.pathname !== '/auth/v1/otp' && url.pathname !== '/auth/v1/verify') {
      return fetcher(input, init);
    }

    const controller = new AbortController();
    const requestSignal = init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
    const abortFromCaller = () => controller.abort();
    if (requestSignal?.aborted) controller.abort();
    else requestSignal?.addEventListener('abort', abortFromCaller, { once: true });

    const cleanup = () => {
      clearTimeout(timeout);
      requestSignal?.removeEventListener('abort', abortFromCaller);
    };
    const timeout = setTimeout(() => {
      controller.abort();
      cleanup();
    }, timeoutMs);
    try {
      const response = await fetcher(input, { ...init, signal: controller.signal });
      if (!response.body) {
        cleanup();
      } else {
        // Keep the abort signal alive through body download too. Fetch resolves
        // at headers, while Supabase still has to read the JSON body.
        void response.clone().arrayBuffer().then(cleanup, cleanup);
      }
      return response;
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}
