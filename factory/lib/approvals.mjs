import { assert, nowIso } from './util.mjs';
import { dataPath, readJson, updateJson } from './storage.mjs';
import { loadFactoryConfig } from './config.mjs';
import { getVenture, setVentureStatus, updateVentureProduct } from './ventures.mjs';

const approvalsFile = dataPath('approvals.json');
const KINDS = new Set([
  'venture_pause',
  'venture_kill',
  'venture_scale',
  'venture_activate',
  'price_change',
  'spend',
  'social_post',
  'outbound_message',
]);

export function listApprovals() {
  return readJson(approvalsFile, { items: [] }).items;
}

export function pendingApprovals() {
  return listApprovals().filter((item) => item.status === 'pending');
}

export function createApproval({ ventureId, kind, title, summary, payload = {}, dedupeKey = '', requestedBy = 'agent' }) {
  assert(KINDS.has(kind), 'Type d’approbation inconnu');
  assert(typeof title === 'string' && title.trim().length > 0, 'Titre manquant');
  assert(typeof summary === 'string' && summary.trim().length > 0, 'Résumé manquant');
  if (ventureId) assert(getVenture(ventureId), 'Venture introuvable');
  return updateJson(approvalsFile, { items: [] }, (state) => {
    const duplicate = dedupeKey
      ? state.items.find((item) => item.dedupeKey === dedupeKey && item.status === 'pending')
      : null;
    if (duplicate) return { value: state, result: duplicate };
    const item = {
      id: `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ventureId: ventureId ?? null,
      kind,
      title,
      summary,
      payload,
      requestedBy,
      dedupeKey,
      status: 'pending',
      createdAt: nowIso(),
      decidedAt: null,
      decidedBy: null,
      decisionNote: '',
      executedAt: null,
      executionError: null,
    };
    state.items.push(item);
    return { value: state, result: item };
  });
}

export function decideApproval(id, decision, actor = 'owner', note = '') {
  assert(['approved', 'rejected'].includes(decision), 'Décision invalide');
  return updateJson(approvalsFile, { items: [] }, (state) => {
    const item = state.items.find((candidate) => candidate.id === id);
    assert(item, 'Approbation introuvable');
    assert(item.status === 'pending', 'Approbation déjà traitée');
    item.status = decision;
    item.decidedAt = nowIso();
    item.decidedBy = actor;
    item.decisionNote = String(note).slice(0, 1000);
    return { value: state, result: item };
  });
}

export function applyApproval(id) {
  return updateJson(approvalsFile, { items: [] }, (state) => {
    const item = state.items.find((candidate) => candidate.id === id);
    assert(item, 'Approbation introuvable');
    assert(item.status === 'approved', 'Approbation non approuvée');
    if (item.executedAt) return { value: state, result: item };
    try {
      if (['venture_pause', 'venture_kill', 'venture_scale', 'venture_activate'].includes(item.kind)) {
        const status = {
          venture_pause: 'paused',
          venture_kill: 'killed',
          venture_scale: 'active',
          venture_activate: 'active',
        }[item.kind];
        setVentureStatus(item.ventureId, status);
      } else if (item.kind === 'price_change') {
        updateVentureProduct(item.ventureId, item.payload.product);
      } else {
        throw new Error('Cette approbation attend une exécution manuelle');
      }
      item.executedAt = nowIso();
      item.executionError = null;
    } catch (error) {
      item.executionError = error.message;
    }
    return { value: state, result: item };
  });
}


export function approvalSummary() {
  const items = listApprovals();
  return {
    pending: items.filter((item) => item.status === 'pending').length,
    approved: items.filter((item) => item.status === 'approved').length,
    rejected: items.filter((item) => item.status === 'rejected').length,
  };
}

export function canAutoApprove(kind) {
  const config = loadFactoryConfig();
  return config.autonomyLevel === 2 && !['spend', 'social_post', 'outbound_message'].includes(kind);
}
