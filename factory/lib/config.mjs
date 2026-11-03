import path from 'node:path';
import { factoryRoot } from './storage.mjs';
import { readJson, writeJson } from './storage.mjs';
import { assert } from './util.mjs';

const configFile = process.env.FACTORY_CONFIG_FILE
  ? path.resolve(process.env.FACTORY_CONFIG_FILE)
  : path.join(factoryRoot, 'config', 'factory.json');

const rulesFile = process.env.FACTORY_RULES_FILE
  ? path.resolve(process.env.FACTORY_RULES_FILE)
  : path.join(factoryRoot, 'config', 'rules.json');

const defaults = {
  autonomyLevel: 1,
  paused: false,
  currency: 'EUR',
  timezone: 'Europe/Zurich',
  dailyReportHour: 8,
  weeklyIdeasDay: 1,
  weeklyIdeasHour: 9,
  spendCapDailyCents: 0,
  spendCapTotalCents: 0,
  baseUrl: 'http://localhost:4100',
  reportRecipient: '',
};

export function loadFactoryConfig() {
  const raw = readJson(configFile, defaults);
  const config = { ...defaults, ...raw };
  assert([0, 1, 2].includes(config.autonomyLevel), 'autonomyLevel doit valoir 0, 1 ou 2');
  assert(typeof config.paused === 'boolean', 'paused doit être un booléen');
  assert(/^[A-Z]{3}$/.test(config.currency), 'Devise ISO à trois lettres attendue');
  assert(Number.isInteger(config.dailyReportHour) && config.dailyReportHour >= 0 && config.dailyReportHour <= 23, 'dailyReportHour invalide');
  assert(Number.isInteger(config.weeklyIdeasDay) && config.weeklyIdeasDay >= 1 && config.weeklyIdeasDay <= 7, 'weeklyIdeasDay invalide');
  assert(Number.isInteger(config.weeklyIdeasHour) && config.weeklyIdeasHour >= 0 && config.weeklyIdeasHour <= 23, 'weeklyIdeasHour invalide');
  assert(Number.isInteger(config.spendCapDailyCents) && config.spendCapDailyCents >= 0, 'Plafond journalier invalide');
  assert(Number.isInteger(config.spendCapTotalCents) && config.spendCapTotalCents >= 0, 'Plafond total invalide');
  assert(typeof config.baseUrl === 'string' && /^https?:\/\//.test(config.baseUrl), 'baseUrl invalide');
  try {
    new Intl.DateTimeFormat('fr-CH', { timeZone: config.timezone }).format(new Date());
  } catch {
    throw new Error(`Fuseau horaire invalide : ${config.timezone}`);
  }
  return config;
}

export function loadRules() {
  const raw = readJson(rulesFile, {});
  const rules = {
    defaultBudgetHours: 8,
    defaultBudgetCents: 0,
    milestones: [
      { metric: 'visitors', target: 100, days: 14 },
      { metric: 'signups', target: 10, days: 21 },
      { metric: 'payments', target: 1, days: 45 },
    ],
    scaleMrrCents: 10000,
    killMinVisitors: 50,
    ...raw,
  };
  assert(Array.isArray(rules.milestones), 'milestones doit être une liste');
  for (const milestone of rules.milestones) {
    assert(['visitors', 'signups', 'payments'].includes(milestone.metric), 'Métrique de jalon inconnue');
    assert(Number.isInteger(milestone.target) && milestone.target > 0, 'Cible de jalon invalide');
    assert(Number.isInteger(milestone.days) && milestone.days > 0, 'Délai de jalon invalide');
  }
  assert(Number.isInteger(rules.scaleMrrCents) && rules.scaleMrrCents >= 0, 'Seuil de scale invalide');
  assert(Number.isInteger(rules.killMinVisitors) && rules.killMinVisitors >= 0, 'Seuil de kill invalide');
  return rules;
}

export function updateFactoryConfig(patch) {
  const current = readJson(configFile, defaults);
  const next = { ...defaults, ...current, ...patch };
  writeJson(configFile, next, 0o644);
  return loadFactoryConfig();
}

export function configFilePaths() {
  return { configFile, rulesFile };
}
