import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  ExtractError,
  extractFromCss,
  extractFromJsonLd,
  extractPrice,
} from '../scraper/lib/parse.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => readFileSync(join(fixturesDir, name), 'utf8');

test('JSON-LD: beklenen kurun Offer fiyatı çekilir', () => {
  const html = fixture('jsonld-page.html');
  assert.equal(extractFromJsonLd(html, 'TRY'), 5799);
  assert.equal(extractFromJsonLd(html, 'USD'), 1099);
});

test('JSON-LD: kur eşleşmezse ExtractError (çapraz kur doğrulaması)', () => {
  assert.throws(() => extractFromJsonLd(fixture('jsonld-page.html'), 'EUR'), ExtractError);
});

test('CSS fallback: ilk eşleşen selector + locale parse', () => {
  const price = extractFromCss(
    fixture('css-page.html'),
    { selector: '.plan .price' },
    'tr-TR',
    'TRY',
  );
  assert.equal(price, 129999);
});

test('CSS + pattern: metin içinden regex grubu çekilir', () => {
  const price = extractFromCss(
    fixture('css-page.html'),
    { selector: 'main', pattern: 'Aile[\\s\\S]*?(₺[\\d.,]+)' },
    'tr-TR',
    'TRY',
  );
  assert.equal(price, 199999);
});

test('consent duvarı: kur işareti yok → ExtractError, asla 0/yanlış fiyat değil', () => {
  assert.throws(
    () =>
      extractFromCss(fixture('consent-wall.html'), { selector: '.price' }, 'tr-TR', 'TRY'),
    ExtractError,
  );
});

test('teaser sayfası: "başlayan fiyatlarla" reddedilir', () => {
  assert.throws(
    () =>
      extractFromCss(fixture('teaser-page.html'), { selector: '.price' }, 'tr-TR', 'TRY'),
    ExtractError,
  );
});

test('selector eşleşmezse ExtractError (kırık selector = izole hata)', () => {
  assert.throws(
    () => extractFromCss('<html><body></body></html>', { selector: '.yok' }, 'tr-TR', 'TRY'),
    ExtractError,
  );
});

test('extractPrice: JSON-LD öncelikli, yoksa CSS fallback', () => {
  const rc = {
    locale: 'tr-TR',
    expectedCurrency: 'TRY',
    css: { selector: '.plan .price' },
  };
  // JSON-LD'li sayfada JSON-LD kazanır (5799), CSS'e hiç düşmez.
  assert.equal(extractPrice(fixture('jsonld-page.html'), rc), 5799);
  // JSON-LD'siz sayfada CSS fallback (129999).
  assert.equal(extractPrice(fixture('css-page.html'), rc), 129999);
});

test('extractPrice: iki strateji de başarısızsa birleşik hata mesajı', () => {
  const rc = { locale: 'tr-TR', expectedCurrency: 'TRY', css: { selector: '.yok' } };
  assert.throws(
    () => extractPrice(fixture('consent-wall.html'), rc),
    (e) => e instanceof ExtractError && /json-ld/.test(e.message) && /css/.test(e.message),
  );
});
