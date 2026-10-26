# Skill — session-recovery

**Trigger.** Any of these, at any point in a turn:

- "The Cloud runner restarted…", "Your session ended or changed", "the turn moved to a new runner".
- A `failed_turn` block in the conversation.
- A tool result that is empty or `exitCode 137` (killed) while a command was running.
- You are about to redo work you have no memory of doing.

**Goal.** Continue exactly where the previous attempt stopped, without redoing finished work
and without losing uncommitted changes.

## Checklist

### 1. Find out what survived (30 seconds, do not skip)

```bash
git status --short            # uncommitted work from the previous attempt is still on disk
git log --oneline -5          # did the previous attempt commit?
git diff --stat               # how far did it get?
ss -ltnp | grep 3000 || echo 'dev server down'
```

Anything listed as modified/untracked **is already done**: re-read those files before editing
them, and never replay the edit that produced them.

### 2. Rebuild the environment

Dependencies and processes do not survive a restart; files do.

```bash
ls node_modules >/dev/null 2>&1 || npm ci          # never upgrade, never touch the lockfile
```

Headless Chromium needs system libraries this VM does not ship with. If they were extracted
earlier they live in `/tmp/sysroot`; if `/tmp` was wiped, re-extract them, or skip browser
screenshots and say so.

```bash
LD_LIBRARY_PATH=/tmp/sysroot/usr/lib/x86_64-linux-gnu:/tmp/sysroot/lib/x86_64-linux-gnu \
  node scripts/smoke.mjs
```

Dev server (the preview host must be allowed explicitly, or Vite answers 403):

```bash
nohup env __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=<preview-host> npm run dev > dev-server.log 2>&1 &
sleep 8 && ss -ltnp | grep 3000
```

Then call `cloud_show_dev_server` with the listening port so the Browser panel reconnects.
A preview that was shown before the restart is gone: re-show it, do not tell the user it is fine.

### 3. Resume the plan

- Rebuild the to-do list from the request: mark everything that is visible on disk as done.
- Continue at the **first unfinished** item only.
- If the previous attempt committed, `git fetch` and check whether the push landed before
  pushing again (`git rev-list --left-right --count FETCH_HEAD...HEAD`).

### 4. Close the loop

- Run the checks that cover what changed: `npx tsc --noEmit`, `npm test`, `npm run build`.
- Commit coherent work early: a restart costs nothing if the work is committed.
- When reporting, say what was verified **after** the restart, not what was verified before it.
