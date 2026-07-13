// Katalog şema doğrulayıcı — app'teki CatalogParser kurallarının aynası,
// artı app'in DOĞRULAMADIĞI sıkı kurallar (impact: contract-walk):
// app currency'yi yalnız length==3 ile kontrol eder, ISO whitelist ve
// bölge-kur tutarlılığı scraper'ın sorumluluğundadır.
//
// plans[].prices AYLIK varsayılır (app radar'ı aylık kıyaslar) — yıllık-only
// plan fiyatı GİRİLMEZ; validate bunu sayıdan YAKALAYAMAZ, insan kuralıdır
// (M8a veri girişi sözleşmesi). Plan fiyatları M8b'ye kadar manueldir;
// scraper plans'ı korur ama güncellemez (diff.js applyUpdates spread).

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
    validatePlans(where, svc.plans, errors);
    validateChannelPrices(where, svc.channelPrices, errors); // M8c servis seviyesi
    if (svc.prices === undefined) return; // prices opsiyonel (app toleranslı)
    if (svc.prices === null || typeof svc.prices !== 'object' || Array.isArray(svc.prices)) {
      errors.push(`${where}: prices obje değil`);
      return;
    }
    validatePrices(where, svc.prices, errors);
  });
  return errors;
}

// prices haritası kuralları — hem servis tabanı hem plan fiyatları için
// AYNI sözleşme (M8a impact: plans validasyonu base ile simetrik olmalı).
function validatePrices(where, prices, errors) {
  for (const [region, price] of Object.entries(prices)) {
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
}

// plans (M8a — additive): app'in sessizce düşüreceği her plan burada
// isimli hata üretir (CatalogParser._parsePlan aynası). Boş dizi geçerli
// ("henüz plan girilmedi" ara durumu — 56 servislik manuel süreç).
function validatePlans(where, plans, errors) {
  if (plans === undefined) return;
  if (!Array.isArray(plans)) {
    errors.push(`${where}: plans dizi değil`);
    return;
  }
  const seenPlanIds = new Set();
  plans.forEach((plan, pi) => {
    const pwhere = `${where}.plans[${pi}] (${plan?.id ?? '?'})`;
    if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
      errors.push(`${pwhere}: obje değil`);
      return;
    }
    if (typeof plan.id !== 'string' || plan.id.trim() === '') {
      errors.push(`${pwhere}: id zorunlu non-empty string`);
    } else {
      if (!/^[a-z0-9-]+$/.test(plan.id)) {
        errors.push(`${pwhere}: id kebab-case değil`);
      }
      // App sentinel'i (Subscription.customPlanSentinel): parser bu id'yi
      // sessizce atar — gerçek bir plan "Özel seçildi" olarak yorumlanamaz.
      if (plan.id === 'custom') {
        errors.push(`${pwhere}: id 'custom' REZERVE (app sentinel'i)`);
      }
      if (seenPlanIds.has(plan.id)) {
        errors.push(`${pwhere}: plan id serviste tekrar ediyor`);
      }
      seenPlanIds.add(plan.id);
    }
    if (typeof plan.name !== 'string' || plan.name.trim() === '') {
      errors.push(`${pwhere}: name zorunlu non-empty string`);
    }
    const hasChannels = plan.channelPrices !== undefined &&
        plan.channelPrices !== null &&
        Object.keys(plan.channelPrices ?? {}).length > 0;
    if (plan.prices === undefined || plan.prices === null ||
        typeof plan.prices !== 'object' || Array.isArray(plan.prices) ||
        Object.keys(plan.prices).length === 0) {
      // App parser'ı fiyatsız planı atıyor (anlamsız) — burada isimli
      // hata. M8c: yalnız kanal fiyatlı plan da geçerli.
      if (!hasChannels) {
        errors.push(`${pwhere}: prices boş/eksik (fiyatsız plan atılır)`);
      }
    } else {
      validatePrices(pwhere, plan.prices, errors);
    }
    validateChannelPrices(pwhere, plan.channelPrices, errors);
  });
}

