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
status: idle
task: —
cycle: 1
started: —
heartbeat: 2026-10-26T21:40:37Z
commit: b9228cc
owner: session-133120
<!-- state:end -->

## Journal

| # | Date | Entrée | Commit | Note |
| --- | --- | --- | --- | --- |
| 1 | 2026-10-26 | Rider shoulder seam | `b9228cc` | deltoïde comblant la coupe d'aisselle, cuir mat, capture des deux épaules |
