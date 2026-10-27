# Tests

- `npm test` — tire model, drivetrain and clutch, full Rapier vehicle
  simulation (suspension load and travel, kerb absorption, motorway-speed
  stability, standstill launches, full throttle while turning, wheel-by-wheel
  traction control, gravel grip), drift scoring and race checkpoint logic, and
  the map contract (the circuit on its own map with its footprint and its fade
  inside that world, the city world with no slab and no reserved footprint, the
  rock ramp that closes the world, the URL that picks the map). Runs in Node,
  no browser required.
- `node scripts/smoke.mjs` — end-to-end browser smoke test (boot, menu, drive,
  race countdown). Requires `npm run dev` and Playwright's Chromium:
  `npx playwright install chromium`.
