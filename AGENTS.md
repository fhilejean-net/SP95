# SP95 — instructions for coding agents

This repository is a browser driving game (Vite + TypeScript + Three.js + Rapier).
Read this file at the start of every turn; it is the contract for autonomous work here.

## First move of every turn

```bash
node scripts/agent-loop.mjs     # durable loop state: status, heartbeat, entry in progress
```

That file (`docs/agent-loop.md`) is committed, so it survives a killed runner and a fresh
clone. It decides what you do before anything else:

| What it says | What you do |
| --- | --- |
| `running` + heartbeat **older than 12 min** | The previous session died mid-cycle. Follow [skills/session-recovery.md](skills/session-recovery.md) and **finish that entry first**. |
| `running` + heartbeat recent | Another session is working on this repo. Don't start a parallel cycle; report it. |
| `idle` / `blocked` / no state | Nothing half-done. Handle the user's request. |

Never redo work that is already on disk or already committed: `git status` and the journal are
the truth, not your memory of the previous turn.

## Autonomie — no need to be asked

Two skills live in [`skills/`](skills/) and are **always on**:

| Skill | When | File |
| --- | --- | --- |
| **session-recovery** | Runner restarted, session "ended or changed", turn failed mid-way, tool call cut short, `exitCode 137`. | [skills/session-recovery.md](skills/session-recovery.md) |
| **idle-improve** | The user's request is done and reported. | [skills/idle-improve.md](skills/idle-improve.md) |

**The loop is you.** There is no API key, no external CLI and no scheduler in this setup: when a
request is finished, you immediately start the next backlog entry yourself, in the same turn, and
keep going — pick, implement, verify, commit, close, next — until the user writes, two checks
fail on the same cause, the backlog is empty, or a step needs a decision only the user can make.
Don't ask "shall I continue?" between cycles; the user watches the to-do list and can interrupt.

Heartbeat as you go, so a killed turn is not mistaken for a live one:

```bash
node scripts/agent-loop.mjs --beat --note "state of the cycle"
```

**Never end a turn with a dirty worktree.** Either the cycle is committed and closed
(`--finish --commit <sha> --note "…"`) or it is reverted (`--abort --note "…"`). A dirty tree is
refused by the next `--start` on purpose, and it hides where the work stopped.

## Ground rules (every turn)

- Work in the existing worktree; never touch sibling worktrees or shared git config.
- `npx tsc --noEmit` and `npm test` must pass before a commit; `npm run build` before a push.
- Never delete or weaken a test to make a check go green. Fix the cause; two failures on the same
  cause means revert and mark the entry `blocked`.
- Keep the dev server reproducible: see [skills/session-recovery.md](skills/session-recovery.md#environment).
- Commit in the repo style (French comments, English subject with a `feat:`/`fix:` prefix) and
  never commit secrets, `node_modules`, `dist` or `.env` files.
- Backlog: [docs/backlog.md](docs/backlog.md) — the only source of truth for the loop. Each entry
  has a size and a "done when" a test or a screenshot can settle.
- One entry per commit, one cycle per entry. Small and reversible beats impressive.
