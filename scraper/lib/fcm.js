// M6: FCM HTTP v1 gönderici — merge sonrası zam push'ları.
//
// VERİ SÖZLEŞMESİ: data-only mesaj (notification alanı YOK) — metni app
// kendi diliyle ve GRANDFATHERING kurallarıyla üretir (app tarafındaki
// karşılık: lib/features/push/domain/price_push_payload.dart, PAYLOAD_VERSION
// oradaki supportedVersion ile birebir aynı olmalı). Topic adı da app'in
// PushTopics.desired üretimiyle kilitli: `svc-{id}-{region}`.
//
// M8b: planId'li değişiklik → topic `svc-{id}-{region}-{planId}`;
// planId'siz (taban) → taban topic. SPEC geçiş kuralı (taban yayını
// sürer) ayna-pattern'lerle kendiliğinden sağlanır: taban zammı hem
// taban kaydını (svc.prices diff) hem taban-aynası planın kaydını
// üretir → iki topic'e iki ayrı mesaj. planName SUNUCUDA çözülür —
// app'in bg-isolate'i katalog açamaz (bilinen sınır, M6).

import { createSign } from 'node:crypto';

export const PAYLOAD_VERSION = 1;

/** changes/latest.json + catalog.json → gönderilecek FCM mesajları. */
export function buildPushMessages(artifact, catalog) {
  if (!artifact || artifact.schemaVersion !== 1) return [];
  const names = new Map(
    (catalog?.services ?? []).map((s) => [s.id, s.name ?? s.id]),
  );
  // planName haritası: "id:planId" → marka plan adı (names ile simetrik).
  const planNames = new Map();
  for (const s of catalog?.services ?? []) {
    for (const p of s.plans ?? []) {
      if (p?.id && p?.name) planNames.set(`${s.id}:${p.id}`, p.name);
    }
  }
  const messages = [];
  for (const c of artifact.changes ?? []) {
    // !oldMinorUnits: 0/null/undefined — diff.js doğal akışta old=0
    // üretmez (karantina yakalar); bu elle bozulmuş artefact'a karşı
    // ikinci hat (app tarafı da reddeder — sözleşme iki uçta simetrik).
    if (!c?.id || !c?.region || !c.oldMinorUnits || c.oldMinorUnits === c.newMinorUnits) {
      continue;
    }
    // planId'li kayıt: katalogda adı çözülemiyorsa (silinmiş plan —
    // yarış durumu) mesaj ATLANIR: yanlış topic'e/adsız push yerine hiç
    // push (app tarafı zaten taban topic'ten haberdar olur).
    let planName;
    if (c.planId) {
      planName = planNames.get(`${c.id}:${c.planId}`);
      if (!planName) continue;
    }
    const topic = c.planId
      ? `svc-${c.id}-${c.region}-${c.planId}`
      : `svc-${c.id}-${c.region}`;
    messages.push({
      message: {
        topic,
        // FCM data değerleri STRING olmak zorunda; olmayan alan HİÇ
        // konmaz (eski app "alan yok = taban değişikliği" okur).
        data: {
          v: String(PAYLOAD_VERSION),
          id: String(c.id),
          name: String(names.get(c.id) ?? c.id),
          region: String(c.region),
          oldMinorUnits: String(c.oldMinorUnits),
          newMinorUnits: String(c.newMinorUnits),
          currency: String(c.currency),
          ...(c.planId ? { planId: String(c.planId), planName: String(planName) } : {}),
        },
        android: {
          // Aynı servisin ardışık push'ları cihazda tek bildirime iner
          // (at-least-once + hızlı düzeltme senaryosu).
          collapse_key: topic,
          priority: 'normal',
        },
      },
    });
  }
  return messages;
}

/** Service-account JWT → OAuth access token (ek bağımlılık yok). */
export async function mintAccessToken(saKey, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: saKey.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: saKey.token_uri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer
    .sign(saKey.private_key, 'base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  const jwt = `${header}.${claims}.${signature}`;

  const res = await fetchImpl(saKey.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    // Token değeri ASLA loglanmaz; yalnız durum kodu.
    throw new Error(`token exchange failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!body.access_token) throw new Error('token exchange: access_token yok');
  return body.access_token;
}

/**
 * Mesajları tek tek gönderir — per-mesaj izolasyon (scraper'ın
 * failures-push idiyomu): biri patlarsa diğerleri devam eder.
 * 429'da 60 sn (resmî minimum), 5xx'te 5 sn bekleyip BİR kez yeniden dener.
 */
export async function sendAll(messages, { projectId, token, fetchImpl = fetch, sleep = defaultSleep }) {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const sent = [];
  const failures = [];
  for (const payload of messages) {
    const outcome = await sendOne(url, token, payload, fetchImpl, sleep);
    (outcome.ok ? sent : failures).push({
      topic: payload.message.topic,
      ...(outcome.ok ? {} : { error: outcome.error }),
    });
  }
  return { sent, failures };
}

async function sendOne(url, token, payload, fetchImpl, sleep) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          // Token env/bellekte kalır, CLI arg'a veya loga asla çıkmaz.
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) return { ok: true };
      if (attempt === 1 && res.status === 429) {
        await sleep(60_000); // resmî minimum backoff
        continue;
      }
      if (attempt === 1 && res.status >= 500) {
        await sleep(5_000);
        continue;
      }
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      if (attempt === 1) {
        await sleep(5_000);
        continue;
      }
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: 'unreachable' };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
