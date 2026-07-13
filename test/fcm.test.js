import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { buildPushMessages, mintAccessToken, sendAll, PAYLOAD_VERSION } from '../scraper/lib/fcm.js';

const artifact = (changes) => ({ schemaVersion: 1, changedAt: '2026-07-09', changes });
const catalog = {
  services: [
    { id: 'netflix', name: 'Netflix' },
    { id: 'spotify', name: 'Spotify' },
  ],
};
const change = (over = {}) => ({
  id: 'netflix',
  region: 'tr',
  oldMinorUnits: 22999,
  newMinorUnits: 25999,
  currency: 'TRY',
  ...over,
});

test('buildPushMessages: topic app tarafıyla kilitli (svc-{id}-{region}), data hep string', () => {
  const [msg] = buildPushMessages(artifact([change()]), catalog);
  assert.equal(msg.message.topic, 'svc-netflix-tr');
  assert.equal(msg.message.android.collapse_key, 'svc-netflix-tr');
  assert.deepEqual(msg.message.data, {
    v: String(PAYLOAD_VERSION),
    id: 'netflix',
    name: 'Netflix',
    region: 'tr',
    oldMinorUnits: '22999',
    newMinorUnits: '25999',
    currency: 'TRY',
  });
  for (const value of Object.values(msg.message.data)) {
    assert.equal(typeof value, 'string');
  }
  // data-only sözleşmesi: notification alanı YOK (dil istemcide çözülür).
  assert.equal(msg.message.notification, undefined);
});

test('buildPushMessages: fiyatı değişmeyen / bilinmeyen şema / old=0 atlanır', () => {
  assert.deepEqual(buildPushMessages(artifact([change({ newMinorUnits: 22999 })]), catalog), []);
  assert.deepEqual(buildPushMessages(artifact([change({ oldMinorUnits: 0 })]), catalog), []);
  assert.deepEqual(buildPushMessages({ schemaVersion: 2, changes: [change()] }, catalog), []);
  assert.deepEqual(buildPushMessages(artifact([]), catalog), []);
});

test('buildPushMessages: katalogda adı olmayan id kendi id\'siyle gönderilir', () => {
  const [msg] = buildPushMessages(artifact([change({ id: 'yeni-servis' })]), catalog);
  assert.equal(msg.message.data.name, 'yeni-servis');
});

test('mintAccessToken: RS256 imzalı, doğru claim\'li JWT üretir; token loglanmaz', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const saKey = {
    client_email: 'bot@duesday-a6c2f.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'duesday-a6c2f',
  };
  let capturedBody;
  const token = await mintAccessToken(saKey, async (url, init) => {
    assert.equal(url, saKey.token_uri);
    capturedBody = init.body;
    return { ok: true, json: async () => ({ access_token: 'test-token' }) };
  });
  assert.equal(token, 'test-token');

  const jwt = new URLSearchParams(capturedBody).get('assertion');
  const [header, claims, signature] = jwt.split('.');
  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(decoded.iss, saKey.client_email);
  assert.equal(decoded.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.ok(decoded.exp - decoded.iat === 3600);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${claims}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, 'base64url')));
});

test('sendAll: per-mesaj izolasyon — biri patlarsa diğerleri gönderilir', async () => {
  const messages = buildPushMessages(
    artifact([change(), change({ id: 'spotify', oldMinorUnits: 1000, newMinorUnits: 1200 })]),
    catalog,
  );
  const { sent, failures } = await sendAll(messages, {
    projectId: 'p',
    token: 't',
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(init.headers.authorization, 'Bearer t');
      return body.message.topic === 'svc-netflix-tr'
        ? { ok: false, status: 400 }
        : { ok: true };
    },
  });
  assert.deepEqual(sent.map((s) => s.topic), ['svc-spotify-tr']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].error, 'HTTP 400');
});

test('sendAll: 429 bir kez backoff\'la yeniden denenir', async () => {
  let calls = 0;
  const sleeps = [];
  const { sent, failures } = await sendAll(buildPushMessages(artifact([change()]), catalog), {
    projectId: 'p',
    token: 't',
    sleep: async (ms) => sleeps.push(ms),
    fetchImpl: async () => (++calls === 1 ? { ok: false, status: 429 } : { ok: true }),
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [60_000]);
  assert.equal(sent.length, 1);
  assert.equal(failures.length, 0);
});

// ---- M8b: plan-bazlı push ----

const planCatalog = {
  services: [
    {
      id: 'netflix',
      name: 'Netflix',
      plans: [{ id: 'standart', name: 'Standart', prices: {} }],
    },
  ],
};

test('M8b: planId\'li değişiklik plan topic\'ine gider, payload planId+planName taşır', () => {
  const [msg] = buildPushMessages(
    artifact([change({ planId: 'standart' })]),
    planCatalog,
  );
  assert.equal(msg.message.topic, 'svc-netflix-tr-standart');
  assert.equal(msg.message.data.planId, 'standart');
  assert.equal(msg.message.data.planName, 'Standart');
  assert.equal(msg.message.android.collapse_key, 'svc-netflix-tr-standart');
});

test('M8b: planId\'siz (taban) değişiklikte plan alanları HİÇ yok — eski sözleşme birebir', () => {
  const [msg] = buildPushMessages(artifact([change()]), planCatalog);
  assert.equal(msg.message.topic, 'svc-netflix-tr');
  assert.ok(!('planId' in msg.message.data));
  assert.ok(!('planName' in msg.message.data));
});

test('M8b: katalogda adı çözülemeyen plan (silinmiş) mesajı ATLANIR — yanlış push yerine hiç', () => {
  const msgs = buildPushMessages(
    artifact([change({ planId: 'silinmis-plan' }), change()]),
    planCatalog,
  );
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].message.topic, 'svc-netflix-tr');
});

// M8c: kanal-only değişim push üretmez (v1 kararı — kanal topic'i yok,
// plan topic'ine basmak yanlış kitle olur).
test('channel alanlı değişiklik push mesajı ÜRETMEZ (M8c guard)', () => {
  const artifact = {
    schemaVersion: 1,
    changes: [
      {
        id: 'claude', region: 'tr', planId: 'max-20x', channel: 'apple',
        oldMinorUnits: 999999, newMinorUnits: 1299999, currency: 'TRY',
      },
      {
        id: 'claude', region: 'tr', planId: 'pro',
        oldMinorUnits: 79999, newMinorUnits: 99999, currency: 'TRY',
      },
    ],
  };
  const catalog = {
    services: [{
      id: 'claude', name: 'Claude',
      plans: [{ id: 'pro', name: 'Pro' }, { id: 'max-20x', name: 'Max 20x' }],
    }],
  };
  const messages = buildPushMessages(artifact, catalog);
  assert.equal(messages.length, 1); // yalnız kanalsız plan değişimi
  assert.equal(messages[0].message.topic, 'svc-claude-tr-pro');
});
