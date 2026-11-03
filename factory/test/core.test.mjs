import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-factory-core-'));
const copy = path.join(temp, 'ventures');
fs.cpSync(path.join(root, 'ventures'), copy, { recursive: true });
const active = JSON.parse(fs.readFileSync(path.join(copy, 'venture-01', 'venture.json'), 'utf8'));
active.id = 'test-active';
active.slug = 'test-active';
active.name = 'Test actif';
active.status = 'active';
active.kind = 'internal';
active.landing = null;
active.createdAt = '2025-01-01T00:00:00.000Z';
active.milestones = [
  { metric: 'visitors', target: 100, days: 14 },
  { metric: 'signups', target: 10, days: 21 },
  { metric: 'payments', target: 1, days: 45 },
];
fs.mkdirSync(path.join(copy, 'test-active'), { recursive: true });
fs.writeFileSync(path.join(copy, 'test-active', 'venture.json'), JSON.stringify(active, null, 2));

process.env.FACTORY_DATA_DIR = path.join(temp, 'data');
process.env.FACTORY_REPORTS_DIR = path.join(temp, 'reports');
process.env.FACTORY_IDEAS_FILE = path.join(temp, 'ideas.json');
process.env.FACTORY_VENTURES_DIR = copy;
process.env.FACTORY_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.FACTORY_ANALYTICS_SECRET = 'test-analytics-secret';
process.env.FACTORY_DASHBOARD_PASSWORD = 'correct-horse-battery-staple';
process.env.FACTORY_SESSION_SECRET = 'test-session-secret';
process.env.FACTORY_DEV_OUTBOX = '1';
delete process.env.OPENAI_API_KEY;

const ledger = await import('../lib/ledger.mjs');
const events = await import('../lib/events.mjs');
const signups = await import('../lib/signups.mjs');
const ideas = await import('../lib/ideas.mjs');
const rules = await import('../lib/rules.mjs');
const approvals = await import('../lib/approvals.mjs');
const reports = await import('../lib/reports.mjs');
const stripe = await import('../lib/stripe.mjs');
const auth = await import('../lib/auth.mjs');
const ventures = await import('../lib/ventures.mjs');

test('ledger records, deduplicates and computes net profit', () => {
  assert.equal(ledger.summarize().hasData, false);
  const first = ledger.recordRevenue({
    ventureId: 'venture-01',
    amountCents: 5000,
    currency: 'EUR',
    source: 'stripe',
    externalId: 'evt_1',
    occurredAt: '2026-11-03T10:00:00.000Z',
  });
  const duplicate = ledger.recordRevenue({
    ventureId: 'venture-01',
    amountCents: 5000,
    currency: 'EUR',
    source: 'stripe',
    externalId: 'evt_1',
    occurredAt: '2026-11-03T10:00:00.000Z',
  });
  assert.equal(first.id, duplicate.id);
  ledger.recordExpense({
    ventureId: 'test-active',
    amountCents: 1200,
    currency: 'EUR',
    source: 'manual',
    externalId: 'hosting-1',
    occurredAt: '2026-11-03T10:00:00.000Z',
  });
  ledger.recordEntry({
    type: 'refund',
    ventureId: 'venture-01',
    amountCents: 500,
    currency: 'EUR',
    source: 'stripe',
    externalId: 'refund_1',
    occurredAt: '2026-11-03T10:00:00.000Z',
  });
  const summary = ledger.summarize();
  assert.equal(summary.hasData, true);
  assert.equal(summary.revenue, 5000);
  assert.equal(summary.expenses, 1200);
  assert.equal(summary.refunds, 500);
  assert.equal(summary.net, 3300);
  assert.equal(summary.byVenture['venture-01'].net, 4500);
});

test('analytics gives daily unique visitors without cookies', () => {
  const date = new Date().toISOString().slice(0, 10);
  const visitor = events.visitorHash('127.0.0.1', 'test-agent', date);
  events.recordEvent({ ventureId: 'venture-01', type: 'pageview', pathName: '/', visitor });
  events.recordEvent({ ventureId: 'venture-01', type: 'pageview', pathName: '/', visitor });
  events.recordEvent({
    ventureId: 'venture-01',
    type: 'pageview',
    pathName: '/',
    visitor: events.visitorHash('127.0.0.2', 'test-agent', date),
  });
  const stats = events.eventStats('venture-01');
  assert.equal(stats.pageviews, 3);
  assert.equal(stats.visitors, 2);
  assert.equal(stats.hasData, true);
});

test('signups are encrypted, double opt-in and unsubscribe cleanly', () => {
  const created = signups.createSignup({
    ventureId: 'venture-01',
    email: 'Test@Example.com',
    consent: true,
    source: 'test',
  });
  assert.ok(created.token);
  assert.equal(signups.signupStatus('venture-01', 'test@example.com'), 'pending');
  const decrypted = signups.listSignups('venture-01', { decrypt: true });
  assert.equal(decrypted.at(-1).email, 'test@example.com');
  assert.equal(signups.confirmSignup(created.token).ok, true);
  assert.equal(signups.countConfirmed('venture-01'), 1);
  assert.equal(signups.confirmSignup(created.token).ok, true);
  assert.equal(signups.unsubscribe(created.unsubscribeToken).ok, true);
  assert.equal(signups.countConfirmed('venture-01'), 0);
  assert.equal(signups.signupStatus('venture-01', 'test@example.com'), 'unsubscribed');
});

