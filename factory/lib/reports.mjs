import fs from 'node:fs';
import path from 'node:path';
import { assert, formatMoney, isoWeekKey, localDate, localDayRange, nowIso, zonedMidnightUtc } from './util.mjs';
import { dataPath, ensureDataDirs, listFiles, readJson, readJsonl, reportsDir, updateJson, writeJson } from './storage.mjs';
import { loadFactoryConfig, loadRules } from './config.mjs';
import { listVentures } from './ventures.mjs';
import { summarize } from './ledger.mjs';
import { ventureMetrics } from './metrics.mjs';
import { pendingApprovals } from './approvals.mjs';
import { rankedIdeas } from './ideas.mjs';
import { deliverReport, deliveryConfigured } from './notify.mjs';

const deliveriesFile = dataPath('report-deliveries.json');
const actionsFile = dataPath('actions.jsonl');

function money(value, currency) {
  return value === null || value === undefined ? 'pas de donnée' : formatMoney(value, currency);
}

function count(value) {
  return value === null || value === undefined ? 'pas de donnée' : String(value);
}

function percent(value) {
  return value === null || value === undefined ? 'pas de donnée' : `${(value * 100).toFixed(1)} %`;
}

function rangeForWeek(dateString, timeZone) {
  const [year, month, day] = dateString.split('-').map(Number);
  const cursor = new Date(Date.UTC(year, month - 1, day));
  const mondayOffset = (cursor.getUTCDay() + 6) % 7;
  cursor.setUTCDate(cursor.getUTCDate() - mondayOffset);
  const monday = cursor.toISOString().slice(0, 10);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return {
    from: zonedMidnightUtc(monday, timeZone).toISOString(),
    to: zonedMidnightUtc(tomorrow, timeZone).toISOString(),
    label: `semaine du ${monday}`,
  };
}

function actionLines(date, timeZone) {
  return readJsonl(actionsFile).filter((action) => localDate(new Date(action.at), timeZone) === date);
}

function sectionRevenue(currency, ranges) {
  const lines = ['## Revenus, coûts et profit net', ''];
  lines.push('| Période | Revenus | Coûts | Remboursements | Profit net |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const [label, summary] of ranges) {
    if (!summary.hasData) {
      lines.push(`| ${label} | pas de donnée | pas de donnée | pas de donnée | pas de donnée |`);
    } else {
      lines.push(`| ${label} | ${money(summary.revenue, currency)} | ${money(summary.expenses, currency)} | ${money(summary.refunds, currency)} | ${money(summary.net, currency)} |`);
    }
  }
  lines.push('', '### Par venture', '');
  lines.push('| Venture | Revenus | Coûts | Profit net |');
  lines.push('| --- | ---: | ---: | ---: |');
  const ventures = listVentures();
  if (ventures.length === 0) {
    lines.push('| — | pas de donnée | pas de donnée | pas de donnée |');
  }
  const cumulative = ranges.at(-1)[1];
  for (const venture of ventures) {
    const entry = cumulative.byVenture[venture.id];
    if (!entry) {
      lines.push(`| ${venture.name} | pas de donnée | pas de donnée | pas de donnée |`);
    } else {
      lines.push(`| ${venture.name} | ${money(entry.revenue, currency)} | ${money(entry.expenses, currency)} | ${money(entry.net, currency)} |`);
    }
  }
  lines.push('');
  return lines;
}

function sectionTraffic(ventures, today, week) {
  const lines = ['## Visiteurs, inscriptions, conversions, MRR, churn', ''];
  lines.push('| Venture | Visiteurs (jour) | Inscriptions (jour) | Conversion | MRR | Churn |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const venture of ventures) {
    const metrics = ventureMetrics(venture.id, today.from, today.to);
    lines.push(`| ${venture.name} | ${count(metrics.visitors)} | ${count(metrics.signups)} | ${percent(metrics.conversionRate)} | ${money(metrics.mrrCents, venture.product.currency)} | ${percent(metrics.churnRate)} |`);
  }
  lines.push('');
  const totals = ventures.map((venture) => ventureMetrics(venture.id, week.from, week.to));
  const visitors = totals.some((item) => item.visitors !== null)
    ? totals.reduce((total, item) => total + (item.visitors ?? 0), 0)
    : null;
  const signups = totals.some((item) => item.signups !== null)
    ? totals.reduce((total, item) => total + (item.signups ?? 0), 0)
    : null;
  lines.push(`- Visiteurs sur ${week.label} : ${count(visitors)}`);
  lines.push(`- Inscriptions sur ${week.label} : ${count(signups)}`);
  lines.push('- Churn : pas de donnée suffisante pour calculer un taux fiable.');
  lines.push('');
  return lines;
}

function sectionActions(actions) {
  const lines = ['## Ce qui s’est passé', ''];
  if (actions.length === 0) {
    lines.push('Aucune action enregistrée aujourd’hui.');
  } else {
    for (const action of actions.slice(-40)) {
      const flag = action.error ? 'ERREUR' : action.autonomous ? 'auto' : 'action';
      lines.push(`- **${flag}** \`${action.kind}\` — ${action.summary}${action.error ? ` (${action.error})` : ''}`);
    }
  }
  const errors = actions.filter((action) => action.error);
  lines.push('', `### Erreurs`, '');
  lines.push(errors.length ? errors.map((action) => `- ${action.summary} : ${action.error}`).join('\n') : 'Aucune erreur enregistrée aujourd’hui.');
  lines.push('');
  return lines;
}

