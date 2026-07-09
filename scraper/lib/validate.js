// Katalog şema doğrulayıcı — app'teki CatalogParser kurallarının aynası,
// artı app'in DOĞRULAMADIĞI sıkı kurallar (impact: contract-walk):
// app currency'yi yalnız length==3 ile kontrol eder, ISO whitelist ve
// bölge-kur tutarlılığı scraper'ın sorumluluğundadır.

export const SUPPORTED_SCHEMA_VERSION = 1;

// Bölge → beklenen kur. Yeni bölge eklemek bilinçli bir insan kararıdır;
// buraya eklenmeyen bölge anahtarı validasyondan geçemez.
export const REGION_CURRENCY = Object.freeze({
  tr: 'TRY',
  us: 'USD',
});

// Makul fiyat aralığı (minör birim): 1 kuruş/cent — 100.000 TL/$ üstü
// abonelik fiyatı scrape hatasıdır.
export const MINOR_UNITS_MAX = 10_000_000;

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/**
 * catalog.json objesini doğrular. Dönüş: hata mesajları listesi (boş = geçerli).
 * App'in davranışını taklit etmek yerine ondan SIKI olmak bilinçli:
 * app'in sessizce düşüreceği her kayıt burada isimli hata üretir
 * (sessiz veri kaybı yerine kırmızı CI — anayasa §9 ruhu).
 */
export function validateCatalog(catalog) {
  const errors = [];
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return ['kök obje değil'];
  }
  if (catalog.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    // schemaVersion'ı artırmak TÜM eski app sürümlerini gömülü kataloğa
    // düşürür — yalnız gerçek breaking change'de, insan kararıyla yapılır.
    errors.push(
      `schemaVersion ${catalog.schemaVersion} != ${SUPPORTED_SCHEMA_VERSION}`,
    );
  }
  if (typeof catalog.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(catalog.generatedAt)) {
    errors.push(`generatedAt YYYY-AA-GG değil: ${catalog.generatedAt}`);
  }
  if (!Array.isArray(catalog.services) || catalog.services.length === 0) {
    errors.push('services boş/eksik');
    return errors;
  }

  const seenIds = new Set();
  catalog.services.forEach((svc, i) => {
    const where = `services[${i}] (${svc?.id ?? '?'})`;
    if (svc === null || typeof svc !== 'object') {
      errors.push(`${where}: obje değil`);
      return;
    }
    // id/name/category eksikse app o servisi SESSİZCE düşürür
    // (catalog_parser.dart:54-59) — burada isimli hata.
    for (const field of ['id', 'name', 'category']) {
      if (typeof svc[field] !== 'string' || svc[field].trim() === '') {
        errors.push(`${where}: ${field} zorunlu non-empty string`);
      }
    }
    if (typeof svc.id === 'string') {
      if (!/^[a-z0-9-]+$/.test(svc.id)) {
        errors.push(`${where}: id kebab-case değil`);
      }
      if (seenIds.has(svc.id)) errors.push(`${where}: id tekrar ediyor`);
      seenIds.add(svc.id);
    }
    if (svc.brandColor !== undefined && !HEX_COLOR.test(svc.brandColor)) {
      errors.push(`${where}: brandColor #RRGGBB değil`);
    }
    if (svc.prices === undefined) return; // prices opsiyonel (app toleranslı)
    if (svc.prices === null || typeof svc.prices !== 'object' || Array.isArray(svc.prices)) {
      errors.push(`${where}: prices obje değil`);
      return;
    }
    for (const [region, price] of Object.entries(svc.prices)) {
      const expected = REGION_CURRENCY[region];
      if (!expected) {
        errors.push(`${where}: bilinmeyen bölge '${region}'`);
        continue;
      }
      if (price === null || typeof price !== 'object') {
        errors.push(`${where}.prices.${region}: obje değil`);
        continue;
      }
      // App float minorUnits'i sessizce düşürür (is! int) — sessiz veri
      // kaybı yerine burada hata (impact: failure-modes §4.2).
      if (!Number.isInteger(price.minorUnits)) {
        errors.push(`${where}.prices.${region}: minorUnits int değil`);
      } else if (price.minorUnits <= 0 || price.minorUnits > MINOR_UNITS_MAX) {
        errors.push(
          `${where}.prices.${region}: minorUnits aralık dışı (${price.minorUnits})`,
        );
      }
      if (price.currency !== expected) {
        // tr bölgesine USD yazmak TR kullanıcısına yanlış bütçe gösterir;
        // app bunu YAKALAMAZ (impact: failure-modes §4.3).
        errors.push(
          `${where}.prices.${region}: currency '${price.currency}' != beklenen '${expected}'`,
        );
      }
    }
  });
  return errors;
}

/** history.json şeması: {schemaVersion, generatedAt, series:{id:{region:[{date,minorUnits,currency}]}}} */
export function validateHistory(history) {
  const errors = [];
  if (history === null || typeof history !== 'object') return ['kök obje değil'];
  if (history.schemaVersion !== 1) errors.push('schemaVersion != 1');
  if (typeof history.generatedAt !== 'string') errors.push('generatedAt eksik');
  if (history.series === null || typeof history.series !== 'object') {
    errors.push('series obje değil');
    return errors;
  }
  for (const [id, regions] of Object.entries(history.series)) {
    for (const [region, points] of Object.entries(regions)) {
      const expected = REGION_CURRENCY[region];
      if (!expected) {
        errors.push(`${id}: bilinmeyen bölge '${region}'`);
        continue;
      }
      if (!Array.isArray(points)) {
        errors.push(`${id}.${region}: dizi değil`);
        continue;
      }
      let prevDate = '';
      for (const p of points) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p?.date ?? '')) {
          errors.push(`${id}.${region}: geçersiz tarih`);
        } else if (p.date < prevDate) {
          errors.push(`${id}.${region}: tarihler artan sırada değil`);
        } else {
          prevDate = p.date;
        }
        if (!Number.isInteger(p?.minorUnits) || p.minorUnits <= 0) {
          errors.push(`${id}.${region}: geçersiz minorUnits`);
        }
        if (p?.currency !== expected) {
          errors.push(`${id}.${region}: currency != ${expected}`);
        }
      }
    }
  }
  return errors;
}
