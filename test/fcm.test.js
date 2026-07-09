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