// channelPrices (M8c — additive): 'apple'|'google' → bölge → fiyat.
// 'web' REZERVE (web = prices alanı); bilinmeyen kanal isimli hata —
// app parser'ı sessizce atar, CI burada yakalar (validate ilkesi).
const KNOWN_CHANNELS = new Set(['apple', 'google']);
function validateChannelPrices(where, channelPrices, errors) {
  if (channelPrices === undefined) return;
  if (channelPrices === null || typeof channelPrices !== 'object' ||
      Array.isArray(channelPrices)) {
    errors.push(`${where}: channelPrices obje değil`);
    return;
  }
  for (const [channel, prices] of Object.entries(channelPrices)) {
    const cwhere = `${where}.channelPrices.${channel}`;
    if (channel === 'web') {
      errors.push(`${cwhere}: 'web' REZERVE — web fiyatı prices alanında`);
      continue;
    }
    if (!KNOWN_CHANNELS.has(channel)) {
      errors.push(`${cwhere}: bilinmeyen kanal (app sessizce atar)`);
      continue;
    }
    if (prices === null || typeof prices !== 'object' ||
        Array.isArray(prices) || Object.keys(prices).length === 0) {
      errors.push(`${cwhere}: bölge fiyat haritası boş/geçersiz`);
      continue;
    }
    validatePrices(cwhere, prices, errors);
  }
}

/** services.config.json plan config'leri (M8b): pattern + expectedRange
 *  ZORUNLU (storytel PR#3/#4 dersi — kesin bariyer); plan id catalog'da
 *  o serviste tanımlı olmalı (scraper plan yaratmaz); 'custom' rezerve. */
export function validateServicesConfig(config, catalog) {
  const errors = [];
  const planIdsByService = new Map(
    (catalog?.services ?? []).map((s) => [
      s.id,
      new Set((s.plans ?? []).map((p) => p.id)),
    ]),
  );
  for (const svc of config?.services ?? []) {
    for (const [region, rc] of Object.entries(svc.regions ?? {})) {
      for (const [planId, pc] of Object.entries(rc.plans ?? {})) {
        const where = `${svc.id}/${region}/${planId}`;
        if (planId === 'custom') {
          errors.push(`${where}: 'custom' REZERVE (app sentinel'i)`);
        }
        if (typeof pc?.pattern !== 'string' || pc.pattern.length === 0) {
          errors.push(`${where}: pattern zorunlu`);
        }
        if (
          !Array.isArray(pc?.expectedRange) ||
          pc.expectedRange.length !== 2 ||
          !Number.isInteger(pc.expectedRange[0]) ||
          !Number.isInteger(pc.expectedRange[1]) ||
          pc.expectedRange[0] >= pc.expectedRange[1]
        ) {
          errors.push(`${where}: expectedRange [min,max] ZORUNLU (int, min<max)`);
        }
        const known = planIdsByService.get(svc.id);
        if (!known || !known.has(planId)) {
          errors.push(`${where}: catalog.json'da bu serviste tanımlı değil`);
        }
      }
    }
  }
  return errors;
}

/** history.json şeması: {schemaVersion, generatedAt,
 *  series:{id:{region:[{date,minorUnits,currency}]}},
 *  planSeries:{id:{planId:{region:[...]}}} (M8b — additive, opsiyonel)} */
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
    validateSeriesRegions(id, regions, errors);
  }
  if (history.planSeries !== undefined) {
    if (history.planSeries === null || typeof history.planSeries !== 'object') {
      errors.push('planSeries obje değil');
    } else {
      for (const [id, plans] of Object.entries(history.planSeries)) {
        if (plans === null || typeof plans !== 'object') {
          errors.push(`${id}: planSeries girdisi obje değil`);
          continue;
        }
        for (const [planId, regions] of Object.entries(plans)) {
          validateSeriesRegions(`${id}#${planId}`, regions, errors);
        }
      }
    }
  }
  return errors;
}

function validateSeriesRegions(where, regions, errors) {
  if (regions === null || typeof regions !== 'object') {
    errors.push(`${where}: bölge haritası obje değil`);
    return;
  }
  for (const [region, points] of Object.entries(regions)) {
    const expected = REGION_CURRENCY[region];
    if (!expected) {
      errors.push(`${where}: bilinmeyen bölge '${region}'`);
      continue;
    }
    if (!Array.isArray(points)) {
      errors.push(`${where}.${region}: dizi değil`);
      continue;
    }
    let prevDate = '';
    for (const p of points) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p?.date ?? '')) {
        errors.push(`${where}.${region}: geçersiz tarih`);
      } else if (p.date < prevDate) {
        errors.push(`${where}.${region}: tarihler artan sırada değil`);
      } else {
        prevDate = p.date;
      }
      if (!Number.isInteger(p?.minorUnits) || p.minorUnits <= 0) {
        errors.push(`${where}.${region}: geçersiz minorUnits`);
      }
      if (p?.currency !== expected) {
        errors.push(`${where}.${region}: currency != ${expected}`);
      }
    }
  }
}
