import { dataPath, readJson, updateJson } from './storage.mjs';
import { assert, isIsoDate, nowIso } from './util.mjs';
import { loadFactoryConfig } from './config.mjs';

const ledgerFile = dataPath('ledger.json');
const TYPES = new Set(['revenue', 'expense', 'refund']);

function sign(type) {
  if (type === 'expense' || type === 'refund') return -1;
  return 1;
}

function validate(input, currency) {
  assert(TYPES.has(input.type), 'Type de mouvement invalide');
  assert(typeof input.ventureId === 'string' && input.ventureId.length > 0, 'Venture manquante');
  assert(Number.isInteger(input.amountCents) && input.amountCents > 0, 'Montant invalide');
  assert(input.currency === currency, `Devise attendue : ${currency}`);
  assert(isIsoDate(input.occurredAt), 'Date invalide');
  assert(typeof input.source === 'string' && input.source.length > 0, 'Source manquante');
  assert(typeof input.externalId === 'string' && input.externalId.length > 0, 'Identifiant externe manquant');
}

export function recordEntry(input) {
  const config = loadFactoryConfig();
  validate(input, config.currency);
  return updateJson(ledgerFile, { entries: [] }, (state) => {
    const duplicate = state.entries.find(
      (entry) => entry.source === input.source && entry.externalId === input.externalId,
    );
    if (duplicate) return { value: state, result: duplicate };
    const entry = {
      id: `led_${input.source}_${input.externalId}`,
      type: input.type,
      ventureId: input.ventureId,
      amountCents: input.amountCents,
      currency: input.currency,
      source: input.source,
      externalId: input.externalId,
      occurredAt: input.occurredAt,
      recordedAt: nowIso(),
      note: String(input.note ?? '').slice(0, 500),
    };
    state.entries.push(entry);
    return { value: state, result: entry };
  });
}

export function listEntries() {
  return readJson(ledgerFile, { entries: [] }).entries;
}

function emptySummary() {
  return {
    hasData: false,
    revenue: 0,
    expenses: 0,
    refunds: 0,
    net: 0,
    byVenture: {},
  };
}

export function summarize(from = null, to = null) {
  const summary = emptySummary();
  for (const entry of listEntries()) {
    if (from && entry.occurredAt < from) continue;
    if (to && entry.occurredAt >= to) continue;
    summary.hasData = true;
    const venture = summary.byVenture[entry.ventureId] ?? {
      revenue: 0,
      expenses: 0,
      refunds: 0,
      net: 0,
    };
    if (entry.type === 'revenue') {
      summary.revenue += entry.amountCents;
      venture.revenue += entry.amountCents;
    } else if (entry.type === 'expense') {
      summary.expenses += entry.amountCents;
      venture.expenses += entry.amountCents;
    } else {
      summary.refunds += entry.amountCents;
      venture.refunds += entry.amountCents;
    }
    venture.net = venture.revenue - venture.expenses - venture.refunds;
    summary.byVenture[entry.ventureId] = venture;
  }
  summary.net = summary.revenue - summary.expenses - summary.refunds;
  return summary.hasData ? summary : emptySummary();
}

export function spentBetween(from, to) {
  return listEntries()
    .filter((entry) => entry.type === 'expense')
    .filter((entry) => (!from || entry.occurredAt >= from) && (!to || entry.occurredAt < to))
    .reduce((total, entry) => total + entry.amountCents, 0);
}

export function spentForVenture(ventureId, from = null, to = null) {
  return listEntries()
    .filter((entry) => entry.ventureId === ventureId && entry.type === 'expense')
    .filter((entry) => (!from || entry.occurredAt >= from) && (!to || entry.occurredAt < to))
    .reduce((total, entry) => total + entry.amountCents, 0);
}

export function recordExpense(input) {
  return recordEntry({
    ...input,
    type: 'expense',
    amountCents: input.amountCents,
    occurredAt: input.occurredAt ?? nowIso(),
  });
}

export function recordRevenue(input) {
  return recordEntry({
    ...input,
    type: 'revenue',
    occurredAt: input.occurredAt ?? nowIso(),
  });
}

export function ledgerEntrySign(type) {
  return sign(type);
}
