// main() akışının sözleşme testi: --simulate ile çocuk süreçte koşar,
// GITHUB_OUTPUT bayrak İSİMLERİ workflow'un if: koşullarıyla birebir
// eşleşmek zorunda — buradaki assert'ler o sözleşmenin kilididir.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeTmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'duesday-main-'));
  mkdirSync(join(dir, 'scraper'), { recursive: true });
  mkdirSync(join(dir, 'changes'), { recursive: true });
  writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-07-01',
      services: [
        {
          id: 'netflix',
          name: 'Netflix',
          category: 'streaming',
          prices: { tr: { minorUnits: 18999, currency: 'TRY' } },
        },
      ],
    }),
  );
  cpSync(
    join(repoDir, 'scraper', 'services.config.json'),
    join(dir, 'scraper', 'services.config.json'),
  );
  return dir;
}

test('--simulate: katalog güncellenir, changes yazılır, GITHUB_OUTPUT bayrakları doğru', () => {
  const dir = makeTmpRepo();
  try {
    const outputFile = join(dir, 'github-output.txt');
    writeFileSync(outputFile, '');
    execFileSync(process.execPath, [join(repoDir, 'scraper', 'index.js'), '--simulate'], {
      env: {
        ...process.env,
        DUESDAY_REPO_DIR: dir,
        SCRAPE_DATE: '2026-07-09',
        GITHUB_OUTPUT: outputFile,
      },
    });

    const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
    assert.equal(catalog.generatedAt, '2026-07-09');
    assert.equal(catalog.services[0].prices.tr.minorUnits, 20899); // +%10

    const changes = JSON.parse(
      readFileSync(join(dir, 'changes', 'latest.json'), 'utf8'),
    );
    assert.equal(changes.changes[0].newMinorUnits, 20899);

    const report = readFileSync(join(dir, '.scrape-out', 'report.md'), 'utf8');
    assert.match(report, /netflix/);

    // Bayrak isimleri price-scrape.yml'deki steps.scrape.outputs.* ile aynı.
    const output = readFileSync(outputFile, 'utf8');
    assert.match(output, /^run_anomaly=false$/m);
    assert.match(output, /^has_updates=true$/m);
    assert.match(output, /^has_failures=false$/m);
    assert.match(output, /^has_quarantine=false$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
