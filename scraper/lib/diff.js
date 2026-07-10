// Diff + sanity motoru. İki savunma katmanı (impact: failure-modes §2):
// 1. Servis-bazlı karantina: eski fiyatın 4x üstü / 0.4x altı = şüpheli.
//    Yön-simetrik: ani büyük DÜŞÜŞ de format/decimal hatası sinyalidir.
// 2. Koşu-geneli anomali: başarılı scrape'lerin >%50'si aynı anda değiştiyse
//    sistemik hata (şablon değişimi) varsayılır, otomatik PR açılmaz.

export const QUARANTINE_UPPER_RATIO = 4.0; // > %300 artış
// Tam otomatik modda alt eşik sıkı: %45+ düşüş neredeyse her zaman
// promo/indirim yakalamasıdır (storytel PR #3/#4 vakaları) — insana düşer.
export const QUARANTINE_LOWER_RATIO = 0.55;
export const RUN_ANOMALY_CHANGED_FRACTION = 0.5;
export const RUN_ANOMALY_MIN_SAMPLES = 4;
// Gürültü eşiği: kuruş oynamaları PR yorgunluğu yaratır (failure-modes §5.3).
export const MIN_CHANGE_PCT = 0.5;

/**
 * @param {object} catalog main'deki (merge edilmiş) catalog.json — baz her
 *   zaman main'dir, bekleyen PR branch'i değil (failure-modes §2.5).
 * @param {Array<{id:string,region:string,minorUnits:number,currency:string,sourceUrl:string}>} scraped
 * @returns {{updates:Array, quarantined:Array, newRegions:Array, unchanged:number, runAnomaly:boolean}}
 */
export function computeDiff(catalog, scraped) {
  const byId = new Map(catalog.services.map((s) => [s.id, s]));
  const updates = [];
  const quarantined = [];
  const newRegions = [];
  let unchanged = 0;

  for (const item of scraped) {
    const svc = byId.get(item.id);
    if (!svc) {
      // id sözleşmesi: scraper id üretmez/eklemez — config'te olup katalogda
      // olmayan id insan hatasıdır, karantinaya düşer (failure-modes §4.4).
      quarantined.push({ ...item, reason: 'katalogda olmayan id' });
      continue;
    }
    // M8b: plan kaydı — scraper plan YARATMAZ; katalogda olmayan planId
    // karantinaya (taban 'katalogda olmayan id' kalıbının plan aynası).
    let old;
    if (item.planId) {
      const plan = (svc.plans ?? []).find((p) => p.id === item.planId);
      if (!plan) {
        quarantined.push({ ...item, reason: 'katalogda olmayan plan' });
        continue;
      }
      old = plan.prices?.[item.region];
    } else {
      old = svc.prices?.[item.region];
    }
    if (!old) {
      // Yeni bölge fiyatı additive ve app-güvenli, ama otomatik akışa
      // girmez — PR gövdesinde ayrı "YENİ BÖLGE" bölümünde insana sunulur.
      newRegions.push(item);
      continue;
    }
    if (old.currency !== item.currency) {
      quarantined.push({
        ...item,
        oldMinorUnits: old.minorUnits,
        reason: `kur değişimi ${old.currency}→${item.currency}`,
      });
      continue;
    }
    if (old.minorUnits === item.minorUnits) {
      unchanged += 1;
      continue;
    }
    const ratio = item.minorUnits / old.minorUnits;
    const pctChange = (ratio - 1) * 100;
    if (Math.abs(pctChange) < MIN_CHANGE_PCT) {
      unchanged += 1;
      continue;
    }
    const record = {
      ...item,
      oldMinorUnits: old.minorUnits,
      pctChange: Math.round(pctChange * 10) / 10,
    };
    if (ratio > QUARANTINE_UPPER_RATIO || ratio < QUARANTINE_LOWER_RATIO) {
      quarantined.push({ ...record, reason: `sapma %${record.pctChange}` });
    } else {
      updates.push(record);
    }
  }

  const samples = updates.length + unchanged;
  const runAnomaly =
    samples >= RUN_ANOMALY_MIN_SAMPLES &&
    updates.length / samples > RUN_ANOMALY_CHANGED_FRACTION;

  return { updates, quarantined, newRegions, unchanged, runAnomaly };
}

/**
 * Doğrulanmış update'leri kataloğa uygular; YENİ obje döner (girdi mutate
 * edilmez). Servis sırası ve dokunulmayan alanlar korunur (temiz git diff).
 * @param {string} today YYYY-AA-GG — dışarıdan enjekte (test edilebilirlik;
 *   app anayasası §11 ile aynı ilke).
 */
export function applyUpdates(catalog, updates, today) {
  if (updates.length === 0) return catalog;
  const changedByService = new Map();
  for (const u of updates) {
    if (!changedByService.has(u.id)) changedByService.set(u.id, []);
    changedByService.get(u.id).push(u);
  }
  return {
    ...catalog,
    generatedAt: today,
    services: catalog.services.map((svc) => {
      const changes = changedByService.get(svc.id);
      if (!changes) return svc;
      const baseChanges = changes.filter((c) => !c.planId);
      const planChanges = changes.filter((c) => c.planId);
      // Dokunulmayan alan REFERANS-EŞİT kalır (temiz git diff) — yalnız
      // plan değiştiyse taban prices objesi kopyalanmaz bile.
      let prices = svc.prices;
      if (baseChanges.length > 0) {
        prices = { ...svc.prices };
        for (const c of baseChanges) {
          prices[c.region] = { minorUnits: c.minorUnits, currency: c.currency };
        }
      }
      // M8b: plan fiyatları — dokunulmayan plan objeleri REFERANS-EŞİT
      // kalır (temiz git diff garantisi taban ile aynı).
      let plans = svc.plans;
      if (planChanges.length > 0 && Array.isArray(svc.plans)) {
        const byPlan = new Map();
        for (const c of planChanges) {
          if (!byPlan.has(c.planId)) byPlan.set(c.planId, []);
          byPlan.get(c.planId).push(c);
        }
        plans = svc.plans.map((p) => {
          const pcs = byPlan.get(p.id);
          if (!pcs) return p;
          const pPrices = { ...p.prices };
          for (const c of pcs) {
            pPrices[c.region] = { minorUnits: c.minorUnits, currency: c.currency };
          }
          return { ...p, prices: pPrices };
        });
      }
      return plans === svc.plans
        ? { ...svc, prices }
        : { ...svc, prices, plans };
    }),
  };
}

/** M6 kancası: merge sonrası FCM push'un okuyacağı makine-okur artefakt. */
export function buildChangesArtifact(updates, today) {
  return {
    schemaVersion: 1,
    changedAt: today,
    changes: updates.map((u) => ({
      id: u.id,
      region: u.region,
      // M8b: plan kaydı opsiyonel alan taşır — artifact'in tek tüketicisi
      // send-fcm.js (planName'i katalogdan çözer); eski tüketici yok.
      ...(u.planId ? { planId: u.planId } : {}),
      oldMinorUnits: u.oldMinorUnits,
      newMinorUnits: u.minorUnits,
      currency: u.currency,
      sourceUrl: u.sourceUrl,
    })),
  };
}
