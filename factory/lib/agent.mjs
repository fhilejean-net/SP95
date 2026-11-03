import { appendJsonl, dataPath, ensureDataDirs, readJson, readJsonl, updateJson } from './storage.mjs';
import { loadFactoryConfig, loadRules, updateFactoryConfig } from './config.mjs';
import { getVenture, listVentures } from './ventures.mjs';
import { ventureMetrics } from './metrics.mjs';
import { evaluateVenture } from './rules.mjs';
import { applyApproval, canAutoApprove, createApproval, decideApproval, pendingApprovals } from './approvals.mjs';
import { generateWeeklyIdeas } from './ideas.mjs';
import { runDailyReport } from './reports.mjs';
import { localDate, localDateParts, isoWeekKey, nowIso } from './util.mjs';

const actionsFile = dataPath('actions.jsonl');
const runtimeFile = dataPath('runtime.json');

function action(kind, summary, details = {}, error = null, autonomous = false, ventureId = null) {
  const entry = {
    at: nowIso(),
    kind,
    ventureId,
    summary,
    details,
    error,
    autonomous,
  };
  appendJsonl(actionsFile, entry);
  return entry;
}

export function logAction(kind, summary, details = {}, error = null, autonomous = false, ventureId = null) {
  return action(kind, summary, details, error, autonomous, ventureId);
}

export function recentActions(limit = 30) {
  return readJsonl(actionsFile).slice(-limit).reverse();
}

function weekday(dateString) {
  return new Date(`${dateString}T12:00:00Z`).getUTCDay() || 7;
}

function runtime() {
  return readJson(runtimeFile, {
    lastReportDate: null,
    lastIdeasWeek: null,
    lastEvaluationDate: null,
    lastPauseNotice: null,
  });
}

function saveRuntime(patch) {
  return updateJson(runtimeFile, {
    lastReportDate: null,
    lastIdeasWeek: null,
    lastEvaluationDate: null,
    lastPauseNotice: null,
  }, (state) => {
    Object.assign(state, patch);
    return { value: state, result: state };
  });
}

export function setPaused(paused) {
  const config = updateFactoryConfig({ paused: Boolean(paused) });
  action(paused ? 'factory_pause' : 'factory_resume', paused ? 'Cash Factory mise en pause' : 'Cash Factory reprise');
  return config;
}

export async function runEvaluation(now = new Date()) {
  const config = loadFactoryConfig();
  const rules = loadRules();
  const date = localDate(now, config.timezone);
  const results = [];
  for (const venture of listVentures().filter((item) => item.status === 'active')) {
    const metrics = ventureMetrics(venture.id, null, null);
    const evaluation = evaluateVenture(venture, metrics, now, rules);
    if (evaluation.decision === 'hold') {
      results.push({ ventureId: venture.id, ...evaluation });
      continue;
    }
    const kind = evaluation.decision === 'kill'
      ? 'venture_kill'
      : evaluation.decision === 'scale'
        ? 'venture_scale'
        : 'venture_pause';
    const approval = createApproval({
      ventureId: venture.id,
      kind,
      title: `${evaluation.decision === 'kill' ? 'Arrêter' : evaluation.decision === 'scale' ? 'Passer à l’échelle' : 'Pivoter'} ${venture.name}`,
      summary: evaluation.reason,
      payload: { decision: evaluation.decision, metrics, evaluation },
      dedupeKey: `eval:${venture.id}:${date}:${evaluation.decision}`,
    });
    let executed = null;
    if (config.autonomyLevel === 2 && canAutoApprove(kind)) {
      decideApproval(approval.id, 'approved', 'agent', 'Autonomie niveau 2');
      executed = applyApproval(approval.id);
    }
    action(
      'venture_evaluation',
      `${venture.name} : ${evaluation.decision} — ${evaluation.reason}`,
      { evaluation, approvalId: approval.id, executed: Boolean(executed) },
      null,
      config.autonomyLevel === 2 && Boolean(executed),
      venture.id,
    );
    results.push({ ventureId: venture.id, ...evaluation, approvalId: approval.id });
  }
  saveRuntime({ lastEvaluationDate: date });
  return results;
}

export async function runIdeas({ force = false } = {}) {
  const config = loadFactoryConfig();
  const result = await generateWeeklyIdeas({ now: new Date(), force });
  if (result.created > 0) {
    action('ideas_generated', `${result.created} nouvelle(s) idée(s) notée(s)`, { source: result.source });
  } else {
    action('ideas_skipped', result.reason);
  }
  return result;
}

export async function runReport({ force = false } = {}) {
  const result = await runDailyReport({ force });
  action(
    'daily_report',
    result.delivery.sent ? `Rapport ${result.date} envoyé` : `Rapport ${result.date} généré, non envoyé : ${result.delivery.reason}`,
    { date: result.date, delivery: result.delivery },
  );
  saveRuntime({ lastReportDate: result.date });
  return result;
}

function maybeReport(config, now, state) {
  const date = localDate(now, config.timezone);
  const parts = localDateParts(now, config.timezone);
  if (state.lastReportDate === date) return false;
  if (parts.hour < config.dailyReportHour) return false;
  return { date };
}

function maybeIdeas(config, now, state) {
  const date = localDate(now, config.timezone);
  const parts = localDateParts(now, config.timezone);
  const week = isoWeekKey(now);
  if (state.lastIdeasWeek === week) return false;
  if (weekday(date) < config.weeklyIdeasDay) return false;
  if (weekday(date) === config.weeklyIdeasDay && parts.hour < config.weeklyIdeasHour) return false;
  return { week };
}

export async function runTick(now = new Date()) {
  ensureDataDirs();
  const config = loadFactoryConfig();
  const state = runtime();
  if (config.paused) {
    const date = localDate(now, config.timezone);
    if (state.lastPauseNotice !== date) {
      saveRuntime({ lastPauseNotice: date });
      action('tick_paused', 'Tick ignoré : kill switch actif');
    }
    return { paused: true, actions: [] };
  }
  const actions = [];
  const reportPlan = maybeReport(config, now, state);
  if (reportPlan) {
    try {
      const result = await runReport();
      actions.push({ kind: 'daily_report', result });
    } catch (error) {
      action('daily_report_error', 'Échec du rapport quotidien', {}, error.message);
      actions.push({ kind: 'daily_report', error: error.message });
    }
  }
  const ideaPlan = maybeIdeas(config, now, state);
  if (ideaPlan) {
    try {
      const result = await runIdeas();
      actions.push({ kind: 'ideas', result });
    } catch (error) {
      action('ideas_error', 'Échec de la génération d’idées', {}, error.message);
      actions.push({ kind: 'ideas', error: error.message });
    }
  }
  const date = localDate(now, config.timezone);
  if (state.lastEvaluationDate !== date) {
    try {
      const result = await runEvaluation(now);
      actions.push({ kind: 'evaluation', result });
    } catch (error) {
      action('evaluation_error', 'Échec de l’évaluation des ventures', {}, error.message);
      actions.push({ kind: 'evaluation', error: error.message });
    }
  }
  return { paused: false, actions };
}

export function startScheduler({ intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    runTick().catch((error) => {
      action('tick_error', 'Tick en erreur', {}, error.message);
    });
  }, intervalMs);
  runTick().catch((error) => {
    action('tick_error', 'Premier tick en erreur', {}, error.message);
  });
  return timer;
}

export function runtimeState() {
  return runtime();
}

export function pendingCount() {
  return pendingApprovals().length;
}

export function getVentureForReport(id) {
  return getVenture(id);
}
