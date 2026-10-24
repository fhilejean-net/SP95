# SP95

Jeu de conduite 3D jouable directement dans le navigateur : **conduite libre**, **drift** et **course** sur une carte routière ouverte. La physique est faite maison (modèle de pneus + châssis rigide Rapier), le rendu et les sons sont générés à l'exécution — aucun asset externe à télécharger.

## Jouer

- En ligne : **https://fhilejean-net.github.io/SP95/** (déployé par GitHub Actions à chaque push sur `main`).
- En local :

```bash
npm ci
npm run dev
# http://localhost:3000
```

Sur une machine modeste, ajouter `?fx=low` à l'URL : ombres et post-traitement sont désactivés, la résolution interne baisse.

## Contrôles

| Action | Clavier | Manette | Tactile |
| --- | --- | --- | --- |
| Accélérer | `Z` / `W` / `↑` | gâchette droite | bouton GAZ |
| Freiner / reculer | `S` / `↓` | gâchette gauche | bouton FREIN |
| Tourner | `Q`/`A`, `D` / `←` `→` | stick gauche | volant tactile |
| Frein à main (drift) | `Espace` | bouton A | bouton DRIFT |
| Caméra | glisser à la souris, molette | — | — |
| Réapparaître | `R` | — | — |
| Pause | `Échap` | — | — |
| Couper le son | `M` | — | — |

La boîte est automatique 6 rapports + marche arrière : maintenir le frein à l'arrêt enclenche la marche arrière, et l'accélérateur repasse en première dès que la voiture a fini de reculer. Les rapports se décident sur la vitesse des roues motrices, pas sur celle du châssis : en drift, l'essieu arrière tourne bien plus vite que la caisse, et la boîte monte quand même. Le rupteur coupe l'injection par cycles de 140 ms au lieu de brider le couple.

## Atelier

Le menu et la pause ouvrent un **atelier** où la voiture se prépare pièce par pièce ; chaque choix est appliqué immédiatement et mémorisé dans le navigateur.

| Catégorie | Choix |
| --- | --- |
| Moteur | série, reprogrammation Stage 1, Stage 2 (admission + échangeur), Stage 3 (turbo hybride) |
| Échappement | ligne d'origine, cat-back inox, ligne complète + collecteur — du couple, moins de poids, plus de tours |
| Poids | série 1 350 kg, allègement 1 295 kg, dépouillement 1 230 kg |
| Suspensions | série, sport, piste, rallye (grand débattement), drift |
| Pneus | route sport, semi-slick, drift (glisse progressive), tout-terrain |
| Direction | série (41°), kit grand angle (66° et crémaillère rapide) |

Le panneau affiche en direct la puissance, le poids et le rapport ch/t.

## Son

Le menu et la pause ouvrent **Son · mixage** : un fader par famille — général, moteur, admission, échappement, turbo, pneus, gravier, vent, effets — appliqué en direct et mémorisé dans le navigateur. `M` coupe tout sans toucher aux réglages. Les niveaux par défaut ont été rééquilibrés : le sifflement du turbo, le crissement des pneus et la dump valve passaient par-dessus le moteur.

Le moteur est synthétisé : une pile d'harmoniques verrouillées sur la fréquence d'allumage, sans désaccordage ni ratio inharmonique, donc aucun battement qui ressemble à une boucle courte. Les nappes de bruit (admission, échappement, pneus, gravier, vent) bouclent chacune un buffer différent dont la fin est fondue dans le début : le point de boucle ne claque plus quand l'échappement s'ouvre à mi-régime.

## Contenu

