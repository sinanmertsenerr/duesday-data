// Fiyat geçmişi: git history'den DETERMİNİSTİK regenerate (append değil) —
// conflict-free, tek doğruluk kaynağı git (impact: cross-surface §4).
// Çıktı catalog.json'dan AYRI dosya; app'in kritik yoluna girmez.

import { execFileSync } from 'node:child_process';

function git(args, cwd) {
  // execFileSync + sabit argüman listesi: shell injection yüzeyi yok.
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** catalog.json'a dokunan commit'ler, ESKİDEN YENİYE. */
export function listCatalogCommits(repoDir) {
  const out = git(
    ['log', '--reverse', '--format=%H %cs', '--', 'catalog.json'],
    repoDir,
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date] = line.split(' ');
      return { sha, date };
    });
}

/**
 * Tüm geçmişi tarayıp seri üretir. Ardışık aynı fiyatlar tek noktaya
 * indirgenir (yalnız DEĞİŞİM noktaları saklanır — grafik için yeterli,
 * dosya boyutu sınırlı kalır).
 * @param {string} repoDir duesday-data çalışma kopyası
 * @param {string} today YYYY-AA-GG (dışarıdan enjekte)
 */
export function regenerateHistory(repoDir, today) {
  const series = {};
  // M8b: plan serileri — ayrı üst-anahtar (series semantiği saf kalır;
  // app'in eski parser'ı bilinmeyen anahtarı okumaz, schemaVersion 1).
  const planSeries = {};
  for (const { sha, date } of listCatalogCommits(repoDir)) {
    let catalog;
    try {
      catalog = JSON.parse(git(['show', `${sha}:catalog.json`], repoDir));
    } catch {
      continue; // tarihte bozuk/eksik snapshot — geçmiş üretimini kırmaz
    }
    if (!Array.isArray(catalog?.services)) continue;
    for (const svc of catalog.services) {
      if (typeof svc?.id !== 'string') continue;
      for (const [region, price] of Object.entries(svc.prices ?? {})) {
        appendChangePoint(
          ((series[svc.id] ??= {})[region] ??= []),
          date,
          price,
        );
      }
      // M8a-öncesi snapshot'larda plans yok — guard şart.
      if (!Array.isArray(svc.plans)) continue;
      for (const plan of svc.plans) {
        if (typeof plan?.id !== 'string') continue;
        for (const [region, price] of Object.entries(plan.prices ?? {})) {
          appendChangePoint(
            (((planSeries[svc.id] ??= {})[plan.id] ??= {})[region] ??= []),
            date,
            price,
          );
        }
      }
    }
  }
  return { schemaVersion: 1, generatedAt: today, series, planSeries };
}

/** Yalnız DEĞİŞİM noktası ekler (taban ve plan serilerinde aynı kural). */
function appendChangePoint(points, date, price) {
  if (!Number.isInteger(price?.minorUnits) || price.minorUnits <= 0) return;
  const last = points[points.length - 1];
  if (
    last &&
    last.minorUnits === price.minorUnits &&
    last.currency === price.currency
  ) {
    return;
  }
  points.push({ date, minorUnits: price.minorUnits, currency: price.currency });
}
