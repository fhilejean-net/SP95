import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hmac, isEmail, localDate, nowIso } from './lib/util.mjs';
import { ensureDataDirs, publicDir } from './lib/storage.mjs';
import { loadFactoryConfig } from './lib/config.mjs';
import { getVenture, landingDirectory, listVentures } from './lib/ventures.mjs';
import { recordEvent, visitorHash } from './lib/events.mjs';
import { createSignup, signupStatus } from './lib/signups.mjs';
import { createCheckoutSession, handleStripeEvent, stripeConfigured, verifyStripeSignature } from './lib/stripe.mjs';
import { applyApproval, decideApproval } from './lib/approvals.mjs';
import { readReport } from './lib/reports.mjs';
import { runReport, setPaused } from './lib/agent.mjs';
import { emailConfigured, sendEmail } from './lib/notify.mjs';
import {
  checkPassword,
  clearSessionCookie,
  createSession,
  dashboardConfigured,
  readSession,
  requireCsrf,
  secureCookie,
  serializeSession,
} from './lib/auth.mjs';
import { legalConfigured, renderDashboard, renderLegal, renderLogin, renderMessage, renderReport, renderSetup } from './lib/dashboard.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardCss = path.join(publicDir, 'dashboard.css');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const rateBuckets = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.reset < now) {
    rateBuckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

function clientIp(req) {
  if (process.env.FACTORY_TRUST_PROXY === '1') {
    return String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'unknown';
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
  );
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8', extra = {}) {
  securityHeaders(res);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': payload.length, ...extra });
  res.end(payload);
}

function json(res, status, value, extra = {}) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...extra });
}

function redirect(res, location, extra = {}) {
  send(res, 302, '', 'text/plain; charset=utf-8', { Location: location, ...extra });
}

function readBody(req, limit = 32_768) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Corps de requête trop volumineux'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, res) {
  try {
    const raw = await readBody(req);
    if (raw.length === 0) return {};
    return JSON.parse(raw.toString('utf8'));
  } catch (error) {
    json(res, error.statusCode ?? 400, { error: 'Requête JSON invalide' });
    return null;
  }
}

async function readForm(req, res) {
  try {
    const raw = await readBody(req);
    return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  } catch (error) {
    send(res, error.statusCode ?? 400, 'Requête invalide');
    return null;
  }
}

function serveFile(res, file, { cache = 'no-store' } = {}) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    const extension = path.extname(file).toLowerCase();
    if (!MIME[extension]) return false;
    send(res, 200, fs.readFileSync(file), MIME[extension], { 'Cache-Control': cache });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function safeStatic(baseDirectory, relative) {
  const base = path.resolve(baseDirectory);
  const target = path.resolve(base, relative || 'index.html');
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) return null;
  if (target.split(path.sep).some((part) => part.startsWith('.'))) return null;
  return target;
}

