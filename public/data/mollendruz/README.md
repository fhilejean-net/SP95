# Données préparatoires : Col du Mollendruz

Le tracé relie la sortie du parking OSM 76238299 au panneau d’entrée de Mont-la-Ville, avec 200 m supplémentaires. Ce fichier n’est pas encore intégré au jeu.

- Coordonnées horizontales : CH1903+ / LV95 (EPSG:2056), altitudes : LN02 (EPSG:5728).
- Origine : `E0`, `N0`, `H0` dans `centerline.json`. Repère du jeu : `x = E - E0`, `z = N0 - N`, `y = H - H0` (mètres).
- Route : [OpenStreetMap](https://www.openstreetmap.org/copyright), © contributeurs OpenStreetMap, [ODbL](https://opendatacommons.org/licenses/odbl/). Données Overpass mises en cache localement. Géométrie OSM approximative, pas un relevé cadastral.
- Altitude : [swissALTI3D](https://www.swisstopo.admin.ch/en/height-model-swissalti3d), © swisstopo, tuiles 2 m les plus récentes disponibles au téléchargement ; conditions officielles de swisstopo applicables.
- La largeur est estimée à partir des voies OSM si `width` manque ; `UNVERIFIED` désigne le défaut de 6 m. Le dévers est estimé à partir du terrain nu et limité à ±6 % : ce n’est pas une mesure de la chaussée.
- Le profil est interpolé bilinéairement puis lissé sur environ 30 m. Les surfaces de ponts et accotements peuvent différer du terrain nu ; aucune précision de route exacte n’est garantie.

Les scripts reproductibles sont dans `tools/geo/`, les tuiles brutes restent ignorées dans `data/raw/`.
