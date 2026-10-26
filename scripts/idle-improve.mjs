#!/usr/bin/env node
/**
 * Idle-improve driver.
 *
 * Sends the next backlog entry to a coding agent while nobody is waiting —
 * one small, verified, committed step at a time. It is deliberately paranoid:
 * it refuses to start unless the tree is clean, the hour is inside
 * `IDLE_HOURS`, and a usable agent CLI with credentials exists.
 *
 *   node scripts/idle-improve.mjs --dry-run       print the prompt, touch nothing
 *   node scripts/idle-improve.mjs --once --live   run one cycle
 *   node scripts/idle-improve.mjs --loop --live   keep going, one entry per cycle
 *
 * Environment:
 *   IDLE_HOURS     default "9-22", local hours the loop may run
 *   IDLE_INTERVAL  default 900, seconds between cycles with --loop
 *   IDLE_LOG       default "artifacts/idle-improve.log"
 *   ANTHROPIC_API_KEY  required for --live (the claude CLI reads it)
 *   IDLE_AGENT_CMD optional: full command to use instead of the detected one
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BACKLOG = path.join(ROOT, 'docs/backlog.md');
const LOG = path.join(ROOT, process.env.IDLE_LOG ?? 'artifacts/idle-improve.log');
const NEXT_TASK = path.join(ROOT, 'artifacts/idle-next-task.md');
const LOCK = path.join(ROOT, 'artifacts/.idle-improve.pid');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run') || !args.has('--live');
const once = args.has('--once');
const loop = args.has('--loop');

function log(line) {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, stamped);
  process.stdout.write(stamped);
}

function hoursWindow() {
  const [from, to] = (process.env.IDLE_HOURS ?? '9-22').split('-').map(Number);
  const hour = new Date().getHours();
  if (Number.isNaN(from) || Number.isNaN(to)) return true;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** The first actionable entry: not done, small enough, has a "done when". */
function nextEntry() {
  if (!fs.existsSync(BACKLOG)) return null;
  const lines = fs.readFileSync(BACKLOG, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('## Ready'));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) break;
    if (!line.startsWith('- [ ]')) continue;
    // Collect the entry and its "done when" continuation lines.
    const block = [line];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith('- [') || lines[j].startsWith('## ')) break;
      block.push(lines[j]);
    }
    const text = block.join('\n').trim();
    if (!/done when/i.test(text)) continue;
    return text;
  }
  return null;
}

function cleanTree() {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  return status.length === 0 ? true : status;
}

function agentCommand() {
  if (process.env.IDLE_AGENT_CMD) {
    return { bin: 'bash', prefix: ['-lc', process.env.IDLE_AGENT_CMD] };
  }
  const probe = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
  if (probe.status === 0) return { bin: 'claude', prefix: ['-p', '--permission-mode', 'acceptEdits'] };
  return null;
}

function buildPrompt(entry) {
  return [
    'You are working in the SP95 repository. Follow AGENTS.md, then run one idle-improve cycle',
    '(skills/idle-improve.md) on the backlog entry below. One entry only.',
    '',
    entry,
    '',
    'Rules: smallest complete change; run `npx tsc --noEmit`, `npm test` and `npm run build`;',
    'commit in the repo style; strike the entry through in docs/backlog.md with the commit hash.',
    'If a check fails twice on the same cause, revert and mark the entry blocked instead.',
  ].join('\n');
}

function runCycle() {
  if (!hoursWindow()) {
    log(`skip: outside IDLE_HOURS (${process.env.IDLE_HOURS ?? '9-22'})`);
    return 'stop';
  }
  const clean = cleanTree();
  if (clean !== true) {
    log(`skip: worktree is dirty, an agent may be mid-task\n${clean}`);
    return 'stop';
  }
  const entry = nextEntry();
  if (!entry) {
    log('stop: no eligible backlog entry');
    return 'stop';
  }

  const prompt = buildPrompt(entry);
  fs.mkdirSync(path.dirname(NEXT_TASK), { recursive: true });
  fs.writeFileSync(NEXT_TASK, prompt);

  if (dryRun) {
    log('dry-run: prompt written to artifacts/idle-next-task.md');
    process.stdout.write(`${prompt}\n`);
    return 'stop';
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.IDLE_AGENT_CMD) {
    log('stop: no ANTHROPIC_API_KEY — prompt left in artifacts/idle-next-task.md');
    return 'stop';
  }
  const agent = agentCommand();
  if (!agent) {
    log('stop: no agent CLI found (install `claude`, or set IDLE_AGENT_CMD)');
    return 'stop';
  }

  log(`cycle: ${entry.split('\n')[0].slice(0, 120)}`);
  const result = spawnSync(agent.bin, [...agent.prefix, prompt], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) log(`agent: ${result.stdout.trim().slice(-4000)}`);
  if (result.status !== 0) {
    log(`agent failed (${result.status}): ${(result.stderr ?? '').trim().slice(-2000)}`);
    return 'stop';
  }
  return 'continue';
}

if (!once && !loop) {
  process.stdout.write(`${buildPrompt(nextEntry() ?? '(no entry)')}\n`);
  process.exit(0);
}

if (fs.existsSync(LOCK)) {
  const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (alive) {
    log(`stop: another idle loop is running (pid ${pid})`);
    process.exit(0);
  }
}
fs.writeFileSync(LOCK, String(process.pid));
const release = () => fs.rmSync(LOCK, { force: true });
process.on('exit', release);
process.on('SIGINT', () => {
  release();
  process.exit(130);
});

const first = runCycle();
if (first === 'stop' || once) {
  log('done');
  process.exit(0);
}
const interval = Math.max(60, Number(process.env.IDLE_INTERVAL ?? 900)) * 1000;
setTimeout(function next() {
  if (runCycle() === 'stop') {
    log('done');
    process.exit(0);
  }
  setTimeout(next, interval);
}, interval);