function landing(res, venture, pathname) {
  const directory = landingDirectory(venture);
  if (!directory) return false;
  const rest = pathname.replace(`/v/${venture.id}`, '').replace(/^\//, '') || 'index.html';
  const target = safeStatic(directory, rest);
  if (!target) return false;
  return serveFile(res, target, { cache: 'no-store' });
}

function sessionFrom(req) {
  return readSession(req);
}

function requireDashboard(req, res) {
  if (!dashboardConfigured()) {
    send(res, 503, renderSetup(), 'text/html; charset=utf-8');
    return null;
  }
  const session = sessionFrom(req);
  if (!session) {
    redirect(res, '/dashboard/login');
    return null;
  }
  return session;
}

function checkCsrfOrReject(req, res, session, token) {
  if (!requireCsrf(session, token)) {
    send(res, 403, renderMessage('Requête refusée', 'Jeton CSRF invalide. Recharge le dashboard.'), 'text/html; charset=utf-8');
    return false;
  }
  return true;
}

function queryValue(url, name, fallback = '') {
  return url.searchParams.get(name) ?? fallback;
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return json(res, 400, { error: 'Chemin invalide' });
  }
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
  if (pathname === '') pathname = '/';
  const ip = clientIp(req);

  if (req.method === 'GET' && pathname === '/') return redirect(res, '/dashboard');
  if (req.method === 'GET' && pathname === '/health') {
    const config = loadFactoryConfig();
    return json(res, 200, {
      ok: true,
      paused: config.paused,
      autonomyLevel: config.autonomyLevel,
      ventures: listVentures().length,
      now: nowIso(),
    });
  }
  if (req.method === 'GET' && pathname === '/dashboard.css') {
    return serveFile(res, dashboardCss, { cache: 'public, max-age=300' }) || json(res, 404, { error: 'Introuvable' });
  }
  if (req.method === 'GET' && pathname === '/track.js') {
    return serveFile(res, path.join(publicDir, 'track.js'), { cache: 'public, max-age=300' }) || json(res, 404, { error: 'Introuvable' });
  }
  if (req.method === 'GET' && pathname === '/landing.js') {
    return serveFile(res, path.join(publicDir, 'landing.js'), { cache: 'public, max-age=300' }) || json(res, 404, { error: 'Introuvable' });
  }

  if (req.method === 'GET' && pathname === '/dashboard/login') {
    if (!dashboardConfigured()) return send(res, 503, renderSetup(), 'text/html; charset=utf-8');
    return send(res, 200, renderLogin(), 'text/html; charset=utf-8');
  }
  if (req.method === 'POST' && pathname === '/dashboard/login') {
    if (!dashboardConfigured()) return send(res, 503, renderSetup(), 'text/html; charset=utf-8');
    if (!rateLimit(`login:${ip}`, 6, 15 * 60_000)) return send(res, 429, renderLogin({ error: 'Trop de tentatives. Réessaie dans quinze minutes.' }), 'text/html; charset=utf-8');
    const form = await readForm(req, res);
    if (!form) return;
    if (!checkPassword(form.password)) return send(res, 401, renderLogin({ error: 'Mot de passe incorrect.' }), 'text/html; charset=utf-8');
    const session = createSession();
    return redirect(res, '/dashboard', { 'Set-Cookie': serializeSession(session.token, { secure: secureCookie(req) }) });
  }
  if (req.method === 'POST' && pathname === '/dashboard/logout') {
    const session = readSession(req);
    if (!session) return redirect(res, '/dashboard/login');
    const form = await readForm(req, res);
    if (!form) return;
    if (!checkCsrfOrReject(req, res, session, form.csrf)) return;
    return redirect(res, '/dashboard/login', { 'Set-Cookie': clearSessionCookie({ secure: secureCookie(req) }) });
  }
  if (req.method === 'GET' && pathname === '/dashboard') {
    const session = requireDashboard(req, res);
    if (!session) return;
    const config = loadFactoryConfig();
    return send(res, 200, renderDashboard({ config, session, flash: queryValue(url, 'flash') }), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && pathname.startsWith('/dashboard/reports/')) {
    const session = requireDashboard(req, res);
    if (!session) return;
    const date = pathname.slice('/dashboard/reports/'.length);
    const content = readReport(date);
    if (!content) return send(res, 404, renderMessage('Rapport introuvable', 'Aucun rapport pour cette date.'), 'text/html; charset=utf-8');
    return send(res, 200, renderReport(date, content), 'text/html; charset=utf-8');
  }
  if (req.method === 'POST' && pathname.startsWith('/dashboard/')) {
    const session = requireDashboard(req, res);
    if (!session) return;
    const form = await readForm(req, res);
    if (!form) return;
    if (!checkCsrfOrReject(req, res, session, form.csrf)) return;
    if (pathname === '/dashboard/pause' || pathname === '/dashboard/resume') {
      const paused = pathname.endsWith('/pause');
      setPaused(paused);
      return redirect(res, `/dashboard?flash=${encodeURIComponent(paused ? 'Tout est en pause.' : 'Reprise effectuée.')}`);
    }
    if (pathname === '/dashboard/report') {
      try {
        const result = await runReport({ force: true });
        const message = result.delivery.sent ? 'Rapport généré et envoyé.' : `Rapport généré. Livraison : ${result.delivery.reason}`;
        return redirect(res, `/dashboard?flash=${encodeURIComponent(message)}`);
      } catch (error) {
        return redirect(res, `/dashboard?flash=${encodeURIComponent(`Rapport impossible : ${error.message}`)}`);
      }
    }
    if (pathname.startsWith('/dashboard/approvals/')) {
      const id = pathname.slice('/dashboard/approvals/'.length);
      const decision = form.decision === 'approved' ? 'approved' : form.decision === 'rejected' ? 'rejected' : null;
      if (!decision) return redirect(res, `/dashboard?flash=${encodeURIComponent('Décision invalide.')}`);
      try {
        decideApproval(id, decision, 'owner', 'Décision depuis le dashboard');
        const applied = decision === 'approved' ? applyApproval(id) : null;
        const message = decision === 'rejected'
          ? 'Action refusée.'
          : applied?.executionError
            ? `Approuvée, exécution manuelle requise : ${applied.executionError}`
            : 'Action approuvée et exécutée.';
        return redirect(res, `/dashboard?flash=${encodeURIComponent(message)}`);
      } catch (error) {
        return redirect(res, `/dashboard?flash=${encodeURIComponent(error.message)}`);
      }
    }
    return json(res, 404, { error: 'Action inconnue' });
  }

  if (req.method === 'GET' && pathname.startsWith('/v/')) {
    if (!legalConfigured()) {
      return send(res, 503, renderMessage('Site en préparation', 'Les mentions légales de l’éditeur ne sont pas encore configurées. La page publique reste désactivée.'), 'text/html; charset=utf-8');
    }
    const parts = pathname.split('/').filter(Boolean);
    const id = parts[1];
    const venture = getVenture(id);
    if (!venture || !['active', 'legacy'].includes(venture.status)) return send(res, 404, renderMessage('Venture introuvable', 'Cette page n’est pas publiée.'), 'text/html; charset=utf-8');
    if (landing(res, venture, pathname)) return;
    return send(res, 404, renderMessage('Page introuvable', 'Cette page n’existe pas.'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && pathname.startsWith('/legal/')) {
    const kind = pathname.slice('/legal/'.length);
    const venture = getVenture(queryValue(url, 'venture'));
    const page = renderLegal(kind, venture?.name ?? 'cette venture', venture?.id ?? 'venture-01');
    return send(res, page.status, page.html, 'text/html; charset=utf-8');
  }

  if (req.method === 'POST' && pathname === '/api/events') {
    if (!rateLimit(`event:${ip}`, 180, 60_000)) return json(res, 429, { error: 'Trop d’événements' });
    const body = await readJson(req, res);
    if (body === null) return;
    const venture = getVenture(String(body.venture ?? ''));
    if (!venture || !['active', 'legacy'].includes(venture.status)) return json(res, 404, { error: 'Venture inconnue' });
    const type = String(body.type ?? 'pageview');
    if (!['pageview', 'cta', 'signup_start', 'checkout_start'].includes(type)) return json(res, 400, { error: 'Type invalide' });
    const referrer = String(body.referrer ?? '');
    let referrerHost = '';
    try {
      referrerHost = referrer ? new URL(referrer).origin : '';
    } catch {
      referrerHost = '';
    }
    const date = localDate(new Date(), 'UTC');
    recordEvent({
      ventureId: venture.id,
      type,
      pathName: String(body.path ?? url.pathname),
      referrer: referrerHost,
      visitor: visitorHash(ip, String(req.headers['user-agent'] ?? ''), date),
    });
    return json(res, 202, { ok: true });
  }

  const signupMatch = /^\/api\/ventures\/([a-z0-9-]+)\/signup$/.exec(pathname);
  if (req.method === 'POST' && signupMatch) {
    const venture = getVenture(signupMatch[1]);
    if (!venture || !['active', 'legacy'].includes(venture.status)) return json(res, 404, { error: 'Venture inconnue' });
    if (!rateLimit(`signup:${ip}`, 6, 15 * 60_000)) return json(res, 429, { error: 'Trop de tentatives' });
    const body = await readJson(req, res);
    if (body === null) return;
    if (!isEmail(body.email)) return json(res, 400, { error: 'Adresse email invalide' });
    if (body.consent !== true) return json(res, 400, { error: 'Consentement obligatoire' });
    if (!emailConfigured() && process.env.FACTORY_DEV_OUTBOX !== '1') {
      return json(res, 503, { error: 'Email non configuré. Aucune inscription ne peut être confirmée.' });
    }
    const status = signupStatus(venture.id, body.email);
    if (status === 'confirmed') return json(res, 200, { ok: true, status: 'already_confirmed' });
    if (status === 'unsubscribed') return json(res, 409, { error: 'Cette adresse s’est désinscrite. Contacte le support pour revenir.' });
    const result = createSignup({
      ventureId: venture.id,
      email: body.email,
      consent: true,
      source: 'landing',
      ipHash: hmac(process.env.FACTORY_ANALYTICS_SECRET ?? 'local', ip).slice(0, 32),
    });
    if (result.existing && !result.token) return json(res, 200, { ok: true, status: 'already_pending' });
    const config = loadFactoryConfig();
    const confirmUrl = `${config.baseUrl}/api/confirm?token=${encodeURIComponent(result.token)}`;
    const unsubscribeUrl = `${config.baseUrl}/api/unsubscribe?token=${encodeURIComponent(result.unsubscribeToken)}`;
    try {
      await sendEmail({
        to: body.email,
        subject: `Confirme ton inscription — ${venture.name}`,
        text: `Confirme ton adresse : ${confirmUrl}\n\nTu peux te désinscrire à tout moment : ${unsubscribeUrl}\n\n${venture.name}`,
      });
    } catch (error) {
      return json(res, 503, { error: error.message });
    }
    return json(res, 201, {
      ok: true,
      status: 'confirmation_sent',
      ...(process.env.FACTORY_DEV_OUTBOX === '1' ? { devConfirmUrl: confirmUrl } : {}),
    });
  }

  if (req.method === 'GET' && pathname === '/api/confirm') {
    const { confirmSignup } = await import('./lib/signups.mjs');
    const token = queryValue(url, 'token');
    if (!token) return send(res, 400, renderMessage('Confirmation impossible', 'Ce lien est incomplet.'), 'text/html; charset=utf-8');
    const result = confirmSignup(token);
    if (!result.ok) return send(res, 400, renderMessage('Confirmation impossible', result.reason === 'expired' ? 'Ce lien a expiré.' : 'Ce lien est invalide ou déjà utilisé.'), 'text/html; charset=utf-8');
    return send(res, 200, renderMessage('Inscription confirmée', 'Ton adresse est confirmée. Tu peux te désinscrire à tout moment depuis chaque email.'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && pathname === '/api/unsubscribe') {
    const { unsubscribe } = await import('./lib/signups.mjs');
    const token = queryValue(url, 'token');
    if (!token) return send(res, 400, renderMessage('Désinscription impossible', 'Ce lien est incomplet.'), 'text/html; charset=utf-8');
    const result = unsubscribe(token);
    if (!result.ok) return send(res, 400, renderMessage('Désinscription impossible', 'Ce lien est invalide.'), 'text/html; charset=utf-8');
    return send(res, 200, renderMessage('Désinscription effectuée', 'Ton adresse ne recevra plus ces emails.'), 'text/html; charset=utf-8');
  }

  const checkoutMatch = /^\/api\/ventures\/([a-z0-9-]+)\/checkout$/.exec(pathname);
  if (req.method === 'POST' && checkoutMatch) {
    const venture = getVenture(checkoutMatch[1]);
    if (!venture || !['active', 'legacy'].includes(venture.status)) return json(res, 404, { error: 'Venture inconnue' });
    if (venture.product.model === 'free') return json(res, 400, { error: 'Cette venture est gratuite' });
    if (!stripeConfigured()) return json(res, 503, { error: 'Stripe non configuré' });
    const config = loadFactoryConfig();
    try {
      const session = await createCheckoutSession({
        venture,
        successUrl: `${config.baseUrl}/v/${venture.id}/?paid=1`,
        cancelUrl: `${config.baseUrl}/v/${venture.id}/?cancelled=1`,
      });
      recordEvent({
        ventureId: venture.id,
        type: 'checkout_start',
        pathName: '/checkout',
        referrer: '',
        visitor: visitorHash(ip, String(req.headers['user-agent'] ?? ''), localDate(new Date(), 'UTC')),
      });
      return json(res, 201, session);
    } catch (error) {
      return json(res, 503, { error: error.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/stripe/webhook') {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return json(res, 503, { error: 'Webhook non configuré' });
    const raw = await readBody(req, 256_000);
    if (!verifyStripeSignature(raw.toString('utf8'), req.headers['stripe-signature'], secret)) {
      return json(res, 400, { error: 'Signature Stripe invalide' });
    }
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(res, 400, { error: 'JSON Stripe invalide' });
    }
    try {
      const result = handleStripeEvent(event);
      return json(res, 200, { received: true, result });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  return json(res, 404, { error: 'Introuvable' });
}

export function createServer() {
  ensureDataDirs();
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error.statusCode ?? 500;
      if (status >= 500) console.error('[cash-factory]', error.message);
      if (res.headersSent) return;
      if (req.url?.startsWith('/api/')) json(res, status, { error: status >= 500 ? 'Erreur interne' : error.message });
      else send(res, status, renderMessage('Erreur', status >= 500 ? 'Erreur interne. Consulte les logs du service.' : error.message), 'text/html; charset=utf-8');
    });
  });
}

export async function startServer({ port = Number(process.env.PORT ?? 4100), host = process.env.FACTORY_HOST ?? '127.0.0.1' } = {}) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, port: server.address().port, host };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { startScheduler } = await import('./lib/agent.mjs');
  const { server, port, host } = await startServer();
  startScheduler();
  console.log(`Cash Factory sur http://${host}:${port}`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
