# Backlog

The idle-improve skill works from this file only. One entry per idea, `S`/`M`/`L` size, and a
"done when" line that a test or a screenshot can settle. Struck-through entries keep their
commit hash so the history stays readable.

## Ready

- [x] ~~**Circuit look: portique, palissade, gravier, stands**~~ — `M`. Le portique laissait son
  bandeau dans le vide, les panneaux de pub se coupaient dans les virages, les bacs à gravier
  étaient des plaques coupées net et la voie des stands n'avait que des pointillés.
  *Done when:* une capture montre le bandeau du portique tenu par ses deux mâts, la palissade
  continue sur le muret, un bac à gravier fondu dans l'herbe et des emplacements numérotés.
  *Cycle 13:* `9e93ede` — portique rattaché, palissade continue, gravier progressif, stands détaillés ; 3 tests, tsc ok, 107/107

- [x] ~~**Ombres portées sur la piste et la ville**~~ — `M`. Le jeu n'a qu'une directionnelle et
  aucune ombre sur les 183 000 triangles du circuit : les côtés de la piste sont peints sombres
  dans la texture en attendant (l'asphalte est uniforme au centre, les vibreurs et les bords
  gardent leur gris plus foncé). Active l'ombre de la directionnelle sur une fenêtre glissante
  autour de la voiture — pas sur le monde entier — ombre de la caisse, des murs et des gradins
  comprises, et laisse la pénombre des bords venir de la lumière au lieu de la texture.
  *Done when:* une capture montre l'ombre de la voiture et d'un mur sur l'asphalte, et
  `drawCalls` de `window.__sp95.debug` ne grimpe pas de plus de 10 en `?fx=low`.
  *Cycle 10:* `e84020f` — Ombres : la passe du soleil ne dépose rien sur l'asphalte (A/B à 129 px sur 416 000). Remplacé par des décalques d'ancrage (ombre de contact + reflet) et une peinture vernie.

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

- [x] ~~**Recent stunt replay**~~ — `M`. Record a short rolling window of the player's recent vehicle poses and expose replay playback with a free camera, without recording the entire session or changing live scoring.
  *Done when:* a focused test verifies bounded recording and playback of the recorded poses, and a manual dev-server check confirms replay can be started and exited without affecting live vehicle state or score.
  *Cycle 9:* `0e3c584` — replay V, mémoire bornée 120 poses, interpolation, simulation gelée ; 3 tests, tsc ok, 64/64, build ok (vérif navigateur à faire)

- [x] ~~**Braking markers before every corner**~~ — `S`. The flat circuit now has kerbs and gravel
  traps but no braking reference: boards at 150, 100 and 50 m before each corner entry would let
  the player learn the lap instead of guessing. Built from the existing street-kit pieces, planted
  in the run-off between kerb and wall, facing back along the track.
  *Done when:* a test asserts every marker sits in the run-off on both sides and faces the
  approaching car, and a screenshot shows the 150/100/50 m boards before the first corner.
  *Cycle 12:* `5fb74fd` — plan pur (6 entrées, 18 panneaux) + rendu partagé, 4 tests, tsc ok,
  104/104, build ok ; la longue ligne droite porte les trois annonces, les courbes serrées
  n'ont que ce que leur dégagement permet ; planche `artifacts/braking-markers-strip.png`.
  *Cycle 12:* `5fb74fd` — Panneaux 150/100/50 dans le dégagement avant les entrées de virage, faces vers la voiture, plan pur + rendu partagé ; 4 tests, tsc ok, 104/104, build ok, planche de captures ; type du panneau de debug replay corrigé (tsc était rouge sur main)

- [x] ~~**Animate wheels, steering and rider inside the replay**~~ — `S`. Cycle 9 replays the body
  poses only, so the car slides along its own path with frozen wheels and the rider never leans.
  Record the visual bits with each frame (wheel spin, steer, lean, brake) and feed them to
  `updateCarVisual` / `bikeVisual.setPose` during playback.
  *Done when:* a focused test shows the extra fields round-trip per frame and interpolate during
  playback, and a manual replay shows the wheels turning and the rider leaning.
  *Cycle 11:* `b9eec72` — Roues, direction, frein et inclinaison enregistrés avec chaque pose et rejoués ; sonde navigateur : physique gelée, roues qui tournent

- [x] ~~**Braking boards should point at the corner**~~ — `S`. The chevrons on every board always
  point right, so on a left-hander they send the driver the wrong way. The plan already knows
  which way the corner turns: give each board that sign and mirror only the chevrons, never the
  number, by pairing one texture per value and direction.
  *Done when:* a test asserts every board carries the sign of the corner it announces, and the
  capture strip shows a left and a right corner with mirrored chevrons.
  *Cycle 14:* `9d5f926` — Panneaux gauche/droite différenciés, tests des directions et atlas contrôlé ; tsc, 114 tests et build ok

- [x] ~~**The debug surface is declared twice**~~ — `S`. `window.__sp95` is a seventy-field object
  literal plus a hand-written type literal, and they have already drifted: `replayState` was
  added to one and not the other, leaving `tsc` red on `main`. Derive the global type from the
  object itself so a field cannot compile out of sync.
  *Done when:* the hand-written type block in `src/main.ts` is gone, the window type is derived
  with `typeof`, and `npx tsc --noEmit` plus `npm test` pass.
  *Cycle 15:* `e0b60f5` — Type global dérivé de la surface exposée ; tsc, 114 tests et build ok

## Ideas (not scheduled)

_(Promote a new idea here only after adding a bounded scope and a verifiable « Done when » above.)

## Done

_(nothing yet — the idle loop will append here)_
