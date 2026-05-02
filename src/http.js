// Unified HTTP helper for every external request the bot makes — Predict.fun
// REST/GraphQL, Telegram. Provides a per-request timeout (so a stuck socket
// can never hang an entire tick), retry on 5xx/429/abort with exponential
// backoff, and consistent error shape including HTTP status when available.

const NETWORK_RETRIABLE_PATTERNS = [
  /fetch failed/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENETUNREACH/i,
  /EAI_AGAIN/i,
];

function isRetriableError(err) {
  if (err?.name === 'AbortError') return true;
  if (err?.status === 429) return true;
  if (Number.isFinite(err?.status) && err.status >= 500) return true;
  if (err?.status == null) {
    const msg = String(err?.message ?? '');
    return NETWORK_RETRIABLE_PATTERNS.some((re) => re.test(msg));
  }
  return false;
}

export async function fetchJson(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 15_000,
  retries = 2,
  retryDelayMs = 1_000,
  signal: externalSignal,
  parseJson = true,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let externalAbortHandler;
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      externalAbortHandler = () => ctrl.abort();
      externalSignal.addEventListener('abort', externalAbortHandler);
    }
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 200)}`);
        err.status = res.status;
        err.body = text;
        err.url = url;
        throw err;
      }
      if (!parseJson) return text;
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        const err = new Error(`Invalid JSON from ${url}: ${parseErr.message}`);
        err.body = text;
        err.url = url;
        throw err;
      }
    } catch (err) {
      lastErr = err;
      // External cancellation (e.g. SIGINT) -> don't retry
      if (externalSignal?.aborted) break;
      if (!isRetriableError(err) || attempt === retries) break;
      const delay = retryDelayMs * Math.pow(2, attempt) + Math.random() * 200;
      await new Promise((r) => setTimeout(r, delay));
    } finally {
      clearTimeout(timer);
      if (externalSignal && externalAbortHandler) {
        externalSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }
  // Surface AbortError as "timed out" unless externally cancelled.
  if (lastErr?.name === 'AbortError' && !externalSignal?.aborted) {
    const e = new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    e.cause = lastErr;
    e.url = url;
    throw e;
  }
  throw lastErr;
}
