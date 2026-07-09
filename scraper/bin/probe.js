#!/usr/bin/env node
// Kalibrasyon sondası: TEK servis-bölgeyi çek, extract hattının her
// aşamasının ne gördüğünü döK. Selector kalibrasyonu kör yapılmasın diye
// var — US sayfaları TR IP'den farklı görünür (geo-IP), gerçek görüntü
// ancak CI runner'dan alınır (probe.yml ile workflow_dispatch).
// Katalog/CDN'e DOKUNMAZ; salt okuma + stdout.
//
// Kullanım: node scraper/bin/probe.js <serviceId> <region>

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';

import { fetchPage } from '../lib/fetch.js';
import { extractPrice } from '../lib/parse.js';

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXCERPT = 400; // element başına gösterilecek metin (karakter)

const [serviceId, region] = process.argv.slice(2);
if (!serviceId || !region) {
  console.error('kullanım: node scraper/bin/probe.js <serviceId> <region>');
  process.exit(2);
}

const config = JSON.parse(
  readFileSync(join(repoDir, 'scraper', 'services.config.json'), 'utf8'),
);
const service = config.services.find((s) => s.id === serviceId);
const rc = service?.regions?.[region];
if (!rc) {
  console.error(`config'te yok: ${serviceId}/${region}`);
  process.exit(2);
}

console.log(`probe: ${serviceId}/${region} → ${rc.url}`);
console.log(
  `enabled=${rc.enabled !== false} locale=${rc.locale} kur=${rc.expectedCurrency}` +
    (rc.expectedRange ? ` aralık=[${rc.expectedRange}]` : ''),
);

const html = await fetchPage(rc.url, {
  acceptLanguage: rc.locale === 'tr-TR' ? 'tr-TR,tr;q=0.9' : 'en-US,en;q=0.9',
});
console.log(`HTML: ${html.length} karakter`);

// 1) JSON-LD envanteri — hangi Offer'lar var, kurları ne?
const $ = cheerio.load(html);
const ldBlocks = $('script[type="application/ld+json"]').toArray();
console.log(`JSON-LD blok: ${ldBlocks.length}`);
for (const el of ldBlocks) {
  const raw = $(el).text();
  const offers = [...raw.matchAll(/"price(?:Currency)?"\s*:\s*"?([^",}]+)"?/g)]
    .map((m) => m[1])
    .slice(0, 12);
  if (offers.length) console.log(`  price alanları: ${offers.join(', ')}`);
}

// 2) Selector'ün gördüğü metin — pattern yazarken bakılacak ham malzeme.
if (rc.css) {
  const els = $(rc.css.selector).toArray();
  console.log(`selector '${rc.css.selector}': ${els.length} eşleşme`);
  els.slice(0, 8).forEach((el, i) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    // Fiyat işaretlerinin çevresini göster — 400 karakterlik baş kısım
    // çoğu sayfada nav/çerez metnidir, işe yaramaz.
    const markers = [...text.matchAll(/[₺$]|\bTL\b|\bUSD\b/gi)].slice(0, 6);
    console.log(`  [${i}] ${text.length} kr; baş: '${text.slice(0, EXCERPT)}'`);
    for (const m of markers) {
      const s = Math.max(0, m.index - 90);
      console.log(`      …fiyat bağlamı: '${text.slice(s, m.index + 90)}'`);
    }
  });
}

// 3) Gerçek extract hattı ne diyor?
try {
  const minorUnits = extractPrice(html, rc);
  console.log(`extractPrice: OK → ${minorUnits} (${rc.expectedCurrency} minör)`);
} catch (e) {
  console.log(`extractPrice: HATA → ${e.message}`);
}
