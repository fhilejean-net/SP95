# SP95

Jeu de conduite 3D jouable directement dans le navigateur : **conduite libre**, **drift**, **course** et **stunt en supermotard** sur une carte routière ouverte. La physique est faite maison (modèle de pneus + châssis rigide Rapier), le terrain, les bâtiments et la synthèse sonore sont générés à l'exécution ; la voiture, la moto et le mobilier urbain sont des modèles GLB, et deux prises de décharge turbo complètent le son. Le pilote et les étincelles sont dessinés par code.

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
| Antipatinage on / off | `T` | — | — |
| Wheelie (moto) | `E` | — | bouton WHEELIE |
| Baisser l'avant (moto) | `S` / `↓` (frein) | gâchette gauche | bouton FREIN |

La moto se lance depuis **Moto · supermotard stunt** dans le menu ou la pause : elle démarre sur l'aire du sommet, sans marche arrière (on ne recule pas une moto au moteur). `E` (ou le bouton **WHEELIE** sous le compte-tours) donne le coup d'embrayage qui lève l'avant ; ensuite l'accélérateur choisit l'angle tenu et le frein repose la roue. Un second coup d'embrayage au sommet pousse la moto au-delà : la **bavette** racle, fait des étincelles et paie un bonus — mais il faut freiner pour ne pas partir en looping.