- **Carte ouverte** d'environ 2 km × 2 km : ville quadrillée avec immeubles, ceinture routière de campagne avec dénivelé, zone industrielle avec un grand pad de drift, quais, arbres et collines.
- **Route du Col** : un massif au sud-ouest, gravi par une route à **lacets** de 1,18 km — quatre épingles, pentes jusqu'à 14,5 % — qui débouche sur un plateau sommital aménagé en aire de drift. Départ au pied du col, ou directement au sommet, depuis le menu.
- **Boucle Rallye** : une spéciale en terre de 790 m dans les collines du sud-est, reliée à la ceinture par une piste en gravier. Départ « Rallye » dans le menu.
- **Surfaces** : l'asphalte, la terre et l'herbe ne donnent pas la même adhérence. Sur la terre, le grip tombe à 62 % de celui du bitume, la résistance au roulement triple et l'angle de glissement de pic s'élargit : la voiture glisse plus tôt mais pardonne davantage. L'herbe est encore plus glissante (47 %).
- **Mobilier urbain** : lampadaires, feux tricolores, panneaux stop et de rue, passages piétons, chantiers (cônes, barrières, clôtures, balises) et bennes viennent du **City Kit Roads de Kenney** ; 320 pièces placées le long des routes et aux carrefours, avec un collider pour celles que la voiture peut percuter.
- **Conduite libre** : départ au centre-ville, circulation libre, réapparition en cas de tonneau.
- **Drift** : score basé sur l'angle de dérive réel et la vitesse, multiplicateur qui monte tant que le dérapage continue, points perdus en cas de choc.
- **Course** : 2 tours sur la ceinture, 12 portiques de contrôle, compte à rebours, chrono au tour, meilleur tour sauvegardé en local.
- **HUD** : vitesse, **régime en tr/min avec la zone rouge de la préparation**, rapport, mini-carte, chrono, score de drift, messages.
- **Son** : moteur procédural lié au régime et à la charge, admission, échappement (plus bruyant avec la ligne d'atelier), turbo qui monte en pression, **flutter** et dump valve au lever de pied, **fart de boîte DSG** à chaque montée de rapport, **pops and bangs** à la décélération et au rupteur, crissement de pneus sur le bitume, grondement de gravier et cailloux sur la terre, vent, impacts.

## Technique

- [Vite](https://vite.dev/) + TypeScript, [Three.js](https://threejs.org/) 0.186 pour le rendu, [Rapier](https://rapier.rs/) 0.21 (WASM) comme solveur de corps rigides.
- Simulation physique à **pas fixe de 120 Hz**, rendu découplé.
- **Modèle de pneus** : formule magique de Pacejka simplifiée, angle de dérive et taux de glissement combinés dans une ellipse de friction, sensibilité à la charge. Les forces sont appliquées au point de contact.
- **Châssis** : masse et suspensions tirées du réglage d'atelier, centre de gravité bas, 4 roues rayon-castées, ressorts/amortisseurs (débattement de 11 à 24 cm selon les suspensions), butées de compression progressives, barres anti-roulis avant/arrière, appui et traînée aérodynamiques, résistance au roulement.
- **Pneus** : chaque gamme a son coefficient d'adhérence *et* son angle de glissement de pic — les semi-slicks mordent tôt, les pneus drift encaissent des angles bien plus grands avant de décrocher.
- **Terrain du col** : la route est posée sur une plateforme taillée dans la pente (7,6 m à plat, remblai fondu sur 32 m) ; son profil est ajusté par un lissage sous contrainte de pente maximale, donc elle reste roulable et raccordée à la ceinture. Le terrain est aplati sous chaque route et sa hauteur est interpolée **le long du segment**, pas prise au point d'échantillonnage le plus proche : c'était la source des triangles d'herbe qui remontaient à travers l'asphalte dans les virages.
- **Direction** : la limite de braquage et la vitesse de la crémaillère baissent avec la vitesse pour éviter le tête-à-queue au moindre coup de volant sur autoroute, **sauf en contre-braquage** : dès que le volant tourne contre la glisse, toute la lock est disponible et la crémaillère accélère. C'est ce qui permet de rattraper un drift : avec 41° de braquage on tient jusqu'à ~35° d'angle, avec le kit grand angle (66°) jusqu'à ~55°.
- **Marche arrière** : sélectionnée à l'arrêt, limitée à ~27 km/h, l'accélérateur freine puis repasse en première ; le frein moteur s'oppose au sens de rotation réel des roues (il poussait auparavant la voiture en arrière).
- **Transmission** : courbe de couple, embrayage progressif au démarrage, boîte auto pilotée par la vitesse des roues motrices (un burnout sur place reste en première), rupteur à coupure cyclique, frein moteur, ABS arrière, frein à main qui verrouille l'essieu arrière (le drift vient de la perte d'adhérence latérale, pas d'une animation).
- **Rendu** : ciel de Preetham + carte d'environnement PMREM, matériaux PBR (peinture vernie), ombres dynamiques qui suivent la voiture, brouillard de distance, MSAA du canvas, tone mapping ACES. Rendu direct à la canvas (pas de chaîne de post-traitement) : c'était la source de surcoût GPU et de frames noires. Le pixel ratio est plafonné à 1,25 et une régulation automatique baisse la résolution puis les ombres si la machine tient moins de 48 fps.
- **Assets** : la voiture, les bâtiments, les arbres, le terrain et les sons sont générés par code au chargement. Le mobilier de rue est chargé depuis `public/models/kenney-city-roads/` (13 modèles GLB, une seule texture palette) et dessiné en `InstancedMesh` : environ douze draw calls pour toute la ville. Si un modèle manque, il est ignoré et la partie démarre quand même.
- **Déterminisme** : la carte est générée avec une graine fixe ; elle est identique à chaque partie.

### Structure

```
src/
  main.ts              boucle de jeu, modes, caméra, audio, HUD
  physics/             pneus, transmission, véhicule Rapier
  world/               tracé des routes, terrain, ville, mobilier Kenney
  render/              voiture, matériaux, ciel, régulation de qualité
  core/                entrées clavier/manette/tactile, caméra
  game/                drift, course, HUD, audio (+ DSP, mixage, panneau), atelier (tuning + UI)
tests/                 physique et logique de jeu (Node)
scripts/smoke.mjs      test de fumée navigateur (Playwright)
```

## Développement

```bash
npm ci
npm run dev        # serveur de dev
npm run build      # typecheck + build de production dans dist/
npm run preview    # sert le build
npm test           # 34 tests Node : pneus, boîte, rupteur, véhicule, suspension, drift, marche arrière, réglages, surfaces, tracé du col, mixage et boucles audio
```

Test navigateur (optionnel) :

```bash
npx playwright install chromium
npm run dev &
node scripts/smoke.mjs
```

Le test de fumée vérifie le démarrage, le menu, le mobilier Kenney, le panneau de mixage (un fader par famille, mémorisation, réinitialisation), l'atelier (catégories, application d'une pièce), la conduite au clavier, le HUD (dont le compte-tours), le compte à rebours de la course, les départs sur le col, sur la spéciale en terre (surface « terre » confirmée) et au sommet, ainsi que le déclenchement des effets sonores. Dans un environnement sans GPU, Chromium utilise SwiftShader : le rendu tourne alors à 1–2 fps et les contrôles temporels du test sont volontairement larges.

## Déploiement (GitHub Pages)

Le workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) construit le jeu, lance les tests et publie `dist/` à chaque push sur `main`.

