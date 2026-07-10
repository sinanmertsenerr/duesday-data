import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { validateCatalog, validateHistory } from '../scraper/lib/validate.js';

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const base = () => ({
  schemaVersion: 1,
  generatedAt: '2026-07-09',
  services: [
    {
      id: 'netflix',
      name: 'Netflix',
      category: 'streaming',
      brandColor: '#E50914',
      prices: { tr: { minorUnits: 22999, currency: 'TRY' } },
    },
  ],
});

test('repodaki gerçek catalog.json validasyondan geçiyor', () => {
  const catalog = JSON.parse(readFileSync(join(repoDir, 'catalog.json'), 'utf8'));
  assert.deepEqual(validateCatalog(catalog), []);
});

test('geçerli minimal katalog: hata yok', () => {
  assert.deepEqual(validateCatalog(base()), []);
});

test('schemaVersion != 1 reddedilir (app tüm kataloğu reddeder)', () => {
  const c = base();
  c.schemaVersion = 2;
  assert.ok(validateCatalog(c).some((e) => e.includes('schemaVersion')));
});

test('id/name/category eksikse isimli hata (app sessizce düşürürdü)', () => {
  const c = base();
  c.services[0].name = '';
  assert.ok(validateCatalog(c).some((e) => e.includes('name')));
});

test('float minorUnits reddedilir (app sessiz veri kaybı yaşardı)', () => {
  const c = base();
  c.services[0].prices.tr.minorUnits = 22999.5;
  assert.ok(validateCatalog(c).some((e) => e.includes('int değil')));
});

test('sıfır/negatif/aşırı minorUnits reddedilir', () => {
  for (const bad of [0, -100, 999_999_999]) {
    const c = base();
    c.services[0].prices.tr.minorUnits = bad;
    assert.ok(validateCatalog(c).some((e) => e.includes('aralık dışı')), String(bad));
  }
});

test('bölge-kur tutarsızlığı reddedilir: tr bölgesine USD yazılamaz', () => {
  const c = base();
  c.services[0].prices.tr.currency = 'USD';
  assert.ok(validateCatalog(c).some((e) => e.includes('beklenen')));
});

test('bilinmeyen bölge reddedilir', () => {
  const c = base();
  c.services[0].prices.de = { minorUnits: 999, currency: 'EUR' };
  assert.ok(validateCatalog(c).some((e) => e.includes('bilinmeyen bölge')));
});

test('id tekrarları reddedilir', () => {
  const c = base();
  c.services.push({ ...c.services[0] });
  assert.ok(validateCatalog(c).some((e) => e.includes('tekrar')));
});

test('bilinmeyen ek alan serbest (forward-compat, app yok sayar)', () => {
  const c = base();
  c.services[0].sourceUrl = 'https://example.com';
  c.extraTopLevel = true;
  assert.deepEqual(validateCatalog(c), []);
});

test('history: geçerli/geçersiz şema', () => {
  const good = {
    schemaVersion: 1,
    generatedAt: '2026-07-09',
    series: {
      netflix: {
        tr: [
          { date: '2026-01-01', minorUnits: 18999, currency: 'TRY' },
          { date: '2026-07-01', minorUnits: 22999, currency: 'TRY' },
        ],
      },
    },
  };
  assert.deepEqual(validateHistory(good), []);

  const badOrder = structuredClone(good);
  badOrder.series.netflix.tr.reverse();
  assert.ok(validateHistory(badOrder).some((e) => e.includes('artan sırada')));

  const badCurrency = structuredClone(good);
  badCurrency.series.netflix.tr[0].currency = 'USD';
  assert.ok(validateHistory(badCurrency).length > 0);
});

// ---- plans validasyonu (M8a) ----

const withPlan = (plan) => {
  const c = base();
  c.services[0].plans = [plan];
  return c;
};

const validPlan = () => ({
  id: 'temel',
  name: 'Temel',
  prices: { tr: { minorUnits: 18999, currency: 'TRY' } },
});

test('plans: geçerli plan hata üretmez; boş dizi kabul edilir', () => {
  assert.deepEqual(validateCatalog(withPlan(validPlan())), []);
  const c = base();
  c.services[0].plans = [];
  assert.deepEqual(validateCatalog(c), []);
});

test('plans: dizi değilse reddedilir', () => {
  const c = base();
  c.services[0].plans = { id: 'x' };
  assert.ok(validateCatalog(c).some((e) => e.includes('plans dizi değil')));
});

test('plans: boş/eksik id reddedilir', () => {
  assert.ok(
    validateCatalog(withPlan({ ...validPlan(), id: '' }))
      .some((e) => e.includes('id zorunlu')),
  );
});

test("plans: custom id REZERVE (app sentinel'i), reddedilir", () => {
  assert.ok(
    validateCatalog(withPlan({ ...validPlan(), id: 'custom' }))
      .some((e) => e.includes('REZERVE')),
  );
});

test('plans: kebab-case olmayan id reddedilir', () => {
  assert.ok(
    validateCatalog(withPlan({ ...validPlan(), id: 'Max 20x' }))
      .some((e) => e.includes('kebab-case')),
  );
});

test('plans: id serviste tekrar ederse reddedilir', () => {
  const c = base();
  c.services[0].plans = [validPlan(), validPlan()];
  assert.ok(validateCatalog(c).some((e) => e.includes('tekrar ediyor')));
});

test('plans: name eksikse reddedilir', () => {
  assert.ok(
    validateCatalog(withPlan({ ...validPlan(), name: ' ' }))
      .some((e) => e.includes('name zorunlu')),
  );
});

test('plans: fiyatsız plan reddedilir (app zaten atıyordu)', () => {
  assert.ok(
    validateCatalog(withPlan({ ...validPlan(), prices: {} }))
      .some((e) => e.includes('fiyatsız plan')),
  );
});

test('plans: prices base ile AYNI kurallara tabi (kur/int/aralık)', () => {
  assert.ok(
    validateCatalog(
      withPlan({ ...validPlan(), prices: { tr: { minorUnits: 18999, currency: 'USD' } } }),
    ).some((e) => e.includes("currency 'USD'")),
  );
  assert.ok(
    validateCatalog(
      withPlan({ ...validPlan(), prices: { tr: { minorUnits: 189.99, currency: 'TRY' } } }),
    ).some((e) => e.includes('int değil')),
  );
  assert.ok(
    validateCatalog(
      withPlan({ ...validPlan(), prices: { xx: { minorUnits: 100, currency: 'TRY' } } }),
    ).some((e) => e.includes("bilinmeyen bölge 'xx'")),
  );
});
