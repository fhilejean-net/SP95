# Boucle d'amélioration — état et journal

Ce fichier est la mémoire de la boucle autonome : elle survit à un runner tué, à une
session fermée et à un `git pull` sur une autre machine. L'agent le lit au début de
chaque tour (voir `AGENTS.md`) et le met à jour avec `scripts/agent-loop.mjs` — il ne
modifie pas le bloc d'état à la main.

- `status: running` + battement récent → un cycle est en cours, ne pas en lancer un second.
- `status: running` + battement vieux de plus de 12 min → la session est morte en plein
  cycle : reprendre **cette** entrée avant toute autre chose (`skills/session-recovery.md`).
- `status: idle` → prendre la première entrée de `docs/backlog.md`.
- `status: blocked` → deux échecs sur la même cause : s'arrêter et le dire à l'utilisateur.

<!-- state:start -->
status: running
task: Wet-weather riding
cycle: 6
started: 2026-10-27T06:42:03Z
heartbeat: 2026-10-27T06:46:01Z
commit: 5c62c62
owner: session-8921
<!-- state:end -->

## Journal

| # | Date | Entrée | Commit | Note |
| --- | --- | --- | --- | --- |
| 1 | 2026-10-26 | Rider shoulder seam | `b9228cc` | deltoïde comblant la coupe d'aisselle, cuir mat, capture des deux épaules |
| 2 | 2026-10-26 | Fork cables | — | bloqué : les durites n'existent pas comme maillages séparés : elles sont fondues dans des groupes anonymes du cadre (mesuré sur moto.glb : aucune maille fine et longue près de l'axe de direction, seulement des pads de guidon et des stickers). Découper par triangles à l'aveugle percerait la colonne de direction ; ajouter des durites procédurales laisserait les anciennes immobiles en double. Trois options pour l'utilisateur : accepter le double, tenter la découpe par triangles avec risque sur le cadre, ou laisser tel quel. |
| 3 | 2026-10-26 | Forest shadows | `0afe31d` | flaques de contact conformées au terrain, +2 draw calls (62 → 64) mesurés en fx=low |
| 4 | 2026-10-26 | Per-vehicle camera framing | — | bloqué : cadrage cockpit non vérifiable ici : le rendu de contrôle tourne à ~1 fps (SwiftShader), donc chaque capture montre la frame précédente du changement de POV, et deux runs ont été tués avant d'obtenir une image stable. Piste mesurée à reprendre : la barre est à 1,12 m de haut et 0,33 m devant l'origine ; un œil à 0,55 m derrière et 0,30 m au-dessus d'elle demande ~8° de piqué pour tenir guidon et garde-boue dans le champ — à juger sur une vraie machine. |
| 5 | 2026-10-26 | Bike presets in the HUD | `5c62c62` | libellé du preset dans le HUD, vérifié de Série à Stunt sans rechargement, 56 tests |
