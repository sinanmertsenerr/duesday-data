// HTML → fiyat çıkarımı. Sıra: JSON-LD (schema.org Offer) → CSS selector +
// regex fallback (research §3: JSON-LD tasarım değişikliklerinden CSS'ten
// çok daha az etkilenir). Her sonuç beklenen kur ile ÇAPRAZ doğrulanır —
// bölgesel yönlendirme yanlış sayfanın fiyatını getirirse reddedilir
// (impact: failure-modes §1.3).

import * as cheerio from 'cheerio';

import {
  MoneyParseError,
  containsTeaser,
  findTeaserIndex,
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

// Eşleşme çevresinde teaser/kampanya araması için pencere (karakter).
// Yakalanan grup çoğu zaman salt "₺164,99" olur — kampanya kelimesi
// ("İlk 4 Ay") hemen yanındadır ama grubun içinde değildir (storytel vakası).
const TEASER_CONTEXT_WINDOW = 80;
const MAX_ELEMENT_ATTEMPTS = 8;
// Fiyat-tek elementler ("₺164,99") bağlamı EBEVEYNİNDE taşır — kampanya
// rozeti kardeş elementtedir (storytel PR #3 vakası).
const SHORT_ELEMENT_THRESHOLD = 60;
const PARENT_CONTEXT_WINDOW = 140;

/**
 * Bağlamda teaser var mı? İSTİSNA: teaser ile fiyat arasında
 * 'sonra/then/after' varsa bu deneme-SONRASI gerçek liste fiyatıdır
 * ("İlk 30 günden sonra Prime sadece 69,90₺" — amazon vakası), teaser değil.
 */
function isTeaserContext(context, priceIdx) {
  const t = findTeaserIndex(context);
  if (t === -1) return false;
  if (t < priceIdx) {
    const between = context.slice(t, priceIdx);
    // 'İlk 30 günden SONRA 69,90₺' → deneme-sonrası gerçek fiyat.
    if (/(sonra|then|after)/i.test(between)) return false;
    // Teaser ile bizim fiyat arasında BAŞKA bir fiyat varsa teaser ona
    // aittir ('İLK 4 AY ₺164,99 ... ₺329.99' — 329.99 temiz).
    if (/[₺$]|\bTL\b|\bUSD\b/i.test(between)) return false;
  }
  return true;
}

function extractFromElementText(fullText, pattern, locale, expectedCurrency) {
  let text = fullText.trim();
  let matchIndex = 0;
  if (pattern) {
    const m = text.match(new RegExp(pattern));
    if (!m) throw new ExtractError(`pattern eşleşmedi: '${text.slice(0, 80)}'`);
    matchIndex = m.index ?? 0;
    text = m[m.length > 1 ? 1 : 0];
  } else {
    // Pattern'sız kullanımda element birden fazla fiyat içeriyorsa (üstü
    // çizili eski fiyat + indirimli yeni fiyat gibi) rakamlar birbirine
    // yapışıp "geçerli görünen" saçma bir sayı üretir — yüksek sesle reddet.
    const markers = fullText.match(/[₺$]|\bTL\b|\bUSD\b/gi) ?? [];
    if (markers.length > 1) {
      throw new ExtractError(
        `birden fazla fiyat işareti — pattern zorunlu: '${fullText.slice(0, 80)}'`,
      );
    }
  }
  // Teaser kontrolü hem yakalanan metinde hem eşleşmenin BAĞLAMINDA:
  // kampanya kelimesi fiyatın yanında durur, grubun içinde değil.
  const contextStart = Math.max(0, matchIndex - TEASER_CONTEXT_WINDOW);
  const context = fullText.slice(
    contextStart,
    matchIndex + text.length + TEASER_CONTEXT_WINDOW,
  );
  if (containsTeaser(text) || isTeaserContext(context, matchIndex - contextStart)) {
    throw new ExtractError(`teaser/kampanya bağlamı: '${context.trim().slice(0, 80)}'`);
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
 * CSS selector + opsiyonel regex ile fiyat çıkar. Selector birden çok
 * elemente eşleşirse ilk TEMİZ geçen kazanır: promosyon kartı öne
 * geçtiğinde (teaser bağlamıyla reddedilir) sıradaki gerçek fiyat kartı
 * denenir — koşudan koşuya element sırası değişse de sonuç kararlı kalır.
 */
export function extractFromCss(html, { selector, pattern }, locale, expectedCurrency) {
  const $ = cheerio.load(html);
  const els = $(selector).toArray().slice(0, MAX_ELEMENT_ATTEMPTS);
  if (els.length === 0) {
    throw new ExtractError(`selector eşleşmedi: ${selector}`);
  }
  const errors = [];
  for (const el of els) {
    try {
      const elementText = $(el).text();
      // Kısa (fiyat-tek) elementte kampanya rozeti KARDEŞ elementtedir —
      // ebeveyn metninde, fiyatın çevresindeki pencerede teaser ara.
      if (elementText.trim().length < SHORT_ELEMENT_THRESHOLD) {
        const parentText = $(el).parent().text();
        const idx = parentText.indexOf(elementText.trim());
        if (idx !== -1) {
          const start = Math.max(0, idx - PARENT_CONTEXT_WINDOW);
          const window = parentText.slice(start, idx + PARENT_CONTEXT_WINDOW);
          if (isTeaserContext(window, idx - start)) {
            throw new ExtractError(
              `ebeveyn bağlamında kampanya: '${window.trim().slice(0, 80)}'`,
            );
          }
        }
      }
      return extractFromElementText(elementText, pattern, locale, expectedCurrency);
    } catch (e) {
      if (!(e instanceof ExtractError) && !(e instanceof MoneyParseError)) throw e;
      errors.push(e.message);
    }
  }
  throw new ExtractError(
    `${els.length} element denendi, hiçbiri geçmedi: ${errors[0]}`,
  );
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
