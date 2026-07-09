// Fiyat string'i → int minör birim (kuruş/cent).
// Anayasa §10: parayla float YASAK — ondalık kısım string olarak işlenir,
// hiçbir ara adımda kayan nokta aritmetiği yok (impact: failure-modes §4.2).

const LOCALES = {
  'tr-TR': { thousand: '.', decimal: ',' },
  'en-US': { thousand: ',', decimal: '.' },
};

// "başlayan fiyat" / kampanya kalıpları: bu metinler kalıcı liste fiyatı
// değil pazarlama teaser'ıdır — parse edilirse yanlış-pozitif üretir
// (research §5; storytel 'İlk 4 Ay ₺164,99' vakası 2026-07-09).
// NOT: JS /i bayrağı 'İ' (U+0130) ↔ 'i' eşleşmesi YAPMAZ (Türkçe İ tuzağı)
// — 'İlk/İLK' için karakter sınıfı şart.
const TEASER_PATTERN =
  /(başlayan|[iİ]t[iİ]baren|starting|starts at|\bfrom\b|as low as|[iİ]lk\s+\d+\s+(ay|hafta|gün)|öğrenc[iİ]|[iİ]nd[iİ]r[iİ]m|kampanya|deneme|first\s+\d+\s+(month|week)s?|\btrial\b|\bpromo)/i;

export class MoneyParseError extends Error {}

export function containsTeaser(text) {
  return TEASER_PATTERN.test(text);
}

/** Teaser eşleşmesinin konumu (yoksa -1) — bağlam analizi için. */
export function findTeaserIndex(text) {
  const m = text.match(TEASER_PATTERN);
  return m?.index ?? -1;
}

/**
 * "₺1.299,99", "1.299,99 TL", "$12.34" → int minör birim.
 * @param {string} raw fiyat metni (para simgesi/etiketi içerebilir)
 * @param {string} locale 'tr-TR' | 'en-US' — servis config'inde SABİT;
 *   kaynaktan tahmin yasak (impact: failure-modes §1.6).
 * @returns {number} int minör birim, her zaman > 0
 */
export function parseMoney(raw, locale) {
  const rules = LOCALES[locale];
  if (!rules) throw new MoneyParseError(`bilinmeyen locale: ${locale}`);
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new MoneyParseError('boş fiyat metni');
  }
  if (containsTeaser(raw)) {
    throw new MoneyParseError(`teaser kalıbı içeriyor: ${raw.trim()}`);
  }

  // Rakam ve ayraçlar dışındaki her şeyi (₺, $, TL, NBSP, boşluk) at.
  const cleaned = raw.replace(/[^\d.,]/g, '');
  if (!/\d/.test(cleaned)) {
    throw new MoneyParseError(`rakam bulunamadı: ${raw.trim()}`);
  }

  let digits;
  let fractionPart = '';
  const decIdx = cleaned.lastIndexOf(rules.decimal);
  const after = decIdx === -1 ? null : cleaned.slice(decIdx + 1);
  if (after !== null && /^\d{1,2}$/.test(after)) {
    fractionPart = after;
    // Binlik ayraçları temizle; kalan her karakter rakam olmak zorunda.
    digits = cleaned.slice(0, decIdx).split(rules.thousand).join('');
  } else {
    // Ondalık kısım yok ya da 3+ rakam: 3+ rakamlı "ondalık" aslında binlik
    // gruptur (ör. en-US kuralıyla gelen "1.299") — tüm ayraçlar temizlenir,
    // sayı tam okunur; olası yanlış-okuma sanity katmanına takılır.
    digits = cleaned.replace(/[.,]/g, '');
  }
  if (!/^\d+$/.test(digits)) {
    throw new MoneyParseError(`parse edilemeyen fiyat: ${raw.trim()}`);
  }

  // Tam sayı aritmetiği: Number(digits)*100 yerine string birleştirme —
  // float çarpımı yok. padEnd ile "9" → "90" (0.9 → 90 minör).
  const minor = Number(digits + fractionPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyParseError(`güvenli tamsayı aralığı dışında: ${raw.trim()}`);
  }
  if (minor <= 0) {
    // 0 fiyat app'te teknik olarak geçer ama neredeyse kesin scrape
    // hatasıdır — asla yayınlanmaz (impact: contract-walk kural 3).
    throw new MoneyParseError(`sıfır/negatif fiyat: ${raw.trim()}`);
  }
  return minor;
}

/**
 * JSON-LD `Offer.price` değeri → int minör birim. JSON-LD spec'inde ondalık
 * her zaman nokta ("17.99") — locale yok. Sayı gelirse string'e çevrilir
 * ama float aritmetiğine sokulmaz.
 */
export function parseJsonLdPrice(price) {
  const s = typeof price === 'number' ? String(price) : price;
  if (typeof s !== 'string' || !/^\d+(\.\d{1,2})?$/.test(s.trim())) {
    throw new MoneyParseError(`geçersiz JSON-LD fiyatı: ${price}`);
  }
  const [int, frac = ''] = s.trim().split('.');
  const minor = Number(int + frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new MoneyParseError(`geçersiz JSON-LD fiyatı: ${price}`);
  }
  return minor;
}

/** İnsan-okur biçim (yalnız PR gövdesi için — asla veri yoluna girmez). */
export function formatMoney(minorUnits, currency) {
  const locale = currency === 'TRY' ? 'tr-TR' : 'en-US';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(minorUnits / 100);
}
