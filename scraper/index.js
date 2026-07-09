#!/usr/bin/env node
// Orkestrasyon: config'teki her servis-bölgeyi SIRAYLA (stagger'lı) çek,
// çıkar, diff'le, sanity uygula, çıktı dosyalarını yaz. Bir servisin
// kırılması diğerlerini ETKİLEMEZ (SPEC DoD) — hatalar toplanır, rapora
// düşer. Çıktılar workflow'a $GITHUB_OUTPUT ile bildirilir.
//
// Kullanım:
//   node scraper/index.js                    # gerçek scrape
//   node scraper/index.js --simulate         # ağ yok; sahte değişiklik enjekte
//                                            # (DoD: uçtan uca akış provası)

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyUpdates, buildChangesArtifact, computeDiff } from './lib/diff.js';
import { FetchError, fetchPage } from './lib/fetch.js';
import { extractPrice } from './lib/parse.js';
import { buildPrBody } from './lib/prbody.js';
import { validateCatalog } from './lib/validate.js';

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGGER_MS = 15_000; // servisler arası bekleme (politeness)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Saf orkestrasyon — test için fetcher enjekte edilebilir. */
export async function runScrape(catalog, config, fetcher, { staggerMs = 0 } = {}) {
  const scraped = [];
  const failures = [];
  let attempted = 0;
  for (const service of config.services) {
    for (const [region, rc] of Object.entries(service.regions)) {
      if (rc.enabled === false) continue;
      attempted += 1;
      try {
        const html = await fetcher(rc.url, {
          acceptLanguage: rc.locale === 'tr-TR' ? 'tr-TR,tr;q=0.9' : 'en-US,en;q=0.9',
        });
        const minorUnits = extractPrice(html, rc);
        scraped.push({
          id: service.id,
          region,
          minorUnits,
          currency: rc.expectedCurrency,
          sourceUrl: rc.url,
        });
      } catch (e) {
        // Servis-bazlı izolasyon: hata diff'e ASLA girmez, rapora girer.
        failures.push({ id: service.id, region, error: String(e?.message ?? e) });
      }
      if (staggerMs > 0) await sleep(staggerMs);
    }
  }
  return { scraped, failures, attempted };
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

async function main() {
  const simulate = process.argv.includes('--simulate');
  // Tarih dışarıdan enjekte edilebilir (determinizm/test); yoksa bugün.
  const today =
    process.env.SCRAPE_DATE ?? new Date().toISOString().slice(0, 10);

  const catalog = readJson(join(repoDir, 'catalog.json'));
  const config = readJson(join(repoDir, 'scraper', 'services.config.json'));

  let scraped;
  let failures;
  let attempted;
  if (simulate) {
    // DoD provası: ilk config servisinin mevcut fiyatına +%10 sahte zam.
    const svc = config.services[0];
    const region = Object.keys(svc.regions)[0];
    const current = catalog.services.find((s) => s.id === svc.id)?.prices?.[region];
    if (!current) throw new Error(`simülasyon: ${svc.id}/${region} katalogda yok`);
    scraped = [
      {
        id: svc.id,
        region,
        minorUnits: Math.round(current.minorUnits * 1.1),
        currency: current.currency,
        sourceUrl: svc.regions[region].url,
      },
    ];
    failures = [];
    attempted = 1;
  } else {
    ({ scraped, failures, attempted } = await runScrape(catalog, config, fetchPage, {
      staggerMs: STAGGER_MS,
    }));
  }

  const diff = computeDiff(catalog, scraped);
  const outDir = join(repoDir, '.scrape-out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'report.md'),
    buildPrBody(diff, failures, { attempted, today }),
  );

  console.log(
    `denenen=${attempted} değişen=${diff.updates.length} aynı=${diff.unchanged} ` +
      `karantina=${diff.quarantined.length} yeni-bölge=${diff.newRegions.length} hata=${failures.length}`,
  );

  if (diff.runAnomaly) {
    // Sistemik anomali: otomatik PR YOK; workflow issue açar.
    writeOutput('run_anomaly', 'true');
    writeOutput('has_updates', 'false');
    console.error('KOŞU ANOMALİSİ: değişen oranı eşik üstü — PR açılmayacak.');
    return;
  }
  writeOutput('run_anomaly', 'false');
  writeOutput('has_failures', failures.length > 0 ? 'true' : 'false');
  writeOutput(
    'has_quarantine',
    diff.quarantined.length > 0 ? 'true' : 'false',
  );

  if (diff.updates.length === 0) {
    // No-op koşu: dosyaya DOKUNMA — gereksiz ETag churn'ü app'e tam-GET
    // yaptırır (impact: cross-surface §2).
    writeOutput('has_updates', 'false');
    return;
  }

  const next = applyUpdates(catalog, diff.updates, today);
  // Parse-önce-yaz aynası: kendi çıktımızı app kurallarıyla doğrula;
  // geçmezse PR açılmaz, workflow kırmızı (impact: failure-modes §4.1).
  const errors = validateCatalog(next);
  if (errors.length > 0) {
    console.error('ÜRETİLEN KATALOG GEÇERSİZ — PR açılmayacak:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(
    join(repoDir, 'catalog.json'),
    JSON.stringify(next) + '\n',
  );
  writeFileSync(
    join(repoDir, 'changes', 'latest.json'),
    JSON.stringify(buildChangesArtifact(diff.updates, today), null, 2) + '\n',
  );
  writeOutput('has_updates', 'true');
}

// Test import'unda çalışmasın diye: yalnız doğrudan çağrıda main.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
