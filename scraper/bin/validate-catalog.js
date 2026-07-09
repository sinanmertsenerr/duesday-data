#!/usr/bin/env node
// CI kapısı: her PR'da catalog.json app-parser kurallarıyla doğrulanır.
import { readFileSync } from 'node:fs';

import { validateCatalog } from '../lib/validate.js';

const path = process.argv[2] ?? 'catalog.json';
let catalog;
try {
  catalog = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`${path} okunamadı/parse edilemedi: ${e.message}`);
  process.exit(1);
}
const errors = validateCatalog(catalog);
if (errors.length > 0) {
  console.error(`${path} GEÇERSİZ:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`${path} geçerli (${catalog.services.length} servis).`);
