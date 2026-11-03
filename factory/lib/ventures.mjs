import fs from 'node:fs';
import path from 'node:path';
import { assert, escapeHtml, isIsoDate, nowIso } from './util.mjs';
import { readJson, venturesDir, writeJson } from './storage.mjs';

const STATUSES = new Set(['draft', 'active', 'paused', 'killed', 'legacy']);
const KINDS = new Set(['internal', 'external']);
const MODELS = new Set(['free', 'one_time', 'subscription']);

function validateManifest(venture, directory) {
  assert(/^[a-z0-9][a-z0-9-]{1,63}$/.test(venture.id), `Identifiant de venture invalide : ${directory}`);
  assert(typeof venture.name === 'string' && venture.name.trim().length > 0, `Nom manquant : ${directory}`);
  assert(STATUSES.has(venture.status), `Statut inconnu : ${venture.status}`);
  assert(KINDS.has(venture.kind), `Type de venture inconnu : ${venture.kind}`);
  assert(isIsoDate(venture.createdAt), `createdAt invalide : ${directory}`);
  assert(venture.product && MODELS.has(venture.product.model), `Modèle de produit invalide : ${directory}`);
  assert(Number.isInteger(venture.product.priceCents) && venture.product.priceCents >= 0, `Prix invalide : ${directory}`);
  assert(/^[A-Z]{3}$/.test(venture.product.currency), `Devise invalide : ${directory}`);
  if (venture.product.model !== 'free') {
    assert(venture.product.priceCents > 0, `Un produit payant doit avoir un prix : ${directory}`);
  }
  assert(Array.isArray(venture.milestones ?? []), `Jalons invalides : ${directory}`);
  for (const milestone of venture.milestones ?? []) {
    assert(['visitors', 'signups', 'payments'].includes(milestone.metric), 'Métrique de jalon inconnue');
    assert(Number.isInteger(milestone.target) && milestone.target > 0, 'Cible de jalon invalide');
    assert(Number.isInteger(milestone.days) && milestone.days > 0, 'Délai de jalon invalide');
  }
  assert(venture.budget && Number.isInteger(venture.budget.hours) && venture.budget.hours >= 0, `Budget temps invalide : ${directory}`);
  assert(Number.isInteger(venture.budget.moneyCents) && venture.budget.moneyCents >= 0, `Budget argent invalide : ${directory}`);
  if (venture.landing !== null && venture.landing !== undefined) {
    assert(typeof venture.landing === 'string' && !venture.landing.includes('..'), `Landing invalide : ${directory}`);
  }
  return venture;
}

export function listVentures() {
  if (!fs.existsSync(venturesDir)) return [];
  return fs
    .readdirSync(venturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => {
      const file = path.join(venturesDir, entry.name, 'venture.json');
      if (!fs.existsSync(file)) return null;
      const venture = readJson(file, null);
      if (!venture) return null;
      validateManifest(venture, entry.name);
      return venture;
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getVenture(id) {
  return listVentures().find((venture) => venture.id === id) ?? null;
}

export function publicVentures() {
  return listVentures().filter((venture) => ['active', 'legacy'].includes(venture.status));
}

export function ventureDirectory(id) {
  assert(/^[a-z0-9][a-z0-9-]{1,63}$/.test(id), 'Identifiant de venture invalide');
  return path.join(venturesDir, id);
}

export function landingDirectory(venture) {
  if (!venture.landing) return null;
  return path.join(ventureDirectory(venture.id), venture.landing);
}

export function setVentureStatus(id, status) {
  assert(STATUSES.has(status), 'Statut invalide');
  const directory = ventureDirectory(id);
  const file = path.join(directory, 'venture.json');
  const venture = readJson(file, null);
  assert(venture, 'Venture introuvable');
  venture.status = status;
  venture.updatedAt = nowIso();
  writeJson(file, venture, 0o644);
  return venture;
}

export function updateVentureProduct(id, patch) {
  const directory = ventureDirectory(id);
  const file = path.join(directory, 'venture.json');
  const venture = readJson(file, null);
  assert(venture, 'Venture introuvable');
  venture.product = { ...venture.product, ...patch };
  validateManifest(venture, id);
  venture.updatedAt = nowIso();
  writeJson(file, venture, 0o644);
  return venture;
}

export function createVenture({ id, name, description, productModel = 'free', priceCents = 0, currency = 'EUR' }) {
  assert(/^[a-z0-9][a-z0-9-]{1,63}$/.test(id), 'Identifiant attendu : minuscules, chiffres et tirets');
  const target = ventureDirectory(id);
  assert(!fs.existsSync(target), `La venture ${id} existe déjà`);
  const template = path.join(venturesDir, '_template');
  assert(fs.existsSync(template), 'Template de venture introuvable');
  fs.cpSync(template, target, { recursive: true });
  const file = path.join(target, 'venture.json');
  const manifest = readJson(file, null);
  assert(manifest, 'Manifeste du template illisible');
  const rendered = {
    ...manifest,
    id,
    name,
    description,
    status: 'draft',
    kind: 'internal',
    createdAt: nowIso(),
    product: {
      ...manifest.product,
      name,
      model: productModel,
      priceCents,
      currency,
      stripePriceId: '',
    },
    milestones: [...manifest.milestones],
  };
  validateManifest(rendered, id);
  writeJson(file, rendered, 0o644);
  const replacements = {
    '{{ID}}': id,
    '{{NAME}}': escapeHtml(name),
    '{{DESCRIPTION}}': escapeHtml(description),
  };
  const renderDirectory = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        renderDirectory(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.name === 'venture.json') continue;
      let text = fs.readFileSync(entryPath, 'utf8');
      for (const [token, value] of Object.entries(replacements)) text = text.replaceAll(token, value);
      fs.writeFileSync(entryPath, text);
    }
  };
  renderDirectory(target);
  return rendered;
}
