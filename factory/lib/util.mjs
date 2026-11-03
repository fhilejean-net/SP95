import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function localDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function localDate(date, timeZone) {
  const parts = localDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function timeZoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  });
  const label = formatter
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = /^GMT([+-])(\d{2}):?(\d{2})?$/.exec(label);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * ((Number(match[2]) * 60 + Number(match[3] ?? 0)) * 60 * 1000);
}

export function zonedMidnightUtc(dateString, timeZone) {
  const [year, month, day] = dateString.split('-').map(Number);
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let candidate = naive;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(candidate), timeZone);
    const next = naive - offset;
    if (next === candidate) break;
    candidate = next;
  }
  return new Date(candidate);
}

export function localDayRange(dateString, timeZone) {
  const start = zonedMidnightUtc(dateString, timeZone);
  const [year, month, day] = dateString.split('-').map(Number);
  const nextString = new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
  const end = zonedMidnightUtc(nextString, timeZone);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function isoWeekKey(date) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((copy - yearStart) / 86400000 + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatMoney(cents, currency = 'EUR') {
  if (cents === null || cents === undefined) return 'pas de donnée';
  return new Intl.NumberFormat('fr-CH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hmac(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function parseKey(value, label) {
  assert(value, `${label} manquant`);
  const key = Buffer.from(value, 'base64');
  assert(key.length === 32, `${label} doit contenir 32 octets encodés en base64`);
  return key;
}

export function encryptText(plainText, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: encrypted.toString('base64url'),
  };
}

export function decryptText(payload, key) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