La boîte est automatique 6 rapports + marche arrière : maintenir le frein à l'arrêt enclenche la marche arrière, et l'accélérateur repasse en première dès que la voiture a fini de reculer. Les rapports se décident sur la **vitesse réelle de la caisse**, comme le capteur de sortie d'une vraie boîte, et non sur celle des roues motrices : en drift ou au démarrage, l'essieu arrière patine et lit le double de la vitesse réelle ; la boîte montait alors en quatrième au milieu d'un drift et faisait tomber le moteur hors de sa plage, ce qui vidait le drift de sa vitesse. L'antipatinage se coupe avec `T` ou depuis la pause (le témoin **TCS** du compte-tours s'éteint) : c'est indispensable pour tenir un drift ou un burnout. Le rupteur coupe l'injection par cycles de 140 ms au lieu de brider le couple.

## Atelier

Le menu et la pause ouvrent un **atelier** où l'on choisit d'abord la voiture, puis on la prépare pièce par pièce ; chaque choix est appliqué immédiatement et mémorisé dans le navigateur.

| Voiture | Moteur | Poids | Empattement | Voie |
| --- | --- | --- | --- | --- |
| Aventador LP700-4 | V12, 690 Nm, 8 250 tr/min | 1 575 kg | 2,75 m | 1,71 m |
| RX-7 FD3S | birotor turbo, 300 Nm, 8 000 tr/min | 1 310 kg | 2,45 m | 1,50 m |
| i20 N Rally2 | 1,6 L turbo, 420 Nm, 7 200 tr/min | 1 230 kg | 2,59 m | 1,74 m |

| Catégorie | Choix |
| --- | --- |
| Moteur | série, reprogrammation Stage 1 (+12 %), Stage 2 (admission + échangeur, +24 %), Stage 3 (turbo hybride, +40 %) |
| Échappement | ligne d'origine, cat-back inox, ligne complète + collecteur — du couple, moins de poids, plus de tours |
| Poids | série, allègement (−55 kg), dépouillement (−120 kg) |
| Suspensions | série, sport, piste, rallye (grand débattement), drift |
| Pneus | route sport, semi-slick, drift (glisse progressive), tout-terrain (+45 % d'adhérence sur terre et herbe, −8 % sur bitume) |
| Direction | série, kit grand angle (crémaillère rapide) |

Chaque pièce est un **ratio du véhicule d'origine** : un Stage 3 ajoute 40 % de couple au V12 comme au 1,6 L, et la hauteur de caisse suit les suspensions de la voiture choisie. Le panneau affiche en direct la puissance, le poids et le rapport ch/t.

## Son

Le menu et la pause ouvrent **Son · mixage** : un fader par famille — général, moteur, admission, échappement, turbo, pneus, gravier, vent, effets — appliqué en direct et mémorisé dans le navigateur. `M` coupe tout sans toucher aux réglages. La **dump valve et le flutter sont sur le fader turbo**, avec le sifflement : on peut donc baisser tout le turbo d'un seul curseur, ou le monter si on aime l'entendre cracher.

Le moteur est **entièrement synthétisé** : une pile d'harmoniques verrouillées sur la fréquence d'allumage, sans désaccordage ni ratio inharmonique, donc aucun battement qui ressemble à une boucle courte. Son V12 a **six allumages par tour** (contre deux pour un quatre-cylindres) : c'est cette fréquence qui fait le timbre, pas un glissement de hauteur. Les nappes de bruit (admission, échappement, pneus, gravier, vent) bouclent chacune un buffer différent dont la fin est fondue dans le début, et le filtre d'échappement suit la fréquence d'allumage au lieu de rester planté à 240 Hz.

Il n'y a **plus aucune lecture continue d'un enregistrement moteur**. Les prises de moteur étaient jouées en grains superposés à hauteur fixe : sous un moteur qui monte en régime, cela faisait un second moteur qui dronne — le « train qui passe » ou le cardan cassé qu'on entendait en permanence, de plus en plus fort à l'accélération — et les offsets aléatoires dans une prise qui contient des montées de régime donnaient l'impression que les tours montaient et descendaient alors que le pied ne bougeait pas. La seule prise qui reste est la **décharge du turbo**.

- `turbo-flutter.mp3` et `turbo-flutter-2.mp3` — la **décharge du turbo en « stu stu stu »**, jouée en one-shot au lever de pied, avec la pression de suralimentation comme volume, en alternance entre les deux prises.

Les pops and bangs ne sont plus un souffle filtré : chaque coup est une **détonation** (craquement large bande + corps grave + onde de pression sinusoïdale qui tombe de 120 à 42 Hz), et le **fart de DSG** est une dent de scie dont la hauteur s'effondre à travers un passe-bas résonant, avec la claque des embrayages par-dessus. Une montée de rapport sous charge déclenche le fart puis un bang, comme une ligne qui crache au changement de rapport.

Le lever de pied est détecté **au franchissement d'un seuil**, pas sur un saut d'une image à l'autre : les pédales sont lissées, donc l'ancien test (« plus de 55 % à l'image précédente, moins de 12 % maintenant ») ne se déclenchait jamais, et ni les pops ni le flutter ne sortaient. Un temps de garde de 0,9 s et une hystérésis empêchent une pédale qui tremble autour du seuil de mitrailler les pops en continu.

## Contenu

- **Carte ouverte** d'environ 2 km × 2 km : ville quadrillée avec immeubles, ceinture routière de campagne avec dénivelé, zone industrielle avec un grand pad de drift, quais, arbres et collines. Les rues qui finissent en rase campagne se terminent sur un **rond de retournement** en béton au lieu d'un bord d'asphalte coupé net.
- **Route du Col** : un massif au sud-ouest, gravi par une route à **lacets** de 1,18 km — quatre épingles, pentes jusqu'à 14,5 % — qui débouche sur un plateau sommital aménagé en aire de drift. Départ au pied du col, ou directement au sommet, depuis le menu.
- **Boucle Rallye** : une spéciale en terre de 790 m dans les collines du sud-est, reliée à la ceinture par une piste en gravier. Départ « Rallye » dans le menu.
- **Surfaces** : l'asphalte, la terre et l'herbe ne donnent pas la même adhérence. Sur la terre, le grip tombe à 62 % de celui du bitume, la résistance au roulement triple et l'angle de glissement de pic s'élargit : la voiture glisse plus tôt mais pardonne davantage. L'herbe est encore plus glissante (47 %). Les pneus tout-terrain compensent en partie cette perte.
- **Sol photographié** : l'herbe du terrain est une **photo de sol** (Poliigon, fournie par le propriétaire du dépôt) réduite à 1024 px, avec ses cartes de normale et de rugosité à 512 px — 400 Ko au total, servis depuis `public/textures/grass/`. Elle remplace la texture de bruit dessinée sur canvas et se répète tous les ~6 m.
- **Quartiers habités** : chaque rue ouverte est bordée de **maisons à toit de tuiles** (160 environ, toutes en `InstancedMesh`), et chacune des quinze impasses se termine sur un **commerce** avec auvent et enseigne lumineuse, planté juste derrière le rond de retournement et tourné vers le conducteur : le bout de la rue est une destination, plus un rond au milieu d'un champ. Les fenêtres s'allument chaudement (carte émissive dédiée) et chaque lampadaire du kit porte une tête lumineuse : les rues se lisent comme un village, pas comme un circuit entre deux champs.
- **Mobilier urbain** : lampadaires, feux tricolores, panneaux stop et de rue, passages piétons, chantiers (cônes, barrières, clôtures, balises) et bennes viennent du **City Kit Roads de Kenney** ; **436 pièces** placées le long des routes et aux carrefours, avec un collider pour celles que la voiture peut percuter.
- **Lignes électriques** : poteaux tous les 41 m sur l'accotement de la ceinture et de la route du Col, reliés par les câbles du kit étirés sur la portée.
- **Fumée de pneus** : une roue qui patine ou qui glisse émet de la fumée blanche sur le bitume et de la poussière ocre sur la terre et l'herbe, avec une densité qui suit le taux de glissement et la charge du pneu. En ligne droite, rien ne fume : c'est le patinage qu'on voit, pas la vitesse.
- **Trois voitures** : Lamborghini Aventador, Mazda RX-7 FD et Hyundai i20 N Rally2, choisies dans l'atelier. Chaque modèle GLB est normalisé au chargement : le corps est centré sur l'empattement, les roues sont extraites et recentrées sur leurs moyeux pour tourner et braquer, et l'échelle découle de la voie et de l'empattement réels du modèle. Le châssis et les colliders suivent ces mêmes cotes.
- **Supermotard** : un gros monocylindre de 68 Nm, 210 kg pilote compris, empattement 1,48 m, sur un modèle GLB de CRF. Deux roues (une par essieu) qui tournent et braquent, un transfert de charge arrière à l'accélération, une inclinaison déduite du taux de lacet réel (jusqu'à 53°) et un **wheelie simulé comme un pendule** autour du contact arrière : le coup d'embrayage (`E`) casse l'appui de la roue avant, l'accélérateur choisit l'angle tenu, le frein repose. Passé le point d'équilibre (~50°) plus rien ne retient la moto : elle part en looping, et seule la poignée de frein la sauve. Une bavette (au-delà de 49°) allume les **étincelles** sous le carénage arrière et rapporte des points, avec multiplicateur et combo comme le drift.
- **Score stunt** : la roue avant levée rapporte au prorata de l'angle et de la vitesse, le multiplicateur monte tant que le wheelie tient, et les points se bancarisent quand l'avant retombe. Un looping ou un choc perd la série. Le panneau remplace le score de drift dès qu'on est sur la moto.
- **Conduite libre** : départ au centre-ville, circulation libre, réapparition en cas de tonneau.
- **Drift** : score basé sur l'angle de dérive réel et la vitesse, multiplicateur qui monte tant que le dérapage continue, points perdus en cas de choc.
- **Course** : 2 tours sur la ceinture, 12 portiques de contrôle, compte à rebours, chrono au tour, meilleur tour sauvegardé en local.
- **HUD** : vitesse, **régime en tr/min avec la zone rouge de la préparation**, rapport, mini-carte, chrono, score de drift, messages.
- **Son** : moteur procédural lié au régime et à la charge, admission, échappement (plus bruyant avec la ligne d'atelier), turbo qui monte en pression, **flutter** et dump valve au lever de pied, **fart de boîte DSG** à chaque montée de rapport, **pops and bangs** à la décélération et au rupteur, crissement de pneus sur le bitume, grondement de gravier et cailloux sur la terre, vent, impacts.

## Technique

- [Vite](https://vite.dev/) + TypeScript, [Three.js](https://threejs.org/) 0.186 pour le rendu, [Rapier](https://rapier.rs/) 0.21 (WASM) comme solveur de corps rigides.
- Simulation physique à **pas fixe de 120 Hz**, rendu découplé.
- **Modèle de pneus** : formule magique de Pacejka simplifiée, angle de dérive et taux de glissement combinés dans une ellipse de friction, sensibilité à la charge. Les forces sont appliquées au point de contact. La raideur de dérive (`B`) était dix fois trop forte : 1 % de glissement donnait déjà 80 % de la force de pic, donc une roue très légèrement trop lente freinait la voiture comme un étrier. Elle est maintenant réaliste, et la part latérale de l'effort est élargie pour qu'un pneu qui patine conserve son grip en virage au lieu de tout perdre d'un coup.
- **Châssis** : masse et suspensions tirées du réglage d'atelier, centre de gravité bas, 4 roues rayon-castées, ressorts/amortisseurs (débattement de 11 à 24 cm selon les suspensions), butées de compression progressives, barres anti-roulis avant/arrière, appui et traînée aérodynamiques, résistance au roulement.
- **Pneus** : chaque gamme a son coefficient d'adhérence *et* son angle de glissement de pic — les semi-slicks mordent tôt, les pneus drift encaissent des angles bien plus grands avant de décrocher. Les **tout-terrain** portent en plus un multiplicateur `looseGrip` appliqué hors bitume : ils perdent 8 % sur l'asphalte mais gagnent 45 % sur la terre et l'herbe, alors qu'ils étaient auparavant *moins* adhérents que les pneus de route jusque dans le gravier.
- **Aires de drift** : le pad de la zone industrielle est au niveau de la rue qui le dessert, et le plateau sommital au niveau du dernier lacet ; les deux sont nivelés, puis **re-nivelés après le creusement des routes**. Le col empile ses lacets : un lacet inférieur passe sous le sommet et son remblai de 32 m tirait le terrain 2 à 5 m sous le disque de béton, d'où la voiture qui passait à travers. Un cylindre mince donne en plus au béton sommital sa propre collision, pour que la dalle reste solide jusqu'au bord malgré le maillage grossier du terrain. L'asphalte, lui, gagne toujours sur le terrain : aucune route ne disparaît sous sa propre épaule.
- **Terrain du col** : la route est posée sur une plateforme taillée dans la pente (7,6 m à plat, remblai fondu sur 32 m) ; son profil est ajusté par un lissage sous contrainte de pente maximale, donc elle reste roulable et raccordée à la ceinture. Le terrain est aplati sous chaque route et sa hauteur est interpolée **le long du segment**, pas prise au point d'échantillonnage le plus proche : c'était la source des triangles d'herbe qui remontaient à travers l'asphalte dans les virages.
- **Direction** : la limite de braquage et la vitesse de la crémaillère baissent avec la vitesse pour éviter le tête-à-queue au moindre coup de volant sur autoroute, **sauf en contre-braquage** : dès que le volant tourne contre la glisse, toute la lock est disponible et la crémaillère accélère. C'est ce qui permet de rattraper un drift : avec 41° de braquage on tient jusqu'à ~35° d'angle, avec le kit grand angle (66°) jusqu'à ~55°.
- **Marche arrière** : sélectionnée à l'arrêt, limitée à ~27 km/h, l'accélérateur freine puis repasse en première ; le frein moteur s'oppose au sens de rotation réel des roues (il poussait auparavant la voiture en arrière).
- **Transmission** : courbe de couple, embrayage progressif au démarrage (le régime de lancement suit le pic de couple et laisse patiner jusqu'à ~55 km/h), boîte auto pilotée par la vitesse des roues motrices (un burnout sur place reste en première), rupteur à coupure cyclique, frein moteur, ABS, frein à main qui verrouille l'essieu arrière (le drift vient de la perte d'adhérence latérale, pas d'une animation).
- **Transmission intégrale** : chaque voiture a sa répartition avant/arrière (`driveFront`) — 40 % à l'avant sur l'Aventador, 50 % sur la i20 N Rally2, rien sur la RX-7. L'essieu avant est couplé par un embrayage, pas par un crabot : il porte sa propre inertie et une fraction de celle du moteur.
- **Inertie du volant moteur** : elle est répercutée sur les roues **dans la mesure où l'embrayage est fermé** et partagée entre les deux roues de l'essieu. Avant, chaque roue portait à elle seule l'inertie du moteur à travers la première (plus d'une tonne équivalente) et l'embrayage était considéré comme collé dès l'arrêt : toutes les voitures semblaient lourdes et lentes à s'élancer (Aventador : 5,5 s au 0-100, 3,4 s maintenant).
- **Contrôle de traction** : **roue par roue**, pas essieu par essieu. Avec un différentiel ouvert la roue intérieure délestée patine toujours la première, et un seul pneu qui patine emportait le grip latéral de tout l'essieu : c'est le « crabe », la voiture qui glisse en diagonale à 5 km/h avec le volant tourné. Chaque roue est plafonnée à la force que sa propre bande de roulement peut passer au glissement cible, puis corrigée proportionnellement au-delà. Il ne s'efface **que** au frein à main ou quand le joueur le coupe (`T`, bouton de la pause, témoin **TCS** éteint) : le couper dès 20° de glisse (comme avant) relâchait justement les quatre roues au moment où le rallye en a besoin, et le drift s'auto-entretenait. Coupé, il laisse le patinage libre — c'est ce qu'il faut pour un burnout ou pour tenir un angle.
- **Collision du châssis** : la caisse est un volume pour les murs, les bâtiments et les autres voitures, **pas un plancher**. Elle ignore le groupe de collision du sol tant que la voiture est sur ses roues (les pneus, eux, sont des raycasts) et ne reprend le terrain qu'au-delà de 53° de roulis, quand c'est bien la caisse qui touche. C'était le **« mur invisible »** : sous le plongeon du freinage, le nez entrait dans le maillage du terrain, et un châssis qui résout une pénétration contre un trimesh supprime toute la vitesse en un seul tick — jusqu'à 87 km/h perdus d'un coup.
- **Rendu** : ciel de Preetham + carte d'environnement PMREM, matériaux PBR (peinture vernie), ombres dynamiques qui suivent la voiture, brouillard de distance, MSAA du canvas, tone mapping ACES. Rendu direct à la canvas (pas de chaîne de post-traitement) : c'était la source de surcoût GPU et de frames noires. Le pixel ratio est plafonné à 1,25 et une régulation automatique baisse la résolution puis les ombres si la machine tient moins de 48 fps.
- **Fumée et étincelles** : deux `THREE.Points`, 420 bouffées (180 en `fx=low`) et 260 étincelles (120 en `fx=low`), textures dessinées sur canvas, taille, opacité et teinte par particule dans un shader ; aucun fichier ni appel de dessin supplémentaire par bouffée.
- **Moto** : le corps Rapier ne tourne qu'autour de l'axe vertical (le roulis et le tangage sont des états simulés), pour que les deux taches de contact restent exactement sous les roues dessinées. Le lacet est plafonné par le grip disponible avec une marge sous la limite de frottement (`v·ω ≈ 0,82 µg`, sinon la moto dérive comme une voiture), le roulis affiché en découle (`atan(v·ω/g)`), et le tangage suit un pendule autour du contact arrière que le pilote tient en modulant les gaz : l'appui de la roue avant verrouille l'équilibre à plat, le couple d'essieu casse cet appui, la consigne d'angle suit l'accélérateur (limitée par le couple disponible et par le grip de la surface) et le frein exerce un couple de rappel. Le couple envoyé à la roue arrière est plafonné par le cercle de frottement, sinon la moto patine à la limite sur l'herbe au lieu d'avancer. La géométrie visuelle s'articule en trois pivots — ligne de contact, roulis, wheelie — afin qu'aucune pose ne décolle la roue arrière.
- **Assets** : le terrain, les bâtiments, les arbres et la synthèse audio sont générés par code au chargement. La voiture sélectionnée est chargée depuis `public/models/cars/`, le mobilier de rue depuis `public/models/kenney-city-roads/` (15 modèles GLB, une seule texture palette) et les prises de son depuis `public/audio/`. Les maisons, leurs toits, les commerces et les têtes de lampadaires sont des `InstancedMesh` : sept draw calls pour tout l'habitat. Si un modèle ou un son manque, le jeu démarre quand même (voiture de secours, couche synthétique seule).
- **Modèles de voiture** : le chargeur (`render/carModel.ts`) cuit les transformations du GLB dans les géométries, applique le lacet qui amène le nez sur −Z, met les roues à l'échelle de l'empattement du châssis puis les recentre sur leurs moyeux ; la caisse est posée pour que les pneus touchent le même plan que les points de contact de la physique. Changer de voiture recharge un modèle à la demande et libère l'ancien.
- **i20 N** : le fichier d'origine est un diorama de démonstration (deux voitures, socle, matériaux spec/gloss que three.js ne lit plus). `scripts/convert-i20.py` en extrait une seule voiture, sépare les quatre roues de la caisse (les étriers restent fixes), convertit les matériaux en métal/rugosité, supprime les tangentes inutiles et recompresse les textures : 21 Mo de glTF deviennent un GLB de 4,4 Mo.
- **Déterminisme** : la carte est générée avec une graine fixe ; elle est identique à chaque partie.

### Structure

```
src/
  main.ts              boucle de jeu, modes, caméra, audio, HUD
  physics/             pneus, transmission, véhicule et moto Rapier, dynamique du wheelie
  world/               tracé des routes, terrain, ville, mobilier Kenney
  render/              voiture et moto procédurales, chargeurs GLB (voiture, moto), fumée, étincelles, matériaux, ciel
  core/                entrées clavier/manette/tactile, caméra
  game/                drift, stunt, course, HUD, audio (+ DSP, mixage, panneau), atelier, catalogues voitures et moto
tests/                 physique et logique de jeu (Node)
scripts/smoke.mjs      test de fumée navigateur (Playwright)
```

## Développement

```bash
npm ci
npm run dev        # serveur de dev
npm run build      # typecheck + build de production dans dist/
npm run preview    # sert le build
npm test           # 54 tests Node : pneus, boîte, rupteur, véhicule, suspension, drift, stunt, wheelie/lean de la moto, marche arrière, réglages, surfaces, tracé du col, aires de drift, fins de rues, adhérence roue par roue et contrôle de traction (on/off), départ arrêté, « crabe », pneus tout-terrain, collision du châssis, mixage audio
```

Test navigateur (optionnel) :

```bash
npx playwright install chromium
npm run dev &
node scripts/smoke.mjs
```

Le test de fumée vérifie le démarrage, le menu, le chargement du modèle de voiture et ses cotes, le changement de voiture dans l'atelier, le mobilier Kenney, les ronds de retournement, les **quartiers habités** (maisons et commerces), le **décodage des deux prises turbo**, la fumée au patinage, le **commutateur TCS**, le panneau de mixage (un fader par famille, mémorisation, réinitialisation), l'atelier (catégories, application d'une pièce), la conduite au clavier avec des roues qui tournent, le HUD (dont le compte-tours), le compte à rebours de la course, les départs sur le col, sur la spéciale en terre (surface « terre » confirmée, **sans wheelspin interminable**) et au sommet — dont la planéité et la solidité du béton sur tout le disque —, ainsi que le déclenchement des effets sonores. Il passe aussi sur la **moto** : HUD de stunt, inclination en virage, wheelie au bouton, bavette avec étincelles, frein qui repose l'avant, et retour à une voiture par l'atelier. Dans un environnement sans GPU, Chromium utilise SwiftShader : le rendu tourne alors à 1–2 fps et les contrôles temporels du test sont volontairement larges.

## Déploiement (GitHub Pages)

Le workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) construit le jeu, lance les tests et publie `dist/` à chaque push sur `main`.

1. Pousser sur `main`.
2. Le site est publié sur `https://<compte>.github.io/SP95/`.

Le build utilise la variable `GITHUB_PAGES=true` pour définir le `base` Vite sur `/SP95/`. L'étape `configure-pages` est lancée avec `enablement: true` : elle active Pages en mode « GitHub Actions » au premier déploiement, sans réglage manuel.

> **Dépôt privé :** GitHub Pages n'est pas disponible sur l'offre gratuite pour un dépôt privé. Le dépôt doit rester public pour que le déploiement fonctionne.

## Crédits

- **City Kit Roads 2.2** de [Kenney](https://www.kenney.nl) — licence [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Les modèles et leur licence sont dans `public/models/kenney-city-roads/`.
- **Hyundai i20** (« Hyundai I20 ») par [ANDREO12](https://sketchfab.com/ANDREO12) — licence [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), source [Sketchfab](https://sketchfab.com/models/c1f8bb74d4ef4ec9aa56a6ad159476c3) ; modifié (une seule voiture conservée, roues séparées, matériaux convertis, textures recompressées). L'attribution est conservée dans les métadonnées du GLB.
- **Lamborghini Aventador** — modèle « CAR Model » d'Ignition Labs, fourni par le propriétaire du dépôt. Licence à confirmer.
- **Mazda RX-7 FD** — modèle d'IvOfficial, fourni par le propriétaire du dépôt. Licence à confirmer.
- Les fichiers sources sont conservés dans `assets/cars/` ; les modèles servis sont dans `public/models/cars/`.

## Limites connues

- **Modèles fournis par l'utilisateur** : l'Aventador et la RX-7 n'ont pas de licence explicite dans leurs fichiers ; l'i20 N est un modèle Sketchfab en CC BY 4.0 (voir les crédits). Vérifier les droits avant toute redistribution commerciale.
- La peinture d'atelier ne recolore pas les modèles texturés : la teinte vient de leurs textures.
- Pas de dégâts, pas d'adversaires IA pour l'instant.
- La ceinture, la route du col et la spéciale en terre sont des surfaces visuelles posées sur le terrain ; la physique roule sur le terrain aplati au niveau de la route (3 cm d'écart sur la plaine, 9 cm sur le col et le gravier). Les deux aires de drift, elles, ont leur propre collider au niveau du béton.
- **Feux arrière** : les trois modèles ont leurs feux peints dans la carrosserie (l'Aventador et la i20 n'ont aucun nœud de feu, la RX-7 n'a que ses optiques avant en matériau émissif). Ils ne s'allument donc pas au freinage : les rectangles émissifs ajoutés par-dessus flottaient derrière la caisse et ont été retirés.
- **Sons fournis** : les deux prises de décharge turbo de `public/audio/` viennent du propriétaire du dépôt ; leur licence n'est pas documentée. Ce sont les seules prises utilisées, en one-shot : le moteur, lui, est entièrement synthétisé, donc plus aucune boucle ni transposition de clip à entendre.
- Les textures de sol sont peintes par code : herbe, terre et asphalte se répètent, il n'y a pas de mélange de matériaux aux transitions.
- La spéciale rallye est une boucle : pas de chrono ni de copilote pour l'instant.
- Ni le col ni la spéciale n'ont de glissières : sortir de la route en épingle envoie la voiture dans la pente ou dans l'herbe (la touche `R` la remet sur la route).
- Le plateau sommital est volontairement nu : c'est une aire de drift, pas un village.
- Les performances dépendent du GPU : avec les maisons des quartiers en plus des immeubles, une carte intégrée peut descendre sous 60 fps (la régulation baisse alors la qualité toute seule).
- **Frein à main et fumée** : le contrôle de traction garde un départ en ligne droite propre, donc la fumée ne sort plus au simple démarrage : il faut un burnout (frein à main, ou antipatinage coupé avec `T`) ou une glisse.
- Testé automatiquement (physique + fumée navigateur) ; l'appréciation visuelle et le ressenti au volant restent à valider sur une vraie machine.

## Crédits

- [Three.js](https://threejs.org/) — MIT.
- [Rapier](https://rapier.rs/) — Apache-2.0.
- Tous les autres contenus sont générés par le code de ce dépôt.
