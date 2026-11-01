# Données du Col du Mollendruz

Le tracé relie la sortie du parking OSM 76238299 au panneau d’entrée de Mont-la-Ville, avec 200 m supplémentaires. Le jeu charge ces données sur la carte du col.

- Coordonnées horizontales : CH1903+ / LV95 (EPSG:2056), altitudes : LN02 (EPSG:5728).
- Origine : `E0`, `N0`, `H0` dans `centerline.json`. Repère du jeu : `x = E - E0`, `z = N0 - N`, `y = H - H0` (mètres).
- Route : [OpenStreetMap](https://www.openstreetmap.org/copyright), © contributeurs OpenStreetMap, [ODbL](https://opendatacommons.org/licenses/odbl/). Données Overpass mises en cache localement. Géométrie OSM approximative, pas un relevé cadastral.
- Altitude : [swissALTI3D](https://www.swisstopo.admin.ch/en/height-model-swissalti3d), © swisstopo, tuiles 2 m les plus récentes disponibles au téléchargement.
- Orthophoto : [SWISSIMAGE 10 cm, version 2 m](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10), © swisstopo. [Conditions des géodonnées libres](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices).
- La largeur est estimée à partir des voies OSM si `width` manque ; `UNVERIFIED` désigne le défaut de 6 m. Le dévers est estimé à partir du terrain nu et limité à ±6 % : ce n’est pas une mesure de la chaussée.
- Le profil est interpolé bilinéairement puis lissé sur environ 30 m. Les surfaces de ponts et accotements peuvent différer du terrain nu ; aucune précision de route exacte n’est garantie.

`terrain.json` décrit les blocs de 256 m, leurs dimensions, leur position et leur offset dans `terrain_chunks.bin`. Les hauteurs sont des entiers non signés little-endian, `y = heightOffset + entier × heightScale` ; l'échelon est de 2 cm. Les blocs sont générés à 1, 4 ou 16 m selon la distance à la route, et les bords fins sont raccordés aux bords grossiers. `swissimage.webp` est l'orthophoto et `hillshade.webp` sert au diagnostic. `features.json` contient les bâtiments et barrières OSM, le parking et les implantations d'arbres reproductibles.

Le corridor OSM téléchargé ne contient pas de glissière `guard_rail` ; les garde-fous du jeu sont estimés à partir des fortes chutes du MNT, et ne représentent pas des emplacements relevés. Les largeurs, la pente transversale et le relief de la chaussée restent approximatifs.

Les scripts reproductibles sont dans `tools/geo/` ; installer `pyproj rasterio numpy scipy shapely pillow` dans un environnement Python puis exécuter les scripts 01 à 07 dans l'ordre. Les tuiles brutes restent ignorées dans `data/raw/`.
