import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assert, randomToken, safeEqual, sha256 } from './util.mjs';

export const SESSION_COOKIE = 'factory_session';
const SESSION_TTL_SECONDS = 12 * 3600;

function sessionSecret() {
  if (process.env.FACTORY_SESSION_SECRET) return process.env.FACTORY_SESSION_SECRET;
  if (!globalThis.__factoryFallbackSessionSecret) {
    globalThis.__factoryFallbackSessionSecret = randomToken(32);
  }
  return globalThis.__factoryFallbackSessionSecret;
}

export function dashboardConfigured() {
  return Boolean(process.env.FACTORY_DASHBOARD_PASSWORD && process.env.FACTORY_DASHBOARD_PASSWORD.length >= 12);
}

export function checkPassword(input) {
  const expected = process.env.FACTORY_DASHBOARD_PASSWORD;
  if (!expected || typeof input !== 'string') return false;
  return safeEqual(sha256(`factory:${input}`), sha256(`factory:${expected}`));
}

function sign(payload) {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export function createSession() {
  const payload = Buffer.from(JSON.stringify({
    sub: 'owner',
    csrf: randomToken(18),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, csrf: JSON.parse(Buffer.from(payload, 'base64url')).csrf };
}

export function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url'));
    if (data.sub !== 'owner' || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

export function serializeSession(token, { secure = false } = {}) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL_SECONDS}`];
  if (secure) flags.push('Secure');
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${flags.join('; ')}`;
}

export function clearSessionCookie({ secure = false } = {}) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) flags.push('Secure');
  return `${SESSION_COOKIE}=; ${flags.join('; ')}`;
}

export function readSession(req) {
  const token = parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE];
  return verifySession(token);
}

export function requireCsrf(session, token) {
  assert(session, 'Session absente');
  return typeof token === 'string' && safeEqual(session.csrf, token);
}

export function sessionCsrf(session) {
  return session?.csrf ?? '';
}

export function secureCookie(req) {
  if (process.env.FACTORY_SECURE_COOKIE === '1') return true;
  if (process.env.FACTORY_TRUST_PROXY === '1') {
    return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  }
  return Boolean(req.socket.encrypted);
}

export { randomBytes };
