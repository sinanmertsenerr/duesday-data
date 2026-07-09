#!/usr/bin/env node
// M6: merge sonrası zam push gönderimi (price-scrape.yml inline adımı —
// ayrı `on: push` workflow'u GITHUB_TOKEN merge'lerinde HİÇ tetiklenmezdi,
// history.yml dersi). Best-effort: hata deploy'u geri almaz, yalnız bu
// adımı kırar ve issue'ya düşer.

import { readFileSync } from 'node:fs';
import { buildPushMessages, mintAccessToken, sendAll } from '../lib/fcm.js';

const artifact = JSON.parse(readFileSync('changes/latest.json', 'utf8'));
const catalog = JSON.parse(readFileSync('catalog.json', 'utf8'));

const messages = buildPushMessages(artifact, catalog);
if (messages.length === 0) {
  console.log('FCM: gönderilecek fiyat değişikliği yok — atlandı.');
  process.exit(0);
}

const rawKey = process.env.FCM_SA_KEY;
if (!rawKey) {
  // Secret henüz kurulmamış olabilir (M6 kullanıcı adımı) — sessiz atla;
  // kurulduktan sonraki GERÇEK gönderim hataları aşağıda gürültülü.
  console.log('::warning::FCM_SA_KEY tanımlı değil — push adımı atlandı.');
  process.exit(0);
}
const saKey = JSON.parse(rawKey);

const token = await mintAccessToken(saKey);
const { sent, failures } = await sendAll(messages, {
  projectId: saKey.project_id,
  token,
});

// Özet: token/secret içermez.
console.log(
  `FCM: ${sent.length}/${messages.length} push gönderildi` +
    (sent.length ? ` (${sent.map((s) => s.topic).join(', ')})` : ''),
);
for (const f of failures) {
  console.error(`::error::FCM gönderim hatası ${f.topic}: ${f.error}`);
}
process.exit(failures.length > 0 ? 1 : 0);