test('idea scoring is bounded and generation is idempotent per week', async () => {
  const perfect = {
    title: 'Test parfait',
    evidence: 'Pas de preuve collectée',
    scores: { pain: 10, proof: 10, buildSpeed: 10, supportSimplicity: 10, seo: 10, automation: 10 },
  };
  assert.equal(ideas.scoreIdea(perfect), 10);
  assert.throws(() => ideas.scoreIdea({ ...perfect, scores: { ...perfect.scores, pain: 0 } }));
  const first = await ideas.generateWeeklyIdeas({ force: true });
  assert.ok(first.created > 0);
  const second = await ideas.generateWeeklyIdeas({ force: true });
  assert.equal(second.created, 0);
  assert.ok(ideas.rankedIdeas().every((idea) => idea.score >= 1 && idea.score <= 10));
});

test('rules kill a venture without traction and scale one with MRR', () => {
  const now = new Date('2026-11-03T12:00:00.000Z');
  const testRules = {
    milestones: [{ metric: 'visitors', target: 100, days: 14 }],
    scaleMrrCents: 10000,
    killMinVisitors: 50,
  };
  const venture = ventures.getVenture('test-active');
  const killed = rules.evaluateVenture(venture, { visitors: 5, signups: 0, payments: 0, mrrCents: 0 }, now, testRules);
  assert.equal(killed.decision, 'kill');
  const scaled = rules.evaluateVenture(venture, { visitors: 500, signups: 20, payments: 5, mrrCents: 10000 }, now, testRules);
  assert.equal(scaled.decision, 'scale');
  const held = rules.evaluateVenture(venture, { visitors: 500, signups: 20, payments: 5, mrrCents: 0 }, now, testRules);
  assert.equal(held.decision, 'hold');
});

test('approval is explicit, idempotent and applies a venture status', () => {
  const first = approvals.createApproval({
    ventureId: 'test-active',
    kind: 'venture_pause',
    title: 'Tester la pause',
    summary: 'Pause demandée par le test',
    dedupeKey: 'test-pause',
  });
  const duplicate = approvals.createApproval({
    ventureId: 'test-active',
    kind: 'venture_pause',
    title: 'Tester la pause',
    summary: 'Pause demandée par le test',
    dedupeKey: 'test-pause',
  });
  assert.equal(first.id, duplicate.id);
  approvals.decideApproval(first.id, 'approved', 'test');
  const applied = approvals.applyApproval(first.id);
  assert.equal(applied.executionError, null);
  assert.equal(ventures.getVenture('test-active').status, 'paused');
  assert.equal(approvals.applyApproval(first.id).executedAt, applied.executedAt);
});

test('daily report uses explicit no-data markers and writes history', async () => {
  const result = await reports.runDailyReport({ force: true });
  assert.equal(result.generated, true);
  assert.match(result.content ?? fs.readFileSync(result.file, 'utf8'), /pas de donnée/);
  assert.ok(fs.existsSync(result.file));
  const history = reports.listReports();
  assert.ok(history.includes(result.date));
  assert.equal(result.delivery.sent, false);
});

test('Stripe signature rejects tampering and records revenue idempotently', () => {
  const secret = 'test-webhook-secret';
  const raw = '{"id":"evt_checkout","type":"checkout.session.completed","data":{"object":{"payment_status":"paid","amount_total":2500,"currency":"eur","metadata":{"ventureId":"venture-01"}}}}';
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  assert.equal(stripe.verifyStripeSignature(raw, `t=${timestamp},v1=${signature}`, secret), true);
  assert.equal(stripe.verifyStripeSignature(`${raw} `, `t=${timestamp},v1=${signature}`, secret), false);
  const event = JSON.parse(raw);
  const first = stripe.handleStripeEvent(event);
  const second = stripe.handleStripeEvent(event);
  assert.equal(first.handled, true);
  assert.equal(first.entry.id, second.entry.id);
  assert.equal(ledger.listEntries().filter((entry) => entry.externalId === 'evt_checkout').length, 1);
});

test('venture template creates a private draft landing', () => {
  const created = ventures.createVenture({
    id: 'test-template',
    name: 'Template test',
    description: 'Une venture de test temporaire.',
  });
  assert.equal(created.status, 'draft');
  assert.equal(created.kind, 'internal');
  assert.ok(fs.existsSync(path.join(copy, 'test-template', 'landing', 'index.html')));
  assert.match(fs.readFileSync(path.join(copy, 'test-template', 'landing', 'index.html'), 'utf8'), /test-template/);
  assert.equal(ventures.getVenture('test-template').status, 'draft');
});

test('sessions are signed and CSRF is bound to the session', () => {
  assert.equal(auth.checkPassword('wrong'), false);
  assert.equal(auth.checkPassword('correct-horse-battery-staple'), true);
  const session = auth.createSession();
  const verified = auth.verifySession(session.token);
  assert.equal(verified.sub, 'owner');
  assert.equal(auth.requireCsrf(verified, session.csrf), true);
  assert.equal(auth.requireCsrf(verified, 'nope'), false);
  assert.equal(auth.verifySession(`${session.token}x`), null);
});
