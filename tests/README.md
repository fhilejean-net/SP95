# Tests

- `npm test` — tire model, drivetrain, full Rapier vehicle simulation, drift
  scoring and race checkpoint logic. Runs in Node, no browser required.
- `node scripts/smoke.mjs` — end-to-end browser smoke test (boot, menu, drive,
  race countdown). Requires `npm run dev` and Playwright's Chromium:
  `npx playwright install chromium`.
