# Backlog

The idle-improve skill works from this file only. One entry per idea, `S`/`M`/`L` size, and a
"done when" line that a test or a screenshot can settle. Struck-through entries keep their
commit hash so the history stays readable.

## Ready

- [x] ~~**Rider shoulder seam**~~ — `S`. The left sleeve still leaves a visible gap at the armpit
  when the bar is on full lock. Blend the shoulder ball into the torso (bigger ball, slightly
  lower joint) and check from the front at full lock.
  *Done when:* `artifacts/steer-right.png` shows no gap at either shoulder.
  *Cycle 1:* `b9228cc` — deltoïde comblant la coupe d'aisselle, cuir mat, capture des deux épaules

- [ ] **Fork cables** — `M`. The brake/clutch lines are baked into the chassis mesh in the GLB
  and stay put when the bar turns. Cut the tube-like body meshes near the steering head into the
  `frontUpper` group by geometry (thin, high, close to the bar axis) instead of by name.
  *Done when:* turning the bar on the spot moves the lines with it, verified by screenshot.
  *blocked:* les durites n'existent pas comme maillages séparés : elles sont fondues dans des groupes anonymes du cadre (mesuré sur moto.glb : aucune maille fine et longue près de l'axe de direction, seulement des pads de guidon et des stickers). Découper par triangles à l'aveugle percerait la colonne de direction ; ajouter des durites procédurales laisserait les anciennes immobiles en double. Trois options pour l'utilisateur : accepter le double, tenter la découpe par triangles avec risque sur le cadre, ou laisser tel quel.

- [x] ~~**Forest shadows**~~ — `S`. Tree shadows are off in `?fx=low` and the groves look pasted on.
  Enable shadow casting on the nearest instanced tree meshes only (distance-gated), measure the
  draw-call delta in `window.__sp95.debug`.
  *Done when:* `drawCalls` rises by less than 5 and the grove edge reads as grounded.
  *Cycle 3:* `0afe31d` — flaques de contact conformées au terrain, +2 draw calls (62 → 64) mesurés en fx=low

- [ ] **Per-vehicle camera framing** — `S`. The five points of view use fixed metre offsets; the
  bike cockpit sits a little high. Derive the anchors from the vehicle bounding box.
  *Done when:* the cockpit view on the bike shows the bar and the front fender, not the sky.
  *blocked:* cadrage cockpit non vérifiable ici : le rendu de contrôle tourne à ~1 fps (SwiftShader), donc chaque capture montre la frame précédente du changement de POV, et deux runs ont été tués avant d'obtenir une image stable. Piste mesurée à reprendre : la barre est à 1,12 m de haut et 0,33 m devant l'origine ; un œil à 0,55 m derrière et 0,30 m au-dessus d'elle demande ~8° de piqué pour tenir guidon et garde-boue dans le champ — à juger sur une vraie machine.

- [x] ~~**Bike presets in the HUD**~~ — `S`. The workshop has Série/Stunt/Enduro/Piste but the HUD
  never says which is active. Show the preset name next to the stunt score.
  *Done when:* switching preset changes the label without a reload.
  *Cycle 5:* `5c62c62` — libellé du preset dans le HUD, vérifié de Série à Stunt sans rechargement, 56 tests

- [x] ~~**Wet-weather riding**~~ — `G` (`M` est déjà le mute). Add a selectable wet-road condition using per-surface grip scaling; visibly darken asphalt and emit restrained rear-tire spray while moving. Keep dry handling unchanged and avoid adding new external assets.
  *Done when:* focused tests prove wet grip is lower than dry grip for asphalt and loose surfaces, the default remains dry, and the spray activates only for a moving vehicle on a wet surface; `npm test` and `npx tsc --noEmit` pass.
  *Cycle 6:* touche `G` (bascule route sèche/mouillée, flash HUD), grip ×0,7 sur toute surface, asphalte assombri, spray arrière sur roue au contact en mouvement ; 2 tests ajoutés, `tsc` ok, 58/58 tests

- [x] ~~**Per-vehicle sound presets**~~ — `S`. Keep the existing sound-mix controls, but remember and restore separate channel levels for car and bike while preserving the master level.
  *Done when:* a focused test shows car and bike channel mixes restore independently across vehicle switches and master volume remains unchanged; `npm test` and `npx tsc --noEmit` pass.
  *Cycle 7:* `52f3df4` — presets de mix voiture/moto, maître partagé, migration de l'ancien mix ; 2 tests, tsc ok, 60/60, build ok

- [x] ~~**Wet surface lookups allocate in the physics hot path**~~ — `S`. Since cycle 6,
  `surfaceAt` clones the dry surface object on every call once the road is wet, and both vehicle
  steps ask it for each wheel contact at 120 Hz (~480 objects/s). Build the wet variants of
  `SURFACES` once at module load and return those references instead.
  *Done when:* a focused test asserts `surfaceAt` returns the same object for two calls at one
  point while wet, the wet grip values are unchanged, and `npm test` / `npx tsc --noEmit` pass.
  *Cycle 8:* `303f4c1` — table WET_SURFACES précalculée, grip inchangé, test d'identité ; tsc ok, 61/61

- [ ] **Recent stunt replay** — `M`. Record a short rolling window of the player's recent vehicle poses and expose replay playback with a free camera, without recording the entire session or changing live scoring.
  *Done when:* a focused test verifies bounded recording and playback of the recorded poses, and a manual dev-server check confirms replay can be started and exited without affecting live vehicle state or score.

## Ideas (not scheduled)

_(Promote a new idea here only after adding a bounded scope and a verifiable « Done when » above.)

## Done

_(nothing yet — the idle loop will append here)_
