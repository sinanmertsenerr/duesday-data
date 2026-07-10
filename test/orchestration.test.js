import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { runScrape } from '../scraper/index.js';
import { buildPrBody } from '../scraper/lib/prbody.js';
import { computeDiff } from '../scraper/lib/diff.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const cssPage = readFileSync(join(fixturesDir, 'css-page.html'), 'utf8');

const catalog = {
  schemaVersion: 1,
  generatedAt: '2026-07-01',
  services: [
    {
      id: 'svc-a',
      name: 'A',
      category: 'streaming',
      prices: { tr: { minorUnits: 119999, currency: 'TRY' } },
    },
    {
      id: 'svc-b',
      name: 'B',
      category: 'music',
      prices: { tr: { minorUnits: 5999, currency: 'TRY' } },
    },
  ],
};

const config = {
  services: [
    {
      id: 'svc-a',
      regions: {
        tr: {
          url: 'https://a.example/fiyat',
          locale: 'tr-TR',
          expectedCurrency: 'TRY',
          css: { selector: '.plan .price' },
        },
      },
    },
    {
      id: 'svc-b',
      regions: {
        tr: {
          url: 'https://b.example/fiyat',
          locale: 'tr-TR',
          expectedCurrency: 'TRY',
          css: { selector: '.price' },
        },
        us: {
          url: 'https://b.example/pricing',
          locale: 'en-US',
          expectedCurrency: 'USD',
          css: { selector: '.price' },
          enabled: false,
        },
      },
    },
  ],
};

test('DoD: bir servis kırılınca diğerleri ETKİLENMEZ; hata rapora düşer', async () => {
  const fetcher = async (url) => {
    if (url.startsWith('https://a.example')) return cssPage;
    throw new Error('HTTP 403 — bot koruması');
  };
  const { scraped, failures, attempted } = await runScrape(catalog, config, fetcher);
  assert.equal(attempted, 2); // us enabled:false sayılmaz
  assert.equal(scraped.length, 1);
  assert.equal(scraped[0].id, 'svc-a');
  assert.equal(scraped[0].minorUnits, 129999);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, 'svc-b');
  assert.match(failures[0].error, /403/);
});

test('expectedRange dışı okuma diff\'e giremez, hata olarak rapora düşer', async () => {
  const cfg = structuredClone(config);
  cfg.services[0].regions.tr.expectedRange = [200000, 400000]; // sayfa 129999 okuyacak
  const fetcher = async () => cssPage;
  const { scraped, failures } = await runScrape(catalog, cfg, fetcher);
  assert.equal(scraped.filter((s) => s.id === 'svc-a').length, 0);
  const f = failures.find((x) => x.id === 'svc-a');
  assert.match(f.error, /aralık dışı/);
});

test('rc.fetch bölge-bazlı retry/backoff fetcher\'a aynen geçer (amazon 429)', async () => {
  const cfg = structuredClone(config);
  cfg.services[0].regions.tr.fetch = { retries: 3, retryDelayMs: 20000 };
  const seen = [];
  const fetcher = async (url, opts) => {
    seen.push({ url, opts });
    return cssPage;
  };
  await runScrape(catalog, cfg, fetcher);
  const a = seen.find((c) => c.url.startsWith('https://a.example'));
  assert.equal(a.opts.retries, 3);
  assert.equal(a.opts.retryDelayMs, 20000);
  assert.equal(a.opts.acceptLanguage, 'tr-TR,tr;q=0.9');
  // fetch aşımı olmayan bölge varsayılanlarla gider (opts'ta retry alanı yok).
  const b = seen.find((c) => c.url.startsWith('https://b.example'));
  assert.equal(b.opts.retries, undefined);
});

test('enabled:false bölgeler hiç denenmez', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return cssPage;
  };
  await runScrape(catalog, config, fetcher);
  assert.equal(calls, 2);
});

test('DoD (sahte değişiklik provası): scrape→diff→PR gövdesi zinciri uçtan uca', async () => {
  const fetcher = async () => cssPage; // her servis ₺1.299,99 okur
  const { scraped, failures, attempted } = await runScrape(catalog, config, fetcher);
  const diff = computeDiff(catalog, scraped);
  // svc-a: 119999→129999 = %8.3 normal update; svc-b: 5999→129999 = 21x karantina.
  assert.equal(diff.updates.length, 1);
  assert.equal(diff.quarantined.length, 1);
  const body = buildPrBody(diff, failures, { attempted, today: '2026-07-09' });
  assert.match(body, /svc-a/);
  assert.match(body, /Karantina/);
  assert.match(body, /kaynak\]\(https:\/\/a\.example\/fiyat\)/);
  assert.match(body, /%8\.3/);
});

// ---- M8b: plan-seviyesi izolasyon ----

test('M8b: kırık plan pattern\'i tabanı ve diğer planları DÜŞÜRMEZ; failures\'a plan alanıyla düşer', async () => {
  const { runScrape } = await import('../scraper/index.js');
  const html =
    '<body>Base: $9.99 / month Good: $19.99 / month</body>';
  const config = {
    services: [
      {
        id: 'netflix',
        regions: {
          us: {
            url: 'https://x',
            locale: 'en-US',
            expectedCurrency: 'USD',
            css: { selector: 'body', pattern: 'Base:\\s*(\\$[\\d.,]+)' },
            plans: {
              good: { pattern: 'Good:\\s*(\\$[\\d.,]+)', expectedRange: [1000, 3000] },
              broken: { pattern: 'YOK böyle bir metin (\\$[\\d.,]+)', expectedRange: [100, 9000] },
              'range-disi': { pattern: 'Good:\\s*(\\$[\\d.,]+)', expectedRange: [100, 200] },
            },
          },
        },
      },
    ],
  };
  const { scraped, failures } = await runScrape({ services: [] }, config, async () => html);
  assert.deepEqual(
    scraped.map((s) => [s.planId ?? 'TABAN', s.minorUnits]),
    [['TABAN', 999], ['good', 1999]],
  );
  assert.equal(failures.length, 2);
  assert.ok(failures.every((f) => f.plan));
  assert.ok(failures.some((f) => f.plan === 'range-disi' && /aralık dışı/.test(f.error)));
});

test('M8b: çapraz sanity — plan fiyatı tabanın 20x üstündeyse reddedilir', async () => {
  const { runScrape } = await import('../scraper/index.js');
  const html = '<body>Base: $1.00 / month Huge: $99.99 / month</body>';
  const config = {
    services: [
      {
        id: 'netflix',
        regions: {
          us: {
            url: 'https://x',
            locale: 'en-US',
            expectedCurrency: 'USD',
            css: { selector: 'body', pattern: 'Base:\\s*(\\$[\\d.,]+)' },
            plans: {
              huge: { pattern: 'Huge:\\s*(\\$[\\d.,]+)', expectedRange: [100, 100000] },
            },
          },
        },
      },
    ],
  };
  const { scraped, failures } = await runScrape({ services: [] }, config, async () => html);
  assert.equal(scraped.length, 1); // yalnız taban
  assert.ok(failures.some((f) => f.plan === 'huge' && /çapraz sanity/.test(f.error)));
});
