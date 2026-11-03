import fs from 'node:fs';
import path from 'node:path';
import { assert, decryptText, encryptText, hmac, isEmail, normalizeEmail, nowIso, parseKey, randomToken } from './util.mjs';
import { dataPath, ensureDataDirs, listFiles, readJson, updateJson } from './storage.mjs';

const FILE_VERSION = 1;

function dataKey() {
  return parseKey(process.env.FACTORY_DATA_KEY, 'FACTORY_DATA_KEY');
}

function storeFile(ventureId) {
  assert(/^[a-z0-9][a-z0-9-]{1,63}$/.test(ventureId), 'Venture invalide');
  return dataPath('signups', `${ventureId}.json`);
}

function readStore(ventureId) {
  return readJson(storeFile(ventureId), { version: FILE_VERSION, records: [] });
}

function tokenHash(token) {
  return hmac(dataKey(), `token:${token}`);
}

function emailHash(email) {
  return hmac(dataKey(), `email:${normalizeEmail(email)}`);
}

export function signupStatus(ventureId, email) {
  const store = readStore(ventureId);
  const hash = emailHash(email);
  const record = store.records.find((item) => item.emailHash === hash);
  if (!record) return 'new';
  if (record.unsubscribedAt) return 'unsubscribed';
  if (record.confirmedAt) return 'confirmed';
  return 'pending';
}

export function createSignup({ ventureId, email, consent, source = 'landing', ipHash = '' }) {
  assert(consent === true, 'Le consentement est obligatoire');
  assert(isEmail(email), 'Adresse email invalide');
  ensureDataDirs();
  const normalized = normalizeEmail(email);
  const hash = emailHash(normalized);
  return updateJson(storeFile(ventureId), { version: FILE_VERSION, records: [] }, (store) => {
    const existing = store.records.find((item) => item.emailHash === hash);
    if (existing && !existing.unsubscribedAt) {
      return { value: store, result: { record: existing, token: null, existing: true } };
    }
    const token = randomToken(32);
    const unsubscribe = randomToken(32);
    const record = {
      id: `sig_${randomToken(8)}`,
      emailHash: hash,
      emailEnc: encryptText(normalized, dataKey()),
      consentAt: nowIso(),
      createdAt: nowIso(),
      confirmedAt: null,
      unsubscribedAt: null,
      confirmTokenHash: tokenHash(token),
      confirmExpiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      unsubscribeTokenHash: tokenHash(unsubscribe),
      consentSource: String(source).slice(0, 100),
      ipHash: String(ipHash).slice(0, 64),
    };
    store.records.push(record);
    return { value: store, result: { record, token, unsubscribeToken: unsubscribe, existing: false } };
  });
}

export function confirmSignup(token) {
  assert(typeof token === 'string' && token.length >= 20, 'Jeton invalide');
  const hash = tokenHash(token);
  const files = listFiles(dataPath('signups'), '.json');
  for (const file of files) {
    const ventureId = path.basename(file, '.json');
    const store = readJson(path.join(dataPath('signups'), file), { records: [] });
    const record = store.records.find((item) => item.confirmTokenHash === hash);
    if (!record) continue;
    if (record.confirmExpiresAt < nowIso()) return { ok: false, reason: 'expired' };
    if (record.unsubscribedAt) return { ok: false, reason: 'unsubscribed' };
    if (record.confirmedAt) return { ok: true, already: true, ventureId };
    return updateJson(path.join(dataPath('signups'), file), { records: [] }, (state) => {
      const target = state.records.find((item) => item.id === record.id);
      target.confirmedAt = nowIso();
      return { value: state, result: { ok: true, ventureId, record: target } };
    });
  }
  return { ok: false, reason: 'not_found' };
}

export function unsubscribe(token) {
  assert(typeof token === 'string' && token.length >= 20, 'Jeton invalide');
  const hash = tokenHash(token);
  const files = listFiles(dataPath('signups'), '.json');
  for (const file of files) {
    const store = readJson(path.join(dataPath('signups'), file), { records: [] });
    const record = store.records.find((item) => item.unsubscribeTokenHash === hash);
    if (!record) continue;
    return updateJson(path.join(dataPath('signups'), file), { records: [] }, (state) => {
      const target = state.records.find((item) => item.id === record.id);
      target.unsubscribedAt = nowIso();
      target.confirmedAt = null;
      return { value: state, result: { ok: true, ventureId: path.basename(file, '.json') } };
    });
  }
  return { ok: false };
}

export function countConfirmed(ventureId, from = null, to = null) {
  const records = readStore(ventureId).records.filter((record) => record.confirmedAt && !record.unsubscribedAt);
  return records.filter((record) => (!from || record.confirmedAt >= from) && (!to || record.confirmedAt < to)).length;
}

export function listSignups(ventureId, { decrypt = false } = {}) {
  const key = decrypt ? dataKey() : null;
  return readStore(ventureId).records.map((record) => ({
    ...record,
    emailEnc: undefined,
    email: decrypt ? decryptText(record.emailEnc, key) : undefined,
  }));
}

export function deleteSignup(ventureId, id) {
  return updateJson(storeFile(ventureId), { version: FILE_VERSION, records: [] }, (store) => {
    const before = store.records.length;
    store.records = store.records.filter((record) => record.id !== id);
    return { value: store, result: before !== store.records.length };
  });
}
