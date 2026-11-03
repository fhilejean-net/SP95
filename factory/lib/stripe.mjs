import { createHmac, timingSafeEqual } from 'node:crypto';
import { assert, nowIso, safeEqual } from './util.mjs';
import { dataPath, readJson, updateJson } from './storage.mjs';
import { recordEntry } from './ledger.mjs';

const subscriptionsFile = dataPath('subscriptions.json');

export function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export async function createCheckoutSession({ venture, successUrl, cancelUrl }) {
  assert(stripeConfigured(), 'Stripe non configuré');
  assert(venture.product.stripePriceId, 'Aucun prix Stripe associé à cette venture');
  assert(venture.product.model !== 'free', 'Cette venture est gratuite');
  const body = new URLSearchParams({
    mode: venture.product.model === 'subscription' ? 'subscription' : 'payment',
    'line_items[0][price]': venture.product.stripePriceId,
    'line_items[0][quantity]': '1',
    success_url: successUrl,
    cancel_url: cancelUrl,
    'metadata[ventureId]': venture.id,
    'subscription_data[metadata][ventureId]': venture.id,
    allow_promotion_codes: 'true',
  });
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Stripe a refusé le paiement (${response.status})`);
  assert(typeof payload.url === 'string', 'Stripe n’a pas renvoyé d’URL de paiement');
  return { id: payload.id, url: payload.url };
}

export function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof header !== 'string' || typeof secret !== 'string' || secret.length === 0) return false;
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index), part.slice(index + 1)];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > 300) return false;
  const expected = createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');
  if (!parts.v1) return false;
  const actual = Buffer.from(parts.v1, 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function upsertSubscription(record) {
  return updateJson(subscriptionsFile, { records: [] }, (state) => {
    const existing = state.records.find((item) => item.id === record.id);
    if (existing) Object.assign(existing, record, { updatedAt: nowIso() });
    else state.records.push({ ...record, createdAt: record.createdAt ?? nowIso(), updatedAt: nowIso() });
    return { value: state, result: existing ?? record };
  });
}

function monthlyAmount(subscription) {
  const item = subscription.items?.data?.[0];
  if (!item?.price) return 0;
  const amount = Number(item.price.unit_amount ?? 0) * Number(item.quantity ?? 1);
  if (!Number.isFinite(amount)) return 0;
  const interval = item.price.recurring?.interval;
  if (interval === 'year') return Math.round(amount / 12);
  if (interval === 'week') return Math.round(amount * 52 / 12);
  if (interval === 'day') return Math.round(amount * 365 / 12);
  return amount;
}

function ventureIdFrom(object) {
  return object?.metadata?.ventureId
    ?? object?.subscription_details?.metadata?.ventureId
    ?? object?.parent?.subscription_details?.metadata?.ventureId
    ?? null;
}

export function handleStripeEvent(event) {
  assert(event && typeof event.type === 'string', 'Événement Stripe invalide');
  assert(typeof event.id === 'string', 'Identifiant Stripe manquant');
  const object = event.data?.object ?? {};
  if (event.type === 'checkout.session.completed') {
    if (object.payment_status !== 'paid' || !object.amount_total) return { handled: false, reason: 'Paiement non encaissé' };
    const ventureId = ventureIdFrom(object);
    if (!ventureId) return { handled: false, reason: 'metadata.ventureId manquant' };
    const entry = recordEntry({
      type: 'revenue',
      ventureId,
      amountCents: object.amount_total,
      currency: String(object.currency ?? '').toUpperCase(),
      source: 'stripe',
      externalId: event.id,
      occurredAt: nowIso(),
      note: 'Paiement Stripe encaissé',
    });
    return { handled: true, entry };
  }
  if (event.type === 'invoice.paid') {
    if (object.billing_reason === 'subscription_create') return { handled: false, reason: 'Première facture déjà comptée au checkout' };
    if (!object.amount_paid) return { handled: false, reason: 'Facture à zéro' };
    const ventureId = ventureIdFrom(object);
    if (!ventureId) return { handled: false, reason: 'metadata.ventureId manquant' };
    const entry = recordEntry({
      type: 'revenue',
      ventureId,
      amountCents: object.amount_paid,
      currency: String(object.currency ?? '').toUpperCase(),
      source: 'stripe',
      externalId: event.id,
      occurredAt: nowIso(),
      note: 'Facture d’abonnement payée',
    });
    return { handled: true, entry };
  }
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const ventureId = ventureIdFrom(object);
    if (!ventureId) return { handled: false, reason: 'metadata.ventureId manquant' };
    const status = object.status;
    const canceledAt = object.canceled_at ? new Date(object.canceled_at * 1000).toISOString() : null;
    const subscription = upsertSubscription({
      id: object.id,
      ventureId,
      status: status === 'canceled' ? 'canceled' : status,
      mrrCents: monthlyAmount(object),
      canceledAt,
    });
    return { handled: true, subscription };
  }
  if (event.type === 'customer.subscription.deleted') {
    const ventureId = ventureIdFrom(object);
    if (!ventureId) return { handled: false, reason: 'metadata.ventureId manquant' };
    const subscription = upsertSubscription({
      id: object.id,
      ventureId,
      status: 'canceled',
      mrrCents: 0,
      canceledAt: nowIso(),
    });
    return { handled: true, subscription };
  }
  if (event.type === 'charge.refunded') {
    const ventureId = ventureIdFrom(object);
    if (!ventureId || !object.amount_refunded) return { handled: false, reason: 'Remboursement sans montant ou metadata' };
    const entry = recordEntry({
      type: 'refund',
      ventureId,
      amountCents: object.amount_refunded,
      currency: String(object.currency ?? '').toUpperCase(),
      source: 'stripe',
      externalId: event.id,
      occurredAt: nowIso(),
      note: 'Remboursement Stripe',
    });
    return { handled: true, entry };
  }
  return { handled: false, reason: `Événement ignoré : ${event.type}` };
}

export function listStoredSubscriptions() {
  return readJson(subscriptionsFile, { records: [] }).records;
}

export { safeEqual };
