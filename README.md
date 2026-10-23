# SP95

Jeu de conduite 3D jouable directement dans le navigateur : **conduite libre**, **drift** et **course** sur une carte routière ouverte. La physique est faite maison (modèle de pneus + châssis rigide Rapier), le rendu et les sons sont générés à l'exécution — aucun asset externe à télécharger.

## Jouer

- En ligne : **https://fhilejean-net.github.io/SP95/** (après activation de GitHub Pages, voir plus bas).
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
- **Châssis** : masse 1 350 kg, centre de gravité bas, 4 roues rayon-castées, ressorts/amortisseurs, butées de compression, barres anti-roulis avant/arrière, appui et traînée aérodynamiques, résistance au roulement.
- **Transmission** : courbe de couple, embrayage progressif au démarrage, boîte auto, frein moteur, autobloquant simulé par répartition égale, ABS arrière, frein à main qui verrouille l'essieu arrière (le drift vient de la perte d'adhérence latérale, pas d'une animation).
- **Rendu** : ciel de Preetham + carte d'environnement PMREM, matériaux PBR (peinture vernie), ombres dynamiques qui suivent la voiture, brouillard de distance, bloom, SMAA, tone mapping ACES.
- **Assets** : tous les modèles (carrosserie, roues, bâtiments, arbres, cônes), textures et sons sont générés par code au chargement. Les seules dépendances sont les bibliothèques ci-dessus.
- **Déterminisme** : la carte est générée avec une graine fixe ; elle est identique à chaque partie.

### Structure

```
src/
  main.ts              boucle de jeu, modes, caméra, audio, HUD
  physics/             pneus, transmission, véhicule Rapier
  world/               tracé des routes, terrain, ville, props
  render/              voiture, matériaux, ciel, post-traitement
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
npm test           # 13 tests Node : pneus, boîte, véhicule complet, drift, course
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
2. Dans le dépôt : **Settings → Pages → Source : GitHub Actions**.
3. Le site est publié sur `https://<compte>.github.io/SP95/`.

Le build utilise la variable `GITHUB_PAGES=true` pour définir le `base` Vite sur `/SP95/`. Sans Pages activé, le workflow de déploiement échouera à l'étape `configure-pages` (le build et les tests passent quand même).

## Limites connues

- **Pas de photoréalisme** : la voiture est un coupé procédural, les immeubles sont des volumes texturés. Un rendu photoréaliste demanderait des modèles 3D sur mesure, hors de portée de ce dépôt.
- Pas de dégâts, pas de choix de voiture, pas d'adversaires IA pour l'instant.
- Le pad de drift et les routes sont des surfaces visuelles posées sur le terrain ; la physique roule sur le terrain (écart de 3 cm).
- La caméra ne gère pas les collisions avec le bâti (elle peut traverser un mur).
- Testé automatiquement (physique + fumée navigateur) ; l'appréciation visuelle et le ressenti au volant restent à valider sur une vraie machine.

## Crédits

- [Three.js](https://threejs.org/) — MIT.
- [Rapier](https://rapier.rs/) — Apache-2.0.
- Tous les autres contenus sont générés par le code de ce dépôt.
