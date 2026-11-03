import { assert, isoWeekKey, nowIso } from './util.mjs';
import { ideasFile, readJson, writeJson } from './storage.mjs';

const CRITERIA = ['pain', 'proof', 'buildSpeed', 'supportSimplicity', 'seo', 'automation'];
const WEIGHTS = {
  pain: 0.25,
  proof: 0.2,
  buildSpeed: 0.15,
  supportSimplicity: 0.1,
  seo: 0.15,
  automation: 0.15,
};

const seeds = [
  {
    title: 'Générateur de fiches de révision pour formateurs indépendants',
    pitch: 'Transformer un PDF de cours en paquets de cartes révisables, exportables, avec contrôle du formateur.',
    target: 'Formateurs, coaches et petits organismes de formation',
    evidence: 'Pas de preuve collectée : aucun entretien ni test de prix réalisé.',
    regulated: false,
    scores: { pain: 8, proof: 3, buildSpeed: 6, supportSimplicity: 6, seo: 6, automation: 8 },
  },
  {
    title: 'Audit de landing page en 48 heures',
    pitch: 'Un rapport priorisé et une version corrigée de la page, livrés par un opérateur outillé.',
    target: 'Indépendants et petites SaaS qui lancent une offre',
    evidence: 'Pas de preuve collectée : aucun devis ni précommande signé.',
    regulated: false,
    scores: { pain: 7, proof: 3, buildSpeed: 9, supportSimplicity: 4, seo: 5, automation: 7 },
  },
  {
    title: 'Veille de conformité RGPD pour petites structures',
    pitch: 'Un tableau de bord des obligations et des échéances, sans conseil juridique personnalisé.',
    target: 'PME de 5 à 50 personnes sans DPO interne',
    evidence: 'Pas de preuve collectée ; domaine réglementé, à valider avec un juriste.',
    regulated: true,
    scores: { pain: 8, proof: 5, buildSpeed: 5, supportSimplicity: 3, seo: 7, automation: 6 },
  },
  {
    title: 'Pack de prompts et contrôles pour équipes support',
    pitch: 'Des modèles testés pour répondre aux tickets, avec garde-fous et mesures de qualité.',
    target: 'Équipes support de 2 à 20 personnes',
    evidence: 'Pas de preuve collectée : aucun client interrogé.',
    regulated: false,
    scores: { pain: 6, proof: 4, buildSpeed: 9, supportSimplicity: 7, seo: 5, automation: 8 },
  },
  {
    title: 'Page de tarification claire pour micro-SaaS',
    pitch: 'Un service qui transforme une grille de prix confuse en page lisible et testable.',
    target: 'Fondateurs de micro-SaaS',
    evidence: 'Pas de preuve collectée : aucune analyse de conversion disponible.',
    regulated: false,
    scores: { pain: 6, proof: 3, buildSpeed: 8, supportSimplicity: 6, seo: 6, automation: 7 },
  },
];

export function scoreIdea(idea) {
  assert(idea && typeof idea.title === 'string' && idea.title.length > 0, 'Titre manquant');
  assert(idea.scores && typeof idea.scores === 'object', 'Notes manquantes');
  let total = 0;
  for (const criterion of CRITERIA) {
    const value = idea.scores[criterion];
    assert(Number.isFinite(value) && value >= 1 && value <= 10, `Note invalide pour ${criterion}`);
    total += value * WEIGHTS[criterion];
  }
  assert(typeof idea.evidence === 'string' && idea.evidence.length > 0, 'Preuve manquante : écrire explicitement l’absence de preuve');
  return Math.round(total * 10) / 10;
}

export function readIdeas() {
  return readJson(ideasFile, { ideas: [], lastGeneratedAt: null, lastGeneratedWeek: null });
}

export function addIdeas(ideas, { now = new Date(), source = 'seed' } = {}) {
  return writeIdeas((state) => {
    for (const idea of ideas) {
      const scored = { ...idea, score: scoreIdea(idea), source, createdAt: now.toISOString() };
      assert(!state.ideas.some((existing) => existing.title === scored.title), `Idée déjà présente : ${scored.title}`);
      state.ideas.push(scored);
    }
    state.lastGeneratedAt = now.toISOString();
    state.lastGeneratedWeek = isoWeekKey(now);
    return state;
  });
}

function writeIdeas(callback) {
  const state = readIdeas();
  const next = callback(state);
  writeJson(ideasFile, next, 0o644);
  return next;
}

async function askLlmForIdeas() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL;
  assert(model, 'OPENAI_MODEL est requis quand OPENAI_API_KEY est présent');
  const prompt = [
    'Propose 5 micro-businesses honnêtes, testables en moins de deux semaines, sans crypto, jeu d’argent, MLM ni promesse de gain.',
    'Pour chacune, donne un titre, un pitch, une cible, une preuve existante avec URL ou la mention explicite « Pas de preuve collectée »,',
    'un booléen regulated, et des notes de 1 à 10 pour pain, proof, buildSpeed, supportSimplicity, seo, automation.',
    'N’invente ni témoignage, ni chiffre de marché. Réponds uniquement en JSON: {"ideas":[...]}.',
  ].join(' ');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Tu es un analyste produit prudent. Tu distingués toujours une hypothèse d’une preuve.' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Génération IA refusée (${response.status})`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  const parsed = JSON.parse(content);
  assert(Array.isArray(parsed.ideas) && parsed.ideas.length > 0, 'Réponse IA sans idées');
  return parsed.ideas;
}

export async function generateWeeklyIdeas({ now = new Date(), force = false } = {}) {
  const state = readIdeas();
  const week = isoWeekKey(now);
  if (!force && state.lastGeneratedWeek === week) {
    return { created: 0, reason: 'Idées déjà générées cette semaine', week };
  }
  let source = 'seed';
  let candidates = null;
  try {
    candidates = await askLlmForIdeas();
    if (candidates) source = 'llm';
  } catch (error) {
    return { created: 0, reason: `Génération IA impossible : ${error.message}`, week };
  }
  if (!candidates) {
    const known = new Set(state.ideas.map((idea) => idea.title));
    candidates = seeds.filter((idea) => !known.has(idea.title));
    if (candidates.length === 0) {
      return { created: 0, reason: 'Aucune nouvelle idée disponible sans clé LLM', week };
    }
  }
  const fresh = [];
  for (const idea of candidates) {
    if (state.ideas.some((existing) => existing.title === idea.title)) continue;
    fresh.push(idea);
  }
  if (fresh.length === 0) return { created: 0, reason: 'Toutes les idées proposées existent déjà', week };
  const next = addIdeas(fresh, { now, source });
  return { created: fresh.length, week, source, ideas: next.ideas.slice(-fresh.length) };
}

export function rankedIdeas() {
  return [...readIdeas().ideas].sort((a, b) => b.score - a.score);
}

export function ideaCriteria() {
  return { criteria: CRITERIA, weights: WEIGHTS };
}

export { nowIso };
