import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchJson } from '../src/http.js';

test('fetchJson resolves JSON on 200', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  try {
    const r = await fetchJson('http://x', { retries: 0, timeoutMs: 1000 });
    assert.deepEqual(r, { ok: 1 });
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchJson does NOT retry 404', async () => {
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response('nope', { status: 404 }); };
  try {
    let err;
    try { await fetchJson('http://x', { retries: 3, retryDelayMs: 1 }); } catch (e) { err = e; }
    assert.equal(calls, 1);
    assert.equal(err.status, 404);
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchJson retries 5xx', async () => {
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response('boom', { status: 503 });
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  };
  try {
    const r = await fetchJson('http://x', { retries: 3, retryDelayMs: 1 });
    assert.equal(calls, 3);
    assert.deepEqual(r, { ok: 1 });
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchJson 429: honours retry_after from JSON body', async () => {
  let calls = 0;
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  // Capture the backoff delay without actually waiting.
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(fn, 0); };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 2) {
      return new Response(
        JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 7 } }),
        { status: 429 },
      );
    }
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  };
  try {
    const r = await fetchJson('http://x', { retries: 2, retryDelayMs: 1 });
    assert.deepEqual(r, { ok: 1 });
    assert.equal(calls, 2);
    // The retry delay should reflect retry_after (7s = 7000ms), not the
    // 1ms exponential base.
    assert.ok(delays.some((d) => d >= 7000), `expected a ~7000ms delay, got ${JSON.stringify(delays)}`);
  } finally {
    globalThis.fetch = orig;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('fetchJson 429: honours Retry-After header', async () => {
  let calls = 0;
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(fn, 0); };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 2) {
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '5' } });
    }
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  };
  try {
    await fetchJson('http://x', { retries: 2, retryDelayMs: 1 });
    assert.ok(delays.some((d) => d >= 5000), `expected a ~5000ms delay, got ${JSON.stringify(delays)}`);
  } finally {
    globalThis.fetch = orig;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('fetchJson surfaces timeout', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => new Promise((_, rej) => {
    opts.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      rej(e);
    });
  });
  try {
    let err;
    try { await fetchJson('http://x', { timeoutMs: 100, retries: 0 }); } catch (e) { err = e; }
    assert.match(err.message, /timed out/i);
  } finally {
    globalThis.fetch = orig;
  }
});