function sectionDecisions(actions) {
  const autonomous = actions.filter((action) => action.autonomous);
  return [
    '## Décisions prises seul',
    '',
    autonomous.length
      ? autonomous.map((action) => `- \`${action.kind}\` — ${action.summary}`).join('\n')
      : 'Aucune décision autonome aujourd’hui. Le niveau d’autonomie et les plafonds restent la référence.',
    '',
  ];
}

function sectionApprovals() {
  const pending = pendingApprovals();
  return [
    '## Décisions qui attendent ton approbation',
    '',
    pending.length
      ? pending.map((item) => `- **${item.title}** — ${item.summary} (\`${item.id}\`)`).join('\n')
      : 'Aucune approbation en attente.',
    '',
  ];
}

function sectionIdeas() {
  const ideas = rankedIdeas().slice(0, 5);
  return [
    '## Nouvelles idées proposées et leur score',
    '',
    ideas.length
      ? ideas.map((idea) => `- **${idea.title}** — ${idea.score}/10${idea.regulated ? ' · domaine réglementé, validation humaine obligatoire' : ''}`).join('\n')
      : 'pas de donnée : aucune idée générée.',
    '',
  ];
}

function sectionPlan(now, pending, rules) {
  const lines = ['## Plan des prochaines 24 h', ''];
  if (pending.length > 0) {
    lines.push(`- Traiter ${pending.length} approbation(s) en attente.`);
  }
  lines.push('- Vérifier les jalons des ventures actives et refuser tout lancement public sans validation.');
  lines.push('- Générer le prochain rapport quotidien à l’heure configurée.');
  if (!deliveryConfigured()) {
    lines.push('- Configurer Telegram ou Resend : sans canal, le rapport reste uniquement sur le dashboard.');
  }
  lines.push(`- Prochaine revue des idées : semaine ${isoWeekKey(now)} selon la configuration (${rules.milestones.length} jalons par défaut).`);
  lines.push('');
  return lines;
}

export function buildReport(date = localDate(new Date(), loadFactoryConfig().timezone), now = new Date()) {
  const config = loadFactoryConfig();
  const rules = loadRules();
  const today = localDayRange(date, config.timezone);
  const week = rangeForWeek(date, config.timezone);
  const all = { from: null, to: null };
  const ranges = [
    ['Aujourd’hui', summarize(today.from, today.to)],
    [`7 jours (${week.label})`, summarize(week.from, week.to)],
    ['Cumulé', summarize(all.from, all.to)],
  ];
  const ventures = listVentures();
  const actions = actionLines(date, config.timezone);
  const pending = pendingApprovals();
  const lines = [
    `# Rapport Cash Factory — ${date}`,
    '',
    `Statut : **${config.paused ? 'en pause' : 'actif'}** · Autonomie : **${config.autonomyLevel}** · Devise : **${config.currency}**`,
    '',
    'Tous les montants sont en centimes convertis en devise. « pas de donnée » signifie qu’aucune source ne fournit la valeur ; aucun chiffre n’est estimé.',
    '',
    ...sectionRevenue(config.currency, ranges),
    ...sectionTraffic(ventures, today, week),
    ...sectionActions(actions),
    ...sectionDecisions(actions),
    ...sectionApprovals(),
    ...sectionIdeas(),
    ...sectionPlan(now, pending, rules),
    '---',
    `Généré le ${nowIso()}.`,
    '',
  ];
  return lines.join('\n');
}

export function reportPath(date) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(date), 'Date de rapport invalide');
  return path.join(reportsDir, `${date}.md`);
}

export function saveReport(content, date) {
  ensureDataDirs();
  const file = reportPath(date);
  fs.writeFileSync(file, content, { mode: 0o644 });
  return file;
}

export function readReport(date) {
  try {
    return fs.readFileSync(reportPath(date), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function listReports() {
  ensureDataDirs();
  return listFiles(reportsDir, '.md').map((name) => name.slice(0, 10)).reverse();
}

export async function deliverDailyReport({ content, date, config }) {
  const result = await deliverReport({
    subject: `Cash Factory — rapport ${date}`,
    text: content,
    recipient: config.reportRecipient,
  });
  updateJson(deliveriesFile, { deliveries: [] }, (state) => {
    const existing = state.deliveries.find((item) => item.date === date);
    const record = {
      date,
      at: nowIso(),
      sent: result.sent,
      provider: result.provider ?? null,
      reason: result.reason ?? null,
      attempts: result.attempts ?? [],
    };
    if (existing) Object.assign(existing, record);
    else state.deliveries.push(record);
    return { value: state, result: record };
  });
  return result;
}

export async function runDailyReport({ now = new Date(), force = false } = {}) {
  const config = loadFactoryConfig();
  const date = localDate(now, config.timezone);
  const file = reportPath(date);
  if (fs.existsSync(file) && !force) {
    const content = readReport(date);
    const delivery = await deliverDailyReport({ content, date, config });
    return { date, file, generated: false, delivery };
  }
  const content = buildReport(date, now);
  saveReport(content, date);
  const delivery = await deliverDailyReport({ content, date, config });
  return { date, file, generated: true, delivery };
}

export function reportDeliveries() {
  return readJson(deliveriesFile, { deliveries: [] }).deliveries;
}
