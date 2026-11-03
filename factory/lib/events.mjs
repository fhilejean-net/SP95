import fs from 'node:fs';
import path from 'node:path';
import { appendJsonl, dataPath, ensureDataDirs, listFiles, readJsonl } from './storage.mjs';
import { hmac, localDate, randomToken } from './util.mjs';

const EVENT_TYPES = new Set(['pageview', 'cta', 'signup_start', 'checkout_start']);
let fallbackSecret = null;

function analyticsSecret() {
  if (process.env.FACTORY_ANALYTICS_SECRET) return process.env.FACTORY_ANALYTICS_SECRET;
  if (fallbackSecret) return fallbackSecret;
  ensureDataDirs();
  const file = dataPath('analytics-secret');
  if (fs.existsSync(file)) {
    fallbackSecret = fs.readFileSync(file, 'utf8').trim();
    return fallbackSecret;
  }
  fallbackSecret = randomToken(32);
  fs.writeFileSync(file, fallbackSecret, { mode: 0o600 });
  return fallbackSecret;
}

export function visitorHash(ip, userAgent, dateString) {
  return hmac(analyticsSecret(), `${ip}|${userAgent}|${dateString}`).slice(0, 32);
}

export function eventFileName(dateString) {
  return dataPath('events', `${dateString}.jsonl`);
}

export function recordEvent({ ventureId, type, pathName, referrer, visitor, at = new Date().toISOString() }) {
  if (!EVENT_TYPES.has(type)) throw new Error('Type d’événement invalide');
  const event = {
    ventureId,
    type,
    path: String(pathName ?? '/').slice(0, 300),
    referrer: String(referrer ?? '').slice(0, 300),
    visitor,
    at,
  };
  appendJsonl(eventFileName(localDate(new Date(at), 'UTC')), event);
  return event;
}

export function readEvents(from, to) {
  const dates = listFiles(dataPath('events'), '.jsonl')
    .filter((name) => {
      const date = name.slice(0, 10);
      return (!from || `${date}T23:59:59.999Z` >= from) && (!to || `${date}T00:00:00.000Z` < to);
    });
  return dates.flatMap((name) => readJsonl(path.join(dataPath('events'), name)));
}

export function countEvents(ventureId, from, to) {
  return readEvents(from, to).filter((event) => event.ventureId === ventureId);
}

export function eventStats(ventureId, from, to) {
  const events = countEvents(ventureId, from, to);
  const pageviews = events.filter((event) => event.type === 'pageview');
  const visitors = new Set(pageviews.map((event) => event.visitor).filter(Boolean));
  return {
    hasData: events.length > 0,
    events: events.length,
    pageviews: pageviews.length,
    visitors: visitors.size,
    cta: events.filter((event) => event.type === 'cta').length,
    signupStarts: events.filter((event) => event.type === 'signup_start').length,
    checkoutStarts: events.filter((event) => event.type === 'checkout_start').length,
  };
}
