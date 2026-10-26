#!/usr/bin/env node
/**
 * agent-loop.mjs — la mémoire de la boucle d'amélioration autonome.
 *
 * La boucle, c'est l'agent lui-même : il traite docs/backlog.md une entrée
 * vérifiée à la fois, dans son propre tour, sans attendre de prompt. Ce script
 * ne lance aucun agent et ne réclame aucune clé : il garde seulement l'état
 * durable pour qu'un tour tué soit repris, et il refuse les gestes qui
 * laisseraient deux sessions travailler sur la même entrée.
 *
 *   node scripts/agent-loop.mjs                    état + verdict de reprise + prochaine entrée
 *   node scripts/agent-loop.mjs --start [--task "…"]
 *   node scripts/agent-loop.mjs --beat --note "…"
 *   node scripts/agent-loop.mjs --finish --commit 1a2b3c4 --note "…"
 *   node scripts/agent-loop.mjs --blocked --reason "…"
 *   node scripts/agent-loop.mjs --abort --note "…"
 *
 * Codes de sortie : 0 ok, 1 refusé (arbre sale, aucune entrée, autre session).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BACKLOG = path.join(ROOT, 'docs/backlog.md');
const STATE = path.join(ROOT, 'docs/agent-loop.md');
const STALE_MIN = Number(process.env.LOOP_STALE_MINUTES ?? 12);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

function git(...a) {
  try {
    return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Le fichier d'état est versionné mais écrit à chaque battement : il ne doit jamais
 * bloquer un cycle. Tout le reste doit être propre pour qu'une reprise soit lisible.
 */
const LOOP_FILE = 'docs/agent-loop.md';

function treeDirty() {
  return git('status', '--porcelain')
    .split('\n')
    .filter((line) => line.trim() && !line.includes(LOOP_FILE))
    .join('\n');
}

function readState() {
  const fallback = { status: 'idle', task: '—', cycle: 0, started: '—', heartbeat: '—', commit: '—', owner: '—' };
  if (!fs.existsSync(STATE)) return fallback;
  const text = fs.readFileSync(STATE, 'utf8');
  const m = text.match(/<!-- state:start -->([\s\S]*?)<!-- state:end -->/);
  if (!m) return fallback;
  const out = { ...fallback };
  for (const line of m[1].split('\n')) {
    const hit = line.match(/^([a-z]+):\s*(.*)$/);
    if (hit) out[hit[1]] = hit[2].trim();
  }
  return out;
}

function writeState(state) {
  const body = [
    '<!-- state:start -->',
    `status: ${state.status}`,
    `task: ${state.task}`,
    `cycle: ${state.cycle}`,
    `started: ${state.started}`,
    `heartbeat: ${state.heartbeat}`,
    `commit: ${state.commit}`,
    `owner: ${state.owner}`,
    '<!-- state:end -->',
  ].join('\n');
  const text = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : '# Boucle d\'amélioration\n\n<!-- state:start -->\n<!-- state:end -->\n';
  fs.writeFileSync(
    STATE,
    /<!-- state:start -->[\s\S]*?<!-- state:end -->/.test(text)
      ? text.replace(/<!-- state:start -->[\s\S]*?<!-- state:end -->/, body)
      : `${text.trimEnd()}\n\n${body}\n`,
  );
}

function journalRow(cells) {
  const row = `| ${cells.join(' | ')} |`;
  const text = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : '';
  fs.writeFileSync(STATE, `${text.trimEnd()}\n${row}\n`);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function ageMinutes(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 60000;
}

function ownerId() {
  return process.env.LOOP_OWNER ?? `session-${process.pid}`;
}

/** Une entrée = un `- [ ]` suivi de son bloc, avec un critère « done when ». */
function entries() {
  if (!fs.existsSync(BACKLOG)) return [];
  const lines = fs.readFileSync(BACKLOG, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('## Ready'));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break;
    const head = lines[i].match(/^- \[([ x])\] \*\*(.+?)\*\*/);
    if (!head) continue;
    let end = i + 1;
    while (end < lines.length && !lines[end].startsWith('- [') && !lines[end].startsWith('## ')) end++;
    const block = lines.slice(i, end).join('\n');
    out.push({ line: i, end, done: head[1] === 'x', title: head[2], block, blocked: /\*blocked:\*/i.test(block) });
    i = end - 1;
  }
  return out;
}

function nextEntry() {
  return entries().find((e) => !e.done && !e.blocked && /done when/i.test(e.block)) ?? null;
}

function strike(entry, commit, note) {
  const lines = fs.readFileSync(BACKLOG, 'utf8').split('\n');
  const line = lines[entry.line];
  if (line.startsWith('- [ ]')) {
    lines[entry.line] = line.replace('- [ ]', '- [x]').replace(`**${entry.title}**`, `~~**${entry.title}**~~`);
  }
  const mark = [`  *Cycle ${readState().cycle}:* \`${commit}\` — ${note}`];
  const tail = lines[entry.end - 1] === '' ? entry.end - 1 : entry.end;
  lines.splice(tail, 0, ...mark);
  fs.writeFileSync(BACKLOG, lines.join('\n'));
}

