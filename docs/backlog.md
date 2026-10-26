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

- [ ] **Forest shadows** — `S`. Tree shadows are off in `?fx=low` and the groves look pasted on.
  Enable shadow casting on the nearest instanced tree meshes only (distance-gated), measure the
  draw-call delta in `window.__sp95.debug`.
  *Done when:* `drawCalls` rises by less than 5 and the grove edge reads as grounded.

- [ ] **Per-vehicle camera framing** — `S`. The five points of view use fixed metre offsets; the
  bike cockpit sits a little high. Derive the anchors from the vehicle bounding box.
  *Done when:* the cockpit view on the bike shows the bar and the front fender, not the sky.

- [ ] **Bike presets in the HUD** — `S`. The workshop has Série/Stunt/Enduro/Piste but the HUD
  never says which is active. Show the preset name next to the stunt score.
  *Done when:* switching preset changes the label without a reload.

## Ideas (not scheduled)

- Wet weather: grip multiplier per surface, darker asphalt, spray from the rear tire.
- Replay of the last drift/wheelie with a free camera.
- Sound mix preset per vehicle instead of one global mix.

## Done

_(nothing yet — the idle loop will append here)_
