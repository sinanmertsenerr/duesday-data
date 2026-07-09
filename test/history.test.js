import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { regenerateHistory } from '../scraper/lib/history.js';
import { validateHistory } from '../scraper/lib/validate.js';

function git(args, cwd) {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

const catalogAt = (netflixTr, generatedAt = '2026-07-01') =>
  JSON.stringify({
    schemaVersion: 1,
    generatedAt,
    services: [
      {
        id: 'netflix',
        name: 'Netflix',
        category: 'streaming',
        prices: { tr: { minorUnits: netflixTr, currency: 'TRY' } },
      },
    ],
  });

test('git history → yalnız DEĞİŞİM noktaları, şema-valid (DoD)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duesday-history-'));
  try {
    git(['init', '-q', '-b', 'main'], dir);
    const commitCatalog = (content, dateIso) => {
      writeFileSync(join(dir, 'catalog.json'), content);
      git(['add', 'catalog.json'], dir);
      execFileSync('git', ['commit', '-q', '-m', 'update'], {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
          GIT_AUTHOR_DATE: `${dateIso}T12:00:00Z`,
          GIT_COMMITTER_DATE: `${dateIso}T12:00:00Z`,
        },
      });
    };

    commitCatalog(catalogAt(18999, '2026-01-05'), '2026-01-05');
    // fiyat aynı, dosya farklı (generatedAt) — nokta üretmemeli
    commitCatalog(catalogAt(18999, '2026-03-10'), '2026-03-10');
    commitCatalog(catalogAt(22999, '2026-06-20'), '2026-06-20'); // zam

    const history = regenerateHistory(dir, '2026-07-09');
    assert.deepEqual(validateHistory(history), []);
    assert.deepEqual(history.series.netflix.tr, [
      { date: '2026-01-05', minorUnits: 18999, currency: 'TRY' },
      { date: '2026-06-20', minorUnits: 22999, currency: 'TRY' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tarihte bozuk snapshot geçmiş üretimini kırmaz', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duesday-history-'));
  try {
    git(['init', '-q', '-b', 'main'], dir);
    writeFileSync(join(dir, 'catalog.json'), '{bozuk json');
    git(['add', 'catalog.json'], dir);
    git(['commit', '-q', '-m', 'broken'], dir);
    writeFileSync(join(dir, 'catalog.json'), catalogAt(18999));
    git(['add', 'catalog.json'], dir);
    git(['commit', '-q', '-m', 'ok'], dir);

    const history = regenerateHistory(dir, '2026-07-09');
    assert.equal(history.series.netflix.tr.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
