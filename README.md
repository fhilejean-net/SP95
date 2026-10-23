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

La boîte est automatique 6 rapports + marche arrière : maintenir le frein à l'arrêt enclenche la marche arrière.

## Contenu

- **Carte ouverte** d'environ 2 km × 2 km : ville quadrillée avec immeubles, ceinture routière de campagne avec dénivelé, zone industrielle avec un grand pad de drift, quais, arbres et collines.
- **Conduite libre** : départ au centre-ville, circulation libre, réapparition en cas de tonneau.
- **Drift** : score basé sur l'angle de dérive réel et la vitesse, multiplicateur qui monte tant que le dérapage continue, points perdus en cas de choc.
- **Course** : 2 tours sur la ceinture, 12 portiques de contrôle, compte à rebours, chrono au tour, meilleur tour sauvegardé en local.
- **HUD** : vitesse, rapport, régime, mini-carte, chrono, score de drift, messages.
- **Son** : moteur procédural lié au régime, crissement de pneus, vent, impacts.

## Technique

- [Vite](https://vite.dev/) + TypeScript, [Three.js](https://threejs.org/) 0.186 pour le rendu, [Rapier](https://rapier.rs/) 0.21 (WASM) comme solveur de corps rigides.
- Simulation physique à **pas fixe de 120 Hz**, rendu découplé.
- **Modèle de pneus** : formule magique de Pacejka simplifiée, angle de dérive et taux de glissement combinés dans une ellipse de friction, sensibilité à la charge. Les forces sont appliquées au point de contact.
- **Châssis** : masse 1 350 kg, centre de gravité bas, 4 roues rayon-castées, ressorts/amortisseurs (46 cm de débattement, ~10 cm de compression statique), butées de compression progressives, barres anti-roulis avant/arrière, appui et traînée aérodynamiques, résistance au roulement.
- **Direction** : démultiplication variable — la limite de braquage et la vitesse de la crémaillère baissent avec la vitesse, comme sur une vraie voiture, pour éviter le tête-à-queue au moindre coup de volant sur autoroute.
- **Transmission** : courbe de couple, embrayage progressif au démarrage, boîte auto, frein moteur, autobloquant simulé par répartition égale, ABS arrière, frein à main qui verrouille l'essieu arrière (le drift vient de la perte d'adhérence latérale, pas d'une animation).
- **Rendu** : ciel de Preetham + carte d'environnement PMREM, matériaux PBR (peinture vernie), ombres dynamiques qui suivent la voiture, brouillard de distance, MSAA du canvas, tone mapping ACES. Rendu direct à la canvas (pas de chaîne de post-traitement) : c'était la source de surcoût GPU et de frames noires. Le pixel ratio est plafonné à 1,25 et une régulation automatique baisse la résolution puis les ombres si la machine tient moins de 48 fps.
- **Assets** : tous les modèles (carrosserie, roues, bâtiments, arbres, cônes), textures et sons sont générés par code au chargement. Les seules dépendances sont les bibliothèques ci-dessus.
- **Déterminisme** : la carte est générée avec une graine fixe ; elle est identique à chaque partie.

### Structure

```
src/
  main.ts              boucle de jeu, modes, caméra, audio, HUD
  physics/             pneus, transmission, véhicule Rapier
  world/               tracé des routes, terrain, ville, props
  render/              voiture, matériaux, ciel, régulation de qualité
  core/                entrées clavier/manette/tactile, caméra
  game/                drift, course, HUD, audio
tests/                 physique et logique de jeu (Node)
scripts/smoke.mjs      test de fumée navigateur (Playwright)
```

## Développement

```bash
npm ci
npm run dev        # serveur de dev
npm run build      # typecheck + build de production dans dist/
npm run preview    # sert le build
npm test           # 16 tests Node : pneus, boîte, véhicule complet, suspension, drift, course
```

Test navigateur (optionnel) :

```bash
npx playwright install chromium
npm run dev &
node scripts/smoke.mjs
```

Le test de fumée vérifie le démarrage, le menu, la conduite au clavier, le HUD et le passage du compte à rebours de la course. Dans un environnement sans GPU, Chromium utilise SwiftShader : le rendu tourne alors à 1–2 fps et les contrôles temporels du test sont volontairement larges.

## Déploiement (GitHub Pages)

Le workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) construit le jeu, lance les tests et publie `dist/` à chaque push sur `main`.

1. Pousser sur `main`.
2. Le site est publié sur `https://<compte>.github.io/SP95/`.

Le build utilise la variable `GITHUB_PAGES=true` pour définir le `base` Vite sur `/SP95/`. L'étape `configure-pages` est lancée avec `enablement: true` : elle active Pages en mode « GitHub Actions » au premier déploiement, sans réglage manuel.

> **Dépôt privé :** GitHub Pages n'est pas disponible sur l'offre gratuite pour un dépôt privé. Le dépôt doit rester public pour que le déploiement fonctionne.

## Limites connues

- **Pas de photoréalisme** : la voiture est un coupé procédural, les immeubles sont des volumes texturés. Un rendu photoréaliste demanderait des modèles 3D sur mesure, hors de portée de ce dépôt.
- Pas de dégâts, pas de choix de voiture, pas d'adversaires IA pour l'instant.
- Le pad de drift et les routes sont des surfaces visuelles posées sur le terrain ; la physique roule sur le terrain (écart de 3 cm).
- Les performances dépendent du GPU : au-delà de 12 immeubles visibles simultanément, une carte intégrée peut descendre sous 60 fps (la régulation baisse alors la qualité toute seule).
- Testé automatiquement (physique + fumée navigateur) ; l'appréciation visuelle et le ressenti au volant restent à valider sur une vraie machine.

## Crédits

- [Three.js](https://threejs.org/) — MIT.
- [Rapier](https://rapier.rs/) — Apache-2.0.
- Tous les autres contenus sont générés par le code de ce dépôt.
