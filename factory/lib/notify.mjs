import fs from 'node:fs';
import path from 'node:path';
import { assert, nowIso, randomToken } from './util.mjs';
import { dataPath, ensureDataDirs } from './storage.mjs';

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.FACTORY_FROM_EMAIL);
}

export function deliveryConfigured() {
  return telegramConfigured() || emailConfigured();
}

async function telegramSend(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  assert(token && chatId, 'Telegram non configuré');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Telegram a répondu ${response.status}`);
  return { provider: 'telegram', id: String((await response.json()).result?.message_id ?? '') };
}

export async function sendEmail({ to, subject, text }) {
  assert(to, 'Destinataire manquant');
  assert(subject, 'Sujet manquant');
  assert(text, 'Message manquant');
  if (!emailConfigured()) {
    if (process.env.FACTORY_DEV_OUTBOX === '1') {
      ensureDataDirs();
      const file = dataPath('outbox', `${Date.now()}-${randomToken(4)}.json`);
      fs.writeFileSync(file, `${JSON.stringify({ to, subject, text, createdAt: nowIso() }, null, 2)}\n`, { mode: 0o600 });
      return { provider: 'outbox', id: path.basename(file, '.json') };
    }
    throw new Error('Email non configuré : RESEND_API_KEY et FACTORY_FROM_EMAIL sont requis');
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.FACTORY_FROM_EMAIL,
      to: [to],
      subject,
      text,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Resend a répondu ${response.status}`);
  return { provider: 'resend', id: String((await response.json()).id ?? '') };
}

export async function deliverReport({ subject, text, recipient = '' }) {
  const attempts = [];
  if (telegramConfigured()) {
    try {
      const result = await telegramSend(text);
      return { sent: true, ...result, attempts };
    } catch (error) {
      attempts.push({ provider: 'telegram', error: error.message });
    }
  }
  if (emailConfigured()) {
    const to = recipient || process.env.FACTORY_REPORT_EMAIL;
    if (to) {
      try {
        const result = await sendEmail({ to, subject, text });
        return { sent: true, ...result, attempts };
      } catch (error) {
        attempts.push({ provider: 'resend', error: error.message });
      }
    }
  }
  return { sent: false, reason: 'Aucun canal configuré ou tous les envois ont échoué', attempts };
}
