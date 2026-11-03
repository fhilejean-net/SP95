import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-factory-http-'));
const copy = path.join(temp, 'ventures');
fs.cpSync(path.join(root, 'ventures'), copy, { recursive: true });

process.env.FACTORY_DATA_DIR = path.join(temp, 'data');
process.env.FACTORY_REPORTS_DIR = path.join(temp, 'reports');
process.env.FACTORY_IDEAS_FILE = path.join(temp, 'ideas.json');
process.env.FACTORY_VENTURES_DIR = copy;
process.env.FACTORY_DATA_KEY = Buffer.alloc(32, 11).toString('base64');
process.env.FACTORY_ANALYTICS_SECRET = 'test-http-analytics';
process.env.FACTORY_DASHBOARD_PASSWORD = 'correct-horse-battery-staple';
process.env.FACTORY_SESSION_SECRET = 'test-http-session';
process.env.FACTORY_DEV_OUTBOX = '1';
process.env.LEGAL_OPERATOR = 'Test Operator';
process.env.LEGAL_ADDRESS = '1 rue du Test, 1000 Testville';
process.env.LEGAL_EMAIL = 'privacy@example.test';
process.env.LEGAL_HOST = 'Test Host';

const { startServer } = await import('../server.mjs');

test('HTTP surface protects the dashboard and serves the real landing', async (t) => {
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const dashboard = await fetch(`${base}/dashboard`, { redirect: 'manual' });
  assert.equal(dashboard.status, 302);
  assert.match(dashboard.headers.get('location'), /\/dashboard\/login$/);

  const denied = await fetch(`${base}/dashboard/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=wrong',
    redirect: 'manual',
  });
  assert.equal(denied.status, 401);

  const login = await fetch(`${base}/dashboard/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=correct-horse-battery-staple',
    redirect: 'manual',
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  const authed = await fetch(`${base}/dashboard`, { headers: { cookie } });
  assert.equal(authed.status, 200);
  assert.match(await authed.text(), /CASH/);

  const landing = await fetch(`${base}/v/venture-01`);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Mémo/);

  const legal = await fetch(`${base}/legal/privacy?venture=venture-01`);
  assert.equal(legal.status, 200);
  assert.match(await legal.text(), /Confidentialité/);

  const event = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ venture: 'venture-01', type: 'pageview', path: '/' }),
  });
  assert.equal(event.status, 202);

  const email = `http-${Date.now()}@example.com`;
  const signup = await fetch(`${base}/api/ventures/venture-01/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, consent: true }),
  });
  assert.equal(signup.status, 201);
  const payload = await signup.json();
  assert.equal(payload.status, 'confirmation_sent');
  assert.ok(payload.devConfirmUrl);

  const confirmUrl = new URL(payload.devConfirmUrl);
  const confirm = await fetch(`${base}${confirmUrl.pathname}${confirmUrl.search}`);
  assert.equal(confirm.status, 200);

  const second = await fetch(`${base}/api/ventures/venture-01/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, consent: true }),
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).status, 'already_confirmed');

  const traversal = await fetch(`${base}/v/venture-01/../../factory/server.mjs`);
  assert.notEqual(traversal.status, 200);
});
