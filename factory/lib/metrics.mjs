import { readJson, dataPath } from './storage.mjs';
import { eventStats } from './events.mjs';
import { countConfirmed } from './signups.mjs';
import { listEntries, summarize } from './ledger.mjs';

const subscriptionsFile = dataPath('subscriptions.json');

export function listSubscriptions() {
  return readJson(subscriptionsFile, { records: [] }).records;
}

export function mrrForVenture(ventureId) {
  return listSubscriptions()
    .filter((record) => record.ventureId === ventureId && ['active', 'trialing'].includes(record.status))
    .reduce((total, record) => total + record.mrrCents, 0);
}

export function subscriptionStats(ventureId = null) {
  const records = listSubscriptions().filter((record) => !ventureId || record.ventureId === ventureId);
  const active = records.filter((record) => ['active', 'trialing'].includes(record.status));
  const canceled = records.filter((record) => record.status === 'canceled');
  return {
    hasData: records.length > 0,
    active: active.length,
    canceled: canceled.length,
    mrrCents: active.reduce((total, record) => total + record.mrrCents, 0),
  };
}

export function ventureMetrics(ventureId, from = null, to = null) {
  const events = eventStats(ventureId, from, to);
  const signups = countConfirmed(ventureId, from, to);
  const entries = listEntries().filter(
    (entry) => entry.ventureId === ventureId
      && (!from || entry.occurredAt >= from)
      && (!to || entry.occurredAt < to),
  );
  const revenueEntries = entries.filter((entry) => entry.type === 'revenue');
  const payments = revenueEntries.length;
  const revenue = revenueEntries.reduce((total, entry) => total + entry.amountCents, 0);
  const spending = entries
    .filter((entry) => entry.type === 'expense')
    .reduce((total, entry) => total + entry.amountCents, 0);
  const subscriptions = subscriptionStats(ventureId);
  return {
    hasData: events.hasData || signups > 0 || entries.length > 0 || subscriptions.hasData,
    visitors: events.hasData ? events.visitors : null,
    pageviews: events.hasData ? events.pageviews : null,
    signups: signups > 0 || events.hasData ? signups : null,
    payments: entries.length > 0 ? payments : null,
    revenueCents: entries.length > 0 ? revenue : null,
    spendingCents: entries.length > 0 ? spending : null,
    conversionRate: events.hasData && events.visitors > 0 ? signups / events.visitors : null,
    mrrCents: subscriptions.hasData ? subscriptions.mrrCents : null,
    activeSubscriptions: subscriptions.hasData ? subscriptions.active : null,
    churnRate: null,
    events,
  };
}

export function globalMetrics(from = null, to = null) {
  const ledger = summarize(from, to);
  const subscriptions = subscriptionStats(null);
  return {
    ledger,
    mrrCents: subscriptions.hasData ? subscriptions.mrrCents : null,
    activeSubscriptions: subscriptions.hasData ? subscriptions.active : null,
    churnRate: null,
  };
}
