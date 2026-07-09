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

test('pattern\'sız + birden fazla fiyat işareti → ExtractError (rakam yapışması önlenir)', () => {
  const html =
    '<html><body><div class="p"><s>₺99,99</s> ₺79,99</div></body></html>';
  assert.throws(
    () => extractFromCss(html, { selector: '.p' }, 'tr-TR', 'TRY'),
    (e) => e instanceof ExtractError && /birden fazla/.test(e.message),
  );
});

test('kampanya BAĞLAMI reddedilir: "İlk 4 Ay ₺164,99" (grup salt fiyat olsa bile)', () => {
  const html =
    '<html><body><div class="p">İlk 4 Ay ₺164,99/ay fırsatı</div></body></html>';
  assert.throws(
    () => extractFromCss(html, { selector: '.p', pattern: '(₺[\\d.,]+)' }, 'tr-TR', 'TRY'),
    (e) => e instanceof ExtractError && /teaser|kampanya/.test(e.message),
  );
});

test('promo kart önde olsa bile sıradaki temiz element kazanır (storytel vakası)', () => {
  const html =
    '<html><body>' +
    '<div class="defaultPrice">İLK 4 AY ₺164,99/ay</div>' +
    '<div class="defaultPrice">₺329.99</div>' +
    '</body></html>';
  const price = extractFromCss(
    html,
    { selector: '[class*=defaultPrice]', pattern: '(₺[\\d.,]+)' },
    'en-US',
    'TRY',
  );
  assert.equal(price, 32999);
});

test('kampanya rozeti KARDEŞ elementteyse ebeveyn bağlamı yakalar (storytel PR #3 vakası)', () => {
  // Promo kartında fiyat elementi tek başına "₺164,99/ay" — "İLK 4 AY"
  // rozeti kardeş elementte. Sıradaki temiz kart kazanmalı.
  const html =
    '<html><body>' +
    '<div class="card"><span class="badge">İLK 4 AY</span><span class="defaultPrice">₺164,99/ay</span></div>' +
    '<div class="card"><span class="title">Sınırsız</span><span class="defaultPrice">₺329.99</span></div>' +
    '</body></html>';
  const price = extractFromCss(
    html,
    { selector: '[class*=defaultPrice]', pattern: '(₺[\\d.,]+)' },
    'en-US',
    'TRY',
  );
  assert.equal(price, 32999);
});

test("deneme-SONRASI gerçek fiyat teaser sayılmaz: 'İlk 30 günden sonra 69,90₺' (amazon vakası)", () => {
  const html =
    '<html><body><p class="p">İlk 30 günden sonra Prime sadece 69,90₺/ay. İstediğin zaman iptal edebilirsin.</p></body></html>';
  const price = extractFromCss(
    html,
    { selector: '.p', pattern: '([\\d.,]+\\s*₺)' },
    'tr-TR',
    'TRY',
  );
  assert.equal(price, 6990);
});

test("deneme-SONRASI ters sıra da teaser sayılmaz: '$14.99 per month after trial' (amazon us vakası)", () => {
  const html =
    '<html><body><div class="c">Prime Monthly$14.99per month after trial</div></body></html>';
  const price = extractFromCss(
    html,
    { selector: '.c', pattern: 'Prime Monthly(\\$[\\d.,]+)' },
    'en-US',
    'USD',
  );
  assert.equal(price, 1499);
});

test("fiyattan SONRAKİ gerçek teaser hâlâ reddedilir: '$11.99 ... Save with promo'", () => {
  const html =
    '<html><body><div class="c">Starting at $11.99/mo. Save 20% with promo bundle</div></body></html>';
  assert.throws(
    () => extractFromCss(html, { selector: '.c', pattern: '(\\$[\\d.,]+)' }, 'en-US', 'USD'),
    (e) => e instanceof ExtractError && /teaser|kampanya/.test(e.message),
  );
});

test('tüm elementler reddedilirse birleşik hata', () => {
  const html =
    '<html><body><div class="p">öğrenci indirimi ₺99</div><div class="p">deneme ₺49</div></body></html>';
  assert.throws(
    () => extractFromCss(html, { selector: '.p', pattern: '(₺[\\d.,]+)' }, 'tr-TR', 'TRY'),
    (e) => e instanceof ExtractError && /element denendi/.test(e.message),
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
