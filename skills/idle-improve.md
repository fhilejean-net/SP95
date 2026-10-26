# Skill — idle-improve

**Trigger.** All of these are true:

- The user's request is finished and reported.
- Nothing is waiting on you: no question asked, no failing check, no half-done refactor.
- The user has not sent a new message in the current turn.

**Goal.** Use idle time to make the game measurably better, one small, verified, committed step
at a time — never a rewrite, never speculative features.

## Source of work

`docs/backlog.md` is the only list. Each entry has a size (`S`/`M`/`L`) and an explicit
"done when" line. Never invent work outside it; add new ideas to the *Ideas* section instead.

Pick the first entry that is:

1. not struck through,
2. size **S** or **M** (an L only if the previous two idle cycles were clean),
3. not already in progress on another branch (`git branch -a --list '*idle*'`).

## One cycle = one entry

1. Read the code the entry names. Understand it before writing anything.
2. Implement the smallest version that satisfies "done when".
3. Verify, in this order: `npx tsc --noEmit`, `npm test`, `npm run build`. A visual change also
   needs a screenshot from the running dev server.
4. If a check fails twice on the same cause, revert your edits and mark the entry
   `blocked: <reason>` — a red `main` is worse than an untouched backlog.
5. Commit on the working branch with the repo's style. Push only when the user's rules for this
   repo allow pushing to `main`; otherwise leave the commit local and say so.
6. Strike the entry through in `docs/backlog.md`, with the commit hash and one line of what
   changed, in the same commit or the next one.

## Stop conditions

Stop the cycle and stay quiet until the user writes when any of these happen:

- two consecutive failed checks,
- the backlog has no eligible entry (then write one line in `artifacts/idle-improve.log`),
- the dev server or the browser tooling cannot be restored,
- the change would need a new dependency, a service, or a design decision the user has not made.

## Automation

`scripts/idle-improve.mjs` drives the cycle from a terminal:

```bash
node scripts/idle-improve.mjs --dry-run          # print the prompt it would send
node scripts/idle-improve.mjs --once --live      # run a single cycle through the claude CLI
node scripts/idle-improve.mjs --loop --live      # keep going, one entry at a time
```

It refuses to run when the tree is dirty, outside the configured hours (`IDLE_HOURS=9-22`), or
without `ANTHROPIC_API_KEY` — in that last case it writes the prompt to
`artifacts/idle-next-task.md` so the next agent turn can start from it.
Always run it with `IDLE_HOURS` narrow the first time, and check the log after one cycle.
