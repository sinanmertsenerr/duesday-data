// M8b plan pattern kalibrasyonu — GERÇEK probe çıktısı metinlerine karşı
// (2026-07-10 probe koşuları; kör kalibrasyon yasak — PR #3 dersi).
// Her config pattern'i, sayfanın probe'ta görülen metni üzerinde beklenen
// minör birimi üretmek ZORUNDA. hbo-max/ozel İSTİSNA: fiyat probe
// penceresinde görünmedi, pattern Standart kalıbının simetriği —
// mekanik doğruluğu sentetik metinle test edilir (yanlış veri riski yok:
// kırılırsa plan-izolasyon alert'e düşürür).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildPlanRegionConfig } from '../scraper/index.js';
import { extractPrice } from '../scraper/lib/parse.js';

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  readFileSync(join(repoDir, 'scraper', 'services.config.json'), 'utf8'),
);

function rcOf(serviceId, region) {
  return config.services.find((s) => s.id === serviceId).regions[region];
}

// Probe/WebFetch kanıt metinleri (selector içine gömülür).
const PAGES = {
  'netflix/us': {
    wrap: (t) => `<body>${t}</body>`,
    text:
      'Standard with ads: $8.99 / monthStandard: $19.99 / month' +
      'Add 1 extra member for $7.99 / month with ads or $9.99 / month ' +
      'without adsPremium: $26.99 / monthAdd up to 2 extra members',
    expected: { 'standard-with-ads': 899, standard: 1999, premium: 2699 },
  },
  'spotify/tr': {
    wrap: (t) => `<main>${t}</main>`,
    // Kart sırası GERÇEK sayfadaki gibi (WebFetch 2026-07-10):
    // Bireysel → Öğrenci → Duo → Aile. Sıra teaser-bağlam analizini
    // etkiler — uydurma sıra yanlış kalibrasyon sinyali verir.
    text:
      'Sınırlar olmadan dinle. Premium Bireysel planını dene: İlk 1 ay ₺0.' +
      'Sonra yalnızca ₺99/ay. İstediğin zaman iptal et.' +
      'PremiumBireyselİlk 1 ay boyunca ücretsizSonra ayda ₺991 Premium hesabı' +
      'PremiumÖğrenciİlk 1 ay boyunca ücretsizSonra ayda ₺55İndirimli fiyat' +
      // 2026-07-10 GERÇEK koşu varyantı: Öğrenci kartının hukuk metni Duo
      // fiyatının teaser penceresine giriyordu — anchoredContext bunu çözer.
      'yararlanamaz. Spotify Öğrenci İndirimi Hüküm ve Koşulları\'na tabidir.' +
      'PremiumDuo₺135 / ay2 Premium hesabıPremiumAile₺165 / ay6 Premium hesabı' +
      'Yinelenen üyeliklerde otomatik ödeme alınır.',
    expected: { bireysel: 9900, duo: 13500, aile: 16500, ogrenci: 5500 },
  },
  'spotify/us': {
    wrap: (t) => `<main>${t}</main>`,
    text:
      'Premium Individual only. $0 for 1 month, then $12.99 per month after.',
    expected: { individual: 1299 },
  },
  'apple-music/us': {
    wrap: (t) => `<main>${t}</main>`,
    text:
      'Choose the plan that’s right for you. ' +
      'Individual $10.99/month, first month free for new subscribers. ' +
      'Family $16.99/month, one month free for new subscribers. ' +
      'Student Extra savings at just $5.99/month, first month free.',
    expected: { individual: 1099, family: 1699, student: 599 },
  },
  'apple-icloud/us': {
    wrap: (t) => `<div id="sections">${t}</div>`,
    text:
      'United States2,3 (USD) 50 GB: $0.99200 GB: $2.992 TB: $10.99' +
      '6 TB: $32.9912 TB: $64.99 Uruguay2,3 (USD) 50 GB: $0.99',
    expected: {
      '50gb': 99,
      '200gb': 299,
      '2tb': 1099,
      '6tb': 3299,
      '12tb': 6499,
    },
  },
  'disney-plus/tr': {
    wrap: (t) => `<main>${t}</main>`,
    text:
      'Üyeliğini seçDISNEY+ REKLAMLIDISNEY+ REKLAMSIZ' +
      '249,90 TL / ay449,90 TL / ay10 ay öde, 12 ay izle',
    expected: { reklamli: 24990, reklamsiz: 44990 },
  },
  'hbo-max/tr': {
    wrap: (t) => `<main>${t}</main>`,
    text:
      'HBO Max paketlerini izlemeye başlayın. Standart (229,90 TL/ay ' +
      'AİLELER İÇİN MUHTEŞEMÖzelDört cihazda izleme Özel (299,90 TL/ay',
    expected: { standart: 22990, ozel: 29990 },
  },
};

for (const [key, page] of Object.entries(PAGES)) {
  const [serviceId, region] = key.split('/');
  const rc = rcOf(serviceId, region);
  test(`plan pattern kalibrasyonu: ${key}`, () => {
    assert.ok(rc.plans, `${key}: config'te plans yok`);
    // Config'teki HER plan için beklenen değer tanımlı olmalı (kanıtsız
    // pattern config'e giremez) ve tersi.
    assert.deepEqual(
      Object.keys(rc.plans).sort(),
      Object.keys(page.expected).sort(),
    );
    const html = page.wrap(page.text);
    for (const [planId, expected] of Object.entries(page.expected)) {
      const got = extractPrice(html, buildPlanRegionConfig(rc, rc.plans[planId]));
      assert.equal(got, expected, `${key}/${planId}`);
      const [min, max] = rc.plans[planId].expectedRange;
      assert.ok(
        expected >= min && expected <= max,
        `${key}/${planId}: expectedRange [${min},${max}] beklenen ${expected} değerini kapsamıyor`,
      );
    }
  });
}
