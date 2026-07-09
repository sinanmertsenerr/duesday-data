import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyUpdates,
  buildChangesArtifact,
  computeDiff,
} from '../scraper/lib/diff.js';

const catalog = () => ({
  schemaVersion: 1,
  generatedAt: '2026-07-01',
  services: [
    {
      id: 'netflix',
      name: 'Netflix',
      category: 'streaming',
      prices: {
        tr: { minorUnits: 22999, currency: 'TRY' },
        us: { minorUnits: 1549, currency: 'USD' },
      },
    },
    {
      id: 'spotify',
      name: 'Spotify',
      category: 'music',
      prices: { tr: { minorUnits: 5999, currency: 'TRY' } },
    },
    {
      id: 'exxen',
      name: 'Exxen',
      category: 'streaming',
      prices: { tr: { minorUnits: 13000, currency: 'TRY' } },
    },
    {
      id: 'mubi',
      name: 'MUBI',
      category: 'streaming',
      prices: { tr: { minorUnits: 19900, currency: 'TRY' } },
    },
    {
      id: 'tod',
      name: 'TOD',
      category: 'streaming',
      prices: { tr: { minorUnits: 24900, currency: 'TRY' } },
    },
  ],
});

const item = (id, region, minorUnits, currency = 'TRY') => ({
  id,
  region,
  minorUnits,
  currency,
  sourceUrl: `https://example.com/${id}`,
});

test('normal zam update olur, % hesabı doğru', () => {
  const d = computeDiff(catalog(), [item('netflix', 'tr', 26999)]);
  assert.equal(d.updates.length, 1);
  assert.equal(d.updates[0].oldMinorUnits, 22999);
  assert.equal(d.updates[0].pctChange, 17.4);
  assert.equal(d.quarantined.length, 0);
});

test('sanity ÜST eşik: 4x üstü artış karantinaya (DoD)', () => {
  const d = computeDiff(catalog(), [item('netflix', 'tr', 22999 * 5)]);
  assert.equal(d.updates.length, 0);
  assert.equal(d.quarantined.length, 1);
  assert.match(d.quarantined[0].reason, /sapma/);
});

test('sanity ALT eşik: %60 üstü düşüş de karantinaya (format hatası sinyali)', () => {
  const d = computeDiff(catalog(), [item('netflix', 'tr', 2299)]);
  assert.equal(d.updates.length, 0);
  assert.equal(d.quarantined.length, 1);
});

test('eşik SINIRLARI: tam 4.0x ve tam 0.4x karantinaya GİRMEZ (> / < katı)', () => {
  const up = computeDiff(catalog(), [item('spotify', 'tr', 5999 * 4)]);
  assert.equal(up.updates.length, 1);
  const down = computeDiff(catalog(), [item('exxen', 'tr', 5200)]);
  assert.equal(down.updates.length, 1);
});

test('kur değişimi karantinaya (tr bölgesine USD gelemez)', () => {
  const d = computeDiff(catalog(), [item('netflix', 'tr', 999, 'USD')]);
  assert.equal(d.quarantined.length, 1);
  assert.match(d.quarantined[0].reason, /kur değişimi/);
});

test('katalogda olmayan id karantinaya — scraper id üretemez', () => {
  const d = computeDiff(catalog(), [item('yeni-servis', 'tr', 9999)]);
  assert.equal(d.quarantined.length, 1);
  assert.match(d.quarantined[0].reason, /olmayan id/);
});

test('yeni bölge otomatik akışa girmez, ayrı listelenir', () => {
  const d = computeDiff(catalog(), [item('spotify', 'us', 1199, 'USD')]);
  assert.equal(d.updates.length, 0);
  assert.equal(d.newRegions.length, 1);
});

test('aynı fiyat ve gürültü (<%0.5) değişiklik sayılmaz', () => {
  const d = computeDiff(catalog(), [
    item('netflix', 'tr', 22999),
    item('spotify', 'tr', 6009), // %0.17 — gürültü
  ]);
  assert.equal(d.updates.length, 0);
  assert.equal(d.unchanged, 2);
});

test('koşu anomalisi: örneklerin >%50si değiştiyse runAnomaly=true', () => {
  const d = computeDiff(catalog(), [
    item('netflix', 'tr', 25999),
    item('spotify', 'tr', 7999),
    item('exxen', 'tr', 16000),
    item('mubi', 'tr', 19900), // değişmedi
  ]);
  assert.equal(d.updates.length, 3);
  assert.equal(d.runAnomaly, true);
});

test('koşu anomalisi az örnekte tetiklenmez (min 4 örnek)', () => {
  const d = computeDiff(catalog(), [
    item('netflix', 'tr', 25999),
    item('spotify', 'tr', 7999),
  ]);
  assert.equal(d.runAnomaly, false);
});

test('applyUpdates: girdi mutate edilmez, sıra korunur, generatedAt güncellenir', () => {
  const cat = catalog();
  const d = computeDiff(cat, [item('spotify', 'tr', 7999)]);
  const next = applyUpdates(cat, d.updates, '2026-07-09');
  assert.equal(cat.services[1].prices.tr.minorUnits, 5999); // orijinal aynı
  assert.equal(next.services[1].prices.tr.minorUnits, 7999);
  assert.equal(next.generatedAt, '2026-07-09');
  assert.deepEqual(
    next.services.map((s) => s.id),
    cat.services.map((s) => s.id),
  );
  // Dokunulmayan servis objesi referans-eşit (temiz diff garantisi).
  assert.equal(next.services[0], cat.services[0]);
});

test('update yoksa applyUpdates aynı objeyi döner (no-op koşuda dosyaya dokunulmaz)', () => {
  const cat = catalog();
  assert.equal(applyUpdates(cat, [], '2026-07-09'), cat);
});

test('changes artefaktı (M6 kancası) şema-tam', () => {
  const d = computeDiff(catalog(), [item('netflix', 'tr', 26999)]);
  const artifact = buildChangesArtifact(d.updates, '2026-07-09');
  assert.deepEqual(artifact, {
    schemaVersion: 1,
    changedAt: '2026-07-09',
    changes: [
      {
        id: 'netflix',
        region: 'tr',
        oldMinorUnits: 22999,
        newMinorUnits: 26999,
        currency: 'TRY',
        sourceUrl: 'https://example.com/netflix',
      },
    ],
  });
});