1. Pousser sur `main`.
2. Le site est publié sur `https://<compte>.github.io/SP95/`.

Le build utilise la variable `GITHUB_PAGES=true` pour définir le `base` Vite sur `/SP95/`. L'étape `configure-pages` est lancée avec `enablement: true` : elle active Pages en mode « GitHub Actions » au premier déploiement, sans réglage manuel.

> **Dépôt privé :** GitHub Pages n'est pas disponible sur l'offre gratuite pour un dépôt privé. Le dépôt doit rester public pour que le déploiement fonctionne.

## Crédits

- **City Kit Roads 2.2** de [Kenney](https://www.kenney.nl) — licence [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Les modèles et leur licence sont dans `public/models/kenney-city-roads/`.

## Limites connues

- **Pas de photoréalisme** : la voiture est un coupé procédural, les immeubles sont des volumes texturés. Un rendu photoréaliste demanderait des modèles 3D sur mesure, hors de portée de ce dépôt.
- Pas de dégâts, pas de choix de voiture, pas d'adversaires IA pour l'instant.
- Le pad de drift, la ceinture, la route du col et la spéciale en terre sont des surfaces visuelles posées sur le terrain ; la physique roule sur le terrain aplati au niveau de la route (3 cm d'écart sur la plaine, 9 cm sur le col et le gravier).
- Les textures de sol sont peintes par code : herbe, terre et asphalte se répètent, il n'y a pas de mélange de matériaux aux transitions.
- La spéciale rallye est une boucle : pas de chrono ni de copilote pour l'instant.
- Ni le col ni la spéciale n'ont de glissières : sortir de la route en épingle envoie la voiture dans la pente ou dans l'herbe (la touche `R` la remet sur la route).
- Le plateau sommital est volontairement nu : c'est une aire de drift, pas un village.
- Les performances dépendent du GPU : au-delà de 12 immeubles visibles simultanément, une carte intégrée peut descendre sous 60 fps (la régulation baisse alors la qualité toute seule).
- Testé automatiquement (physique + fumée navigateur) ; l'appréciation visuelle et le ressenti au volant restent à valider sur une vraie machine.

## Crédits

- [Three.js](https://threejs.org/) — MIT.
- [Rapier](https://rapier.rs/) — Apache-2.0.
- Tous les autres contenus sont générés par le code de ce dépôt.
