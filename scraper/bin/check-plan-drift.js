#!/usr/bin/env node
// Plan-drift GÖRÜNÜRLÜK kontrolü (M8a impact kararı: hard-error DEĞİL).
//
// Scraper yalnız taban `prices`'ı günceller; `plans[].prices` M8b'ye kadar
// manueldir. Taban fiyat değişince ona denk gelen plan bayatlıyor ve hiçbir
// sinyal üretmiyordu (sessiz bayatlama). Bu script her bölgede taban
// fiyatın plans içinde birebir eşleşen bir plana sahip olup olmadığını
// raporlar; UYARIR ama CI'yi KIRMAZ (exit 0) — aksi halde her normal
// scrape-PR'ı kırmızıya düşerdi (scraper kendi çıktısını reddedemez).
// M8b'de scraper plan fiyatlarını da güncellemeye başlayınca bu kontrol
// validate.js'e hard-error olarak terfi ettirilebilir.
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'catalog.json';
let catalog;
try {
  catalog = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`${path} okunamadı/parse edilemedi: ${e.message}`);
  process.exit(1); // dosya bozuksa bu gerçek hata — validate zaten kırar
}

const warnings = [];
for (const svc of catalog.services ?? []) {
  if (!Array.isArray(svc.plans) || svc.plans.length === 0) continue;
  for (const [region, price] of Object.entries(svc.prices ?? {})) {
    const match = svc.plans.some(
      (plan) =>
        plan?.prices?.[region]?.minorUnits === price?.minorUnits &&
        plan?.prices?.[region]?.currency === price?.currency,
    );
    if (!match) {
      warnings.push(
        `${svc.id}.${region}: taban ${price.minorUnits} ${price.currency} ` +
          'hiçbir plan fiyatıyla eşleşmiyor — plan fiyatları bayatlamış ' +
          'olabilir (scraper tabanı güncelledi, plans manuel)',
      );
    }
  }
}

if (warnings.length > 0) {
  console.log(`⚠️ plan-drift (${warnings.length}):`);
  for (const w of warnings) console.log(`  - ${w}`);
} else {
  console.log('plan-drift yok: her taban fiyat bir plan fiyatıyla eşleşiyor.');
}
process.exit(0);