function block(entry, reason) {
  const lines = fs.readFileSync(BACKLOG, 'utf8').split('\n');
  const tail = lines[entry.end - 1] === '' ? entry.end - 1 : entry.end;
  lines.splice(tail, 0, `  *blocked:* ${reason}`);
  fs.writeFileSync(BACKLOG, lines.join('\n'));
}

function prompt(entry) {
  if (!entry) return '(aucune entrée disponible dans docs/backlog.md)';
  return entry.block.trim();
}

function printStatus() {
  const state = readState();
  const age = state.heartbeat === '—' ? Infinity : ageMinutes(state.heartbeat);
  const entry = nextEntry();
  const lines = [];
  lines.push(`statut : ${state.status}`);
  lines.push(`entrée : ${state.task}${state.cycle ? ` (cycle ${state.cycle})` : ''}`);
  lines.push(`battement : ${state.heartbeat}${Number.isFinite(age) ? ` (il y a ${age.toFixed(0)} min)` : ''}`);
  lines.push(`dernier commit : ${state.commit}`);
  if (state.status === 'running' && age > STALE_MIN) {
    lines.push('');
    lines.push(`⚠  cycle interrompu : battement vieux de ${age.toFixed(0)} min (seuil ${STALE_MIN}) — la session a probablement été tuée.`);
    lines.push('   Reprendre CETTE entrée avant toute autre chose (skills/session-recovery.md), puis --beat.');
  } else if (state.status === 'running') {
    lines.push('');
    lines.push('▶  un cycle est en cours et vivant : ne pas démarrer un second cycle en parallèle.');
  }
  lines.push('');
  lines.push('prochaine entrée :');
  lines.push(prompt(entry));
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (!has('--start') && !has('--beat') && !has('--finish') && !has('--blocked') && !has('--abort')) {
  printStatus();
  process.exit(0);
}

const state = readState();
const dirty = treeDirty();

if (has('--start')) {
  if (dirty) {
    process.stdout.write(`refusé : arbre sale, un travail est en cours\n${dirty}\n`);
    process.exit(1);
  }
  const age = state.heartbeat === '—' ? Infinity : ageMinutes(state.heartbeat);
  if (state.status === 'running' && age <= STALE_MIN) {
    process.stdout.write(`refusé : un cycle est déjà en cours (entrée « ${state.task} », battement il y a ${age.toFixed(0)} min)\n`);
    process.exit(1);
  }
  const entry = flag('--task') ? entries().find((e) => e.title.toLowerCase().includes(flag('--task').toLowerCase())) : nextEntry();
  if (!entry) {
    process.stdout.write('refusé : aucune entrée éligible (tout est fait, bloqué, ou sans « done when »)\n');
    process.exit(1);
  }
  const next = {
    status: 'running',
    task: entry.title,
    cycle: Number(state.cycle || 0) + 1,
    started: nowIso(),
    heartbeat: nowIso(),
    commit: state.commit,
    owner: ownerId(),
  };
  writeState(next);
  process.stdout.write(`cycle ${next.cycle} démarré : ${entry.title}\n\n${prompt(entry)}\n`);
  process.exit(0);
}

if (state.status !== 'running' && !has('--abort')) {
  process.stdout.write(`refusé : aucun cycle en cours (statut ${state.status}) — lancer --start\n`);
  process.exit(1);
}

if (has('--beat')) {
  writeState({ ...state, heartbeat: nowIso(), owner: ownerId() });
  const note = flag('--note');
  process.stdout.write(`battement ${nowIso()} sur « ${state.task} »${note ? ` — ${note}` : ''}\n`);
  process.exit(0);
}

if (has('--finish')) {
  const commit = flag('--commit', '—');
  const note = flag('--note', 'fait');
  if (dirty) {
    process.stdout.write(`refusé : arbre sale, committer avant de clore le cycle\n${dirty}\n`);
    process.exit(1);
  }
  const entry = entries().find((e) => e.title === state.task);
  if (entry) strike(entry, commit, note);
  journalRow([String(state.cycle), nowIso().slice(0, 10), state.task, `\`${commit}\``, note]);
  writeState({ status: 'idle', task: '—', cycle: state.cycle, started: '—', heartbeat: nowIso(), commit, owner: ownerId() });
  process.stdout.write(`cycle ${state.cycle} clos (${commit}) : ${note}\n\nprochaine entrée :\n${prompt(nextEntry())}\n`);
  process.exit(0);
}

if (has('--blocked')) {
  const reason = flag('--reason', 'raison non précisée');
  const entry = entries().find((e) => e.title === state.task);
  if (entry) block(entry, reason);
  journalRow([String(state.cycle), nowIso().slice(0, 10), state.task, '—', `bloqué : ${reason}`]);
  writeState({ ...state, status: 'blocked', task: '—', started: '—', heartbeat: nowIso() });
  process.stdout.write(`entrée « ${state.task} » marquée bloquée : ${reason}\n`);
  process.exit(0);
}

if (has('--abort')) {
  const note = flag('--note', 'cycle abandonné');
  journalRow([String(state.cycle), nowIso().slice(0, 10), state.task, '—', note]);
  writeState({ status: 'idle', task: '—', cycle: state.cycle, started: '—', heartbeat: nowIso(), commit: state.commit, owner: ownerId() });
  process.stdout.write(`cycle abandonné, état remis à idle — ${note}\n`);
  process.exit(0);
}
