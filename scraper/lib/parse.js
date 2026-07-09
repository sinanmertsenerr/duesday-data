// HTML → fiyat çıkarımı. Sıra: JSON-LD (schema.org Offer) → CSS selector +
// regex fallback (research §3: JSON-LD tasarım değişikliklerinden CSS'ten
// çok daha az etkilenir). Her sonuç beklenen kur ile ÇAPRAZ doğrulanır —
// bölgesel yönlendirme yanlış sayfanın fiyatını getirirse reddedilir
// (impact: failure-modes §1.3).

import * as cheerio from 'cheerio';

import {
  MoneyParseError,
  containsTeaser,
  parseJsonLdPrice,
  parseMoney,
} from './money.js';

export class ExtractError extends Error {}

const CURRENCY_MARKERS = {
  TRY: /₺|\bTL\b|\bTRY\b/i,
  USD: /\$|\bUSD\b/,
};

function* iterateJsonLdOffers(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* iterateJsonLdOffers(item);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('Offer') && node.price !== undefined) yield node;
  for (const value of Object.values(node)) yield* iterateJsonLdOffers(value);
}

/** JSON-LD script'lerinden beklenen kurla eşleşen ilk Offer fiyatı. */
export function extractFromJsonLd(html, expectedCurrency) {
  const $ = cheerio.load(html);
  const errors = [];
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let data;
    try {
      data = JSON.parse($(el).text());
    } catch {
      continue; // bozuk JSON-LD bloğu — diğerlerine bak
    }
    for (const offer of iterateJsonLdOffers(data)) {
      if (offer.priceCurrency !== expectedCurrency) continue;
      try {
        return parseJsonLdPrice(offer.price);
      } catch (e) {
        if (e instanceof MoneyParseError) errors.push(e.message);
        else throw e;
      }
    }
  }
  throw new ExtractError(
    `JSON-LD'de ${expectedCurrency} Offer yok` +
      (errors.length ? ` (parse hataları: ${errors.join('; ')})` : ''),
  );
}

/** CSS selector + opsiyonel regex ile fiyat metni çıkar. */
export function extractFromCss(html, { selector, pattern }, locale, expectedCurrency) {
  const $ = cheerio.load(html);
  const el = $(selector).first();
  if (el.length === 0) {
    throw new ExtractError(`selector eşleşmedi: ${selector}`);
  }
  let text = el.text().trim();
  if (pattern) {
    const m = text.match(new RegExp(pattern));
    if (!m) throw new ExtractError(`pattern eşleşmedi: '${text.slice(0, 80)}'`);
    text = m[m.length > 1 ? 1 : 0];
  } else {
    // Pattern'sız kullanımda element birden fazla fiyat içeriyorsa (üstü
    // çizili eski fiyat + indirimli yeni fiyat gibi) rakamlar birbirine
    // yapışıp "geçerli görünen" saçma bir sayı üretir — yüksek sesle reddet.
    const markers = text.match(/[₺$]|\bTL\b|\bUSD\b/gi) ?? [];
    if (markers.length > 1) {
      throw new ExtractError(
        `birden fazla fiyat işareti — pattern zorunlu: '${text.slice(0, 80)}'`,
      );
    }
  }
  if (containsTeaser(text)) {
    throw new ExtractError(`teaser metni: '${text.slice(0, 80)}'`);
  }
  // Çapraz kur doğrulaması: TR fiyatı bekliyorsak metinde ₺/TL izi olmalı —
  // consent duvarı / yanlış bölge sayfası burada yakalanır.
  if (!CURRENCY_MARKERS[expectedCurrency].test(text)) {
    throw new ExtractError(
      `beklenen kur işareti (${expectedCurrency}) yok: '${text.slice(0, 80)}'`,
    );
  }
  return parseMoney(text, locale);
}

/**
 * Bir servis-bölge config'i için fiyat çıkar.
 * @returns {number} int minör birim
 * @throws {ExtractError|MoneyParseError} — çağıran servis-bazlı izole eder.
 */
export function extractPrice(html, regionConfig) {
  const { locale, expectedCurrency, css } = regionConfig;
  const attempts = [];
  if (regionConfig.jsonLd !== false) {
    try {
      return extractFromJsonLd(html, expectedCurrency);
    } catch (e) {
      if (!(e instanceof ExtractError)) throw e;
      attempts.push(`json-ld: ${e.message}`);
    }
  }
  if (css) {
    try {
      return extractFromCss(html, css, locale, expectedCurrency);
    } catch (e) {
      if (!(e instanceof ExtractError) && !(e instanceof MoneyParseError)) throw e;
      attempts.push(`css: ${e.message}`);
    }
  }
  throw new ExtractError(attempts.join(' | ') || 'çıkarım stratejisi tanımsız');
}
