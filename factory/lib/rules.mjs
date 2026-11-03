import { assert } from './util.mjs';

export function evaluateVenture(venture, metrics, now, rules) {
  const result = {
    decision: 'hold',
    reason: '',
    milestone: null,
    ageDays: 0,
  };
  if (!['active'].includes(venture.status)) {
    result.reason = `Venture ${venture.status} : aucune décision automatique`;
    return result;
  }
  const createdAt = new Date(venture.createdAt);
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / 86400000);
  result.ageDays = Math.floor(ageDays);
  const mrr = metrics.mrrCents ?? 0;
  if (mrr >= rules.scaleMrrCents && rules.scaleMrrCents > 0) {
    return {
      ...result,
      decision: 'scale',
      reason: `MRR ${mrr} ¢ atteint le seuil de ${rules.scaleMrrCents} ¢`,
    };
  }
  const milestones = [...(venture.milestones?.length ? venture.milestones : rules.milestones)]
    .sort((a, b) => a.days - b.days);
  for (const milestone of milestones) {
    if (ageDays < milestone.days) continue;
    const value = milestone.metric === 'visitors'
      ? metrics.visitors ?? 0
      : milestone.metric === 'signups'
        ? metrics.signups ?? 0
        : metrics.payments ?? 0;
    if (value >= milestone.target) continue;
    const noTraction = (metrics.visitors ?? 0) < rules.killMinVisitors
      && (metrics.signups ?? 0) === 0
      && (metrics.payments ?? 0) === 0;
    return {
      ...result,
      decision: noTraction ? 'kill' : 'pivot',
      milestone,
      reason: noTraction
        ? `${milestone.metric} ${value}/${milestone.target} après ${milestone.days} jours et aucune inscription`
        : `${milestone.metric} ${value}/${milestone.target} après ${milestone.days} jours`,
    };
  }
  const budget = venture.budget?.moneyCents ?? 0;
  if (budget > 0 && (metrics.spendingCents ?? 0) > budget) {
    return {
      ...result,
      decision: 'pivot',
      reason: `Budget dépassé : ${metrics.spendingCents} ¢ dépensés pour ${budget} ¢`,
    };
  }
  result.reason = 'Jalons en cours ou atteints';
  return result;
}

export function nextMilestone(venture, rules) {
  const milestones = [...(venture.milestones?.length ? venture.milestones : rules.milestones)]
    .sort((a, b) => a.days - b.days);
  return milestones[0] ?? null;
}

export function assertSpendAllowed(config, spentToday, spentTotal, amountCents) {
  assert(Number.isInteger(amountCents) && amountCents > 0, 'Montant invalide');
  if (config.spendCapDailyCents === 0) throw new Error('Plafond journalier à zéro : dépense bloquée');
  if (config.spendCapTotalCents === 0) throw new Error('Plafond total à zéro : dépense bloquée');
  if (spentToday + amountCents > config.spendCapDailyCents) throw new Error('Plafond journalier dépassé');
  if (spentTotal + amountCents > config.spendCapTotalCents) throw new Error('Plafond total dépassé');
  return true;
}
