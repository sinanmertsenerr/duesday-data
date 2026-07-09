// İnsan-okur PR gövdesi. Pipeline'ın son savunma hattı insandır; kaynak
// link + eski→yeni + %değişim olmadan PR onayı dekoratif kalır
// (impact: failure-modes §5.1). Ham JSON diff'i yerine tablo.

import { formatMoney } from './money.js';

const REGION_LABEL = { tr: 'TR', us: 'US' };

function updatesTable(updates) {
  const rows = updates.map((u) => {
    const arrow = u.pctChange > 0 ? '🔺' : '🔻';
    return (
      `| ${u.id} | ${REGION_LABEL[u.region] ?? u.region} ` +
      `| ${formatMoney(u.oldMinorUnits, u.currency)} ` +
      `| **${formatMoney(u.minorUnits, u.currency)}** ` +
      `| ${arrow} %${u.pctChange} | [kaynak](${u.sourceUrl}) |`
    );
  });
  return [
    '| Servis | Bölge | Eski | Yeni | Δ | Kaynak |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

/**
 * @param {{updates:Array, quarantined:Array, newRegions:Array, unchanged:number}} diff
 * @param {Array<{id:string, region:string, error:string}>} failures
 * @param {{attempted:number, today:string}} meta
 */
export function buildPrBody(diff, failures, meta) {
  const parts = [];
  parts.push(
    `Otomatik fiyat taraması — ${meta.today}. ` +
      `${meta.attempted} servis-bölge denendi: ` +
      `${diff.updates.length} değişiklik, ${diff.unchanged} aynı, ` +
      `${diff.quarantined.length} karantina, ${failures.length} hata.`,
  );
  if (diff.updates.length > 0) {
    parts.push('## Fiyat değişiklikleri\n\n' + updatesTable(diff.updates));
  }
  if (diff.newRegions.length > 0) {
    parts.push(
      '## YENİ BÖLGE (otomatik uygulanmadı — insan kararı)\n\n' +
        diff.newRegions
          .map(
            (n) =>
              `- \`${n.id}\` ${n.region}: ${formatMoney(n.minorUnits, n.currency)} ([kaynak](${n.sourceUrl}))`,
          )
          .join('\n'),
    );
  }
  if (diff.quarantined.length > 0) {
    parts.push(
      '## ⚠️ Karantina (otomatik uygulanmadı — elle doğrula)\n\n' +
        diff.quarantined
          .map((q) => {
            const oldPart =
              q.oldMinorUnits !== undefined
                ? ` ${formatMoney(q.oldMinorUnits, q.currency)} →`
                : '';
            return `- \`${q.id}\` ${q.region}:${oldPart} ${formatMoney(q.minorUnits, q.currency)} — ${q.reason} ([kaynak](${q.sourceUrl}))`;
          })
          .join('\n'),
    );
  }
  if (failures.length > 0) {
    parts.push(
      '## Scrape hataları (bu servisler bu koşuda güncellenmedi)\n\n' +
        failures.map((f) => `- \`${f.id}\` ${f.region}: ${f.error}`).join('\n'),
    );
  }
  parts.push(
    '---\n_Merge etmeden önce: her satırın kaynak linkini aç, fiyatı gözünle doğrula. ' +
      'Karantina/yeni-bölge satırları bu PR ile YAYINLANMAZ; gerekiyorsa elle ayrı PR aç._',
  );
  return parts.join('\n\n');
}
