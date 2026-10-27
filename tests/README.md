# Tests

- `npm test` — tire model, drivetrain and clutch, full Rapier vehicle
  simulation (suspension load and travel, kerb absorption, motorway-speed
  stability, standstill launches, full throttle while turning, wheel-by-wheel
  traction control, gravel grip), drift scoring and race checkpoint logic, and
  the circuit contract in the layout (footprint inside the world clear of every
  road, ground override, fade of the slab into the terrain, surface under the
  wheels). Runs in Node, no browser required.
- `node scripts/smoke.mjs` — end-to-end browser smoke test (boot, menu, drive,
  race countdown). Requires `npm run dev` and Playwright's Chromium:
  `npx playwright install chromium`.
