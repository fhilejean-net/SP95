# SP95 — instructions for coding agents

This repository is a browser driving game (Vite + TypeScript + Three.js + Rapier).
Read this file at the start of every turn.

## Two skills are mandatory here

Both live in [`skills/`](skills/) and are always on:

| Skill | When it applies | File |
| --- | --- | --- |
| **session-recovery** | The runner restarted, the session "ended or changed", a turn failed mid-way, or a tool call was cut short. | [skills/session-recovery.md](skills/session-recovery.md) |
| **idle-improve** | The request is finished, nothing is waiting on you, and the user is not mid-conversation. | [skills/idle-improve.md](skills/idle-improve.md) |

Read the matching skill *before* touching anything, then follow it. They are written as
checklists: each step has the command or file to look at.

## Ground rules (apply to every turn)

- Work in the existing worktree; never touch sibling worktrees or shared git config.
- `npx tsc --noEmit` and `npm test` must pass before a commit; `npm run build` before a push.
- Do not delete or weaken tests to make a check go green. Fix the cause.
- Keep the dev server reproducible: see the recipe in
  [skills/session-recovery.md](skills/session-recovery.md#environment).
- Commit in the repo's style (French comments, English commit subject with a `feat:`/`fix:`
  prefix) and never commit secrets, `node_modules`, `dist` or `.env` files.
- Backlog of agreed improvements: [docs/backlog.md](docs/backlog.md). It is the only source of
  truth for the idle loop.
