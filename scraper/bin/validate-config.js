#!/usr/bin/env node
// CI kapısı (M8b): services.config.json plan config'lerinin şema kontrolü.
// Kurallar lib/validate.js#validateServicesConfig'te (test edilebilir).

import { readFileSync } from 'node:fs';

import { validateServicesConfig } from '../lib/validate.js';

const configPath = process.argv[2] ?? 'scraper/services.config.json';
const catalogPath = process.argv[3] ?? 'catalog.json';

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

const errors = validateServicesConfig(config, catalog);
if (errors.length > 0) {
  console.error(`${configPath} GEÇERSİZ:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
const planCount = (config.services ?? []).reduce(
  (n, s) =>
    n +
    Object.values(s.regions ?? {}).reduce(
      (m, rc) => m + Object.keys(rc.plans ?? {}).length,
      0,
    ),
  0,
);
console.log(`${configPath} geçerli (${planCount} plan config'i).`);
