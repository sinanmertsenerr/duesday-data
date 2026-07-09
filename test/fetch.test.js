import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { FetchError, fetchPage } from '../scraper/lib/fetch.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const response = (status, body = '') => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

const fast = { retryDelayMs: 1, timeoutMs: 1000 };

test('200 → gövde döner, UA header gider', async () => {
  let seenHeaders;
  globalThis.fetch = async (url, init) => {
    seenHeaders = init.headers;
    return response(200, '<html>ok</html>');
  };
  const body = await fetchPage('https://example.com', fast);
  assert.equal(body, '<html>ok</html>');
  assert.match(seenHeaders['user-agent'], /Duesday-PriceBot/);
});

test('403 → retry YOK, FetchError (bot koruması ısrarla döner)', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response(403);
  };
  await assert.rejects(fetchPage('https://example.com', fast), (e) => {
    return e instanceof FetchError && e.status === 403;
  });
  assert.equal(calls, 1);
});

test('429 → bir retry hakkı; ikinci de 429 ise hata', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response(429);
  };
  await assert.rejects(fetchPage('https://example.com', fast), (e) => e.status === 429);
  assert.equal(calls, 2);
});

test('500 sonra 200 → retry başarılı, gövde döner', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? response(500) : response(200, 'iyileşti');
  };
  assert.equal(await fetchPage('https://example.com', fast), 'iyileşti');
  assert.equal(calls, 2);
});

test('ağ hatası (fetch throw) → retry, sonra FetchError', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('ECONNRESET');
  };
  await assert.rejects(fetchPage('https://example.com', fast), FetchError);
  assert.equal(calls, 2);
});
