#!/usr/bin/env node
// catalog.json her main'e merge olduğunda history.json'u git log'dan
// sıfırdan üretir (deterministik, conflict-free).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { regenerateHistory } from '../lib/history.js';
import { validateHistory } from '../lib/validate.js';

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const today = process.env.SCRAPE_DATE ?? new Date().toISOString().slice(0, 10);

const history = regenerateHistory(repoDir, today);
const errors = validateHistory(history);
if (errors.length > 0) {
  console.error('history GEÇERSİZ:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
writeFileSync(join(repoDir, 'history.json'), JSON.stringify(history) + '\n');
const seriesCount = Object.keys(history.series).length;
console.log(`history.json üretildi (${seriesCount} servis).`);
