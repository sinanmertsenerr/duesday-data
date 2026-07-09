import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MoneyParseError,
  formatMoney,
  parseJsonLdPrice,
  parseMoney,
} from '../scraper/lib/money.js';

test('TR formatı: ₺1.299,99 → 129999 (nokta binlik, virgül ondalık)', () => {
  assert.equal(parseMoney('₺1.299,99', 'tr-TR'), 129999);
  assert.equal(parseMoney('1.299,99 TL', 'tr-TR'), 129999);
  assert.equal(parseMoney('229,99 TL', 'tr-TR'), 22999);
  assert.equal(parseMoney('₺57,99/ay', 'tr-TR'), 5799);
});

test('US formatı: $12.34 → 1234 (virgül binlik, nokta ondalık)', () => {
  assert.equal(parseMoney('$12.34', 'en-US'), 1234);
  assert.equal(parseMoney('$1,299.99', 'en-US'), 129999);
  assert.equal(parseMoney('15.49 USD', 'en-US'), 1549);
});

test('ondalıksız fiyat: ₺200 → 20000', () => {
  assert.equal(parseMoney('₺200', 'tr-TR'), 20000);
  assert.equal(parseMoney('$5', 'en-US'), 500);
});

test('tek haneli ondalık: 9,9 TL → 990', () => {
  assert.equal(parseMoney('9,9 TL', 'tr-TR'), 990);
});

test('yanlış locale karışması: en-US kuralıyla "1.299" binlik değil ondalık-3-hane → tam sayı okunur', () => {
  // "1.299" en-US'te 3 haneli ondalık = aslında binlik ayraçlı TR sayısı;
  // 1.299 → 129900 gibi 100x hata YERİNE 1299 tam okunur (3+ hane ondalık
  // sayılmaz kuralı). 1299.00$ makul olmadığından aralık/sanity katmanı yakalar.
  assert.equal(parseMoney('1.299', 'en-US'), 129900);
});

test('teaser kalıpları reddedilir (başlayan/starting/from)', () => {
  assert.throws(() => parseMoney("₺99,99'dan başlayan fiyatlarla", 'tr-TR'), MoneyParseError);
  assert.throws(() => parseMoney('starting at $9.99', 'en-US'), MoneyParseError);
  assert.throws(() => parseMoney('from $5.99/mo', 'en-US'), MoneyParseError);
});

test('sıfır, negatif, boş, rakamsız → hata (asla yayınlanmaz)', () => {
  assert.throws(() => parseMoney('₺0,00', 'tr-TR'), MoneyParseError);
  assert.throws(() => parseMoney('', 'tr-TR'), MoneyParseError);
  assert.throws(() => parseMoney('ücretsiz', 'tr-TR'), MoneyParseError);
  assert.throws(() => parseMoney('N/A', 'en-US'), MoneyParseError);
});

test('sonuç her zaman int — float sızması imkânsız', () => {
  // 19.99*100 = 1998.9999... klasik float tuzağı; string aritmetiği bunu aşar.
  const v = parseMoney('$19.99', 'en-US');
  assert.equal(v, 1999);
  assert.ok(Number.isInteger(v));
});

test('JSON-LD fiyatı: "17.99" ve 17.99 → 1799; geçersizler hata', () => {
  assert.equal(parseJsonLdPrice('17.99'), 1799);
  assert.equal(parseJsonLdPrice(17.99), 1799);
  assert.equal(parseJsonLdPrice('200'), 20000);
  assert.throws(() => parseJsonLdPrice('17,99'), MoneyParseError);
  assert.throws(() => parseJsonLdPrice('0'), MoneyParseError);
  assert.throws(() => parseJsonLdPrice(''), MoneyParseError);
});

test('formatMoney insan-okur (yalnız PR gövdesi)', () => {
  assert.match(formatMoney(129999, 'TRY'), /1\.299,99/);
  assert.match(formatMoney(1234, 'USD'), /12\.34/);
});
