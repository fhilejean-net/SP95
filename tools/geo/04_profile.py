#!/usr/bin/env python3
"""Étape 4 : profil, dévers estimé et export compact avant validation humaine."""
import csv
import json
import re
from pathlib import Path

import numpy as np
import rasterio
from scipy.ndimage import map_coordinates
from scipy.signal import savgol_filter

ROAD_WIDTH_DEFAULT = 6.0
LANE_WIDTH_M = 3.0
EDGE_WIDTH_M = 0.5
SMOOTH_WINDOW_M = 30
SAMPLE_SPACING_M = 2
MAX_BANK = 0.06
RAW = Path('data/raw')
OUTPUT = Path('public/data/mollendruz')


def width_for(tags):
    value = tags.get('width', '')
    match = re.fullmatch(r'\s*(\d+(?:\.\d+)?)\s*(?:m|meters|metres)?\s*', value)
    if match:
        return float(match.group(1)), 'width OSM'
    lanes = tags.get('lanes', '')
    if lanes.isdigit() and int(lanes) > 0:
        return int(lanes) * LANE_WIDTH_M + EDGE_WIDTH_M, 'lanes OSM estimé'
    return ROAD_WIDTH_DEFAULT, 'UNVERIFIED'


def sample_bilinear(dataset, xs, ys):
    data = dataset.read(1, masked=True)
    if np.ma.getmaskarray(data).any():
        raise ValueError('La mosaïque comporte des zones nodata')
    inverse = ~dataset.transform
    cols, rows = inverse * (xs, ys)
    values = map_coordinates(np.asarray(data), [rows - 0.5, cols - 0.5], order=1, mode='constant', cval=np.nan)
    if not np.isfinite(values).all():
        raise ValueError('Point du profil en dehors du MNT')
    return values


def smooth_at(samples_s, values):
    # Savitzky–Golay sur une grille régulière, même si END tombe entre deux pas.
    grid = np.arange(0, samples_s[-1] + SAMPLE_SPACING_M, SAMPLE_SPACING_M)
    raw = np.interp(grid, samples_s, values)
    window = int(round(SMOOTH_WINDOW_M / SAMPLE_SPACING_M)) | 1
    filtered = savgol_filter(raw, window, 2, mode='interp')
    return np.interp(samples_s, grid, filtered)


def main():
    route = json.loads((RAW / 'route.json').read_text())
    with (RAW / 'centerline_lv95.csv').open() as f:
        rows = list(csv.DictReader(f))
    s = np.array([float(row['s']) for row in rows])
    e = np.array([float(row['E']) for row in rows])
    n = np.array([float(row['N']) for row in rows])
    if np.any(np.diff(s) <= 0):
        raise ValueError('Abscisses du tracé non strictement croissantes')
    widths = []
    width_sources = []
    ends = np.cumsum([way['length'] for way in route['ways']])
    for distance in s:
        way = route['ways'][min(int(np.searchsorted(ends, distance, side='right')), len(ends) - 1)]
        width, source = width_for(way['tags'])
        widths.append(width)
        width_sources.append(source)
    widths = np.array(widths)
    # Normale droite du trajet en LV95.
    de, dn = np.gradient(e, s), np.gradient(n, s)
    mag = np.hypot(de, dn)
    right_e, right_n = dn / mag, -de / mag
    with rasterio.open(RAW / 'dem_mosaic.tif') as dem:
        center = sample_bilinear(dem, e, n)
        right = sample_bilinear(dem, e + right_e * widths / 2, n + right_n * widths / 2)
        left = sample_bilinear(dem, e - right_e * widths / 2, n - right_n * widths / 2)
    height = smooth_at(s, center)
    bank = np.clip(smooth_at(s, (right - left) / widths), -MAX_BANK, MAX_BANK)
    gradient = np.gradient(height, s)
    end_s = route['end_s']
    end_height = float(np.interp(end_s, s, height))
    print(f'Distance START–END {end_s:.1f} m, extension {s[-1] - end_s:.1f} m')
    print(f'Altitude START {height[0]:.2f} m, END {end_height:.2f} m, dénivelé net {height[0] - end_height:.2f} m')
    print(f'Pente moyenne {(end_height-height[0])/end_s*100:.2f} %, pente absolue maximale {max(abs(gradient[s <= end_s]))*100:.2f} %')
    for start in np.arange(0, end_s, 500):
        end = min(start + 500, end_s)
        a, b = np.interp([start, end], s, height)
        print(f'{start:6.0f}–{end:6.0f} m : altitude {a:7.2f} → {b:7.2f} m, pente {(b-a)/(end-start)*100:+6.2f} %')
    print('Virages sous 30 m estimés :', len([b for b in route['bends'] if b['s'] <= end_s]))
    print('Sources largeur et mesures :', sorted(set(zip(width_sources, widths.tolist()))))
    print('Dévers DEM estimé :', round(float(bank.min())*100, 2), 'à', round(float(bank.max())*100, 2), '%')
    h0, e0, n0 = float(height[0]), float(e[0]), float(n[0])
    samples = [{'s': round(float(si), 2), 'x': round(float(ei-e0), 3), 'y': round(float(hi-h0), 3),
                'z': round(float(n0-ni), 3), 'width': round(float(w), 2), 'bank': round(float(b), 4)}
               for si, ei, ni, hi, w, b in zip(s, e, n, height, widths, bank)]
    output = {'crs': 'EPSG:2056', 'vertical_crs': 'EPSG:5728', 'origin': {'E0': e0, 'N0': n0, 'H0': round(h0, 3)},
              'end_s': round(end_s, 2), 'sample_spacing_m': SAMPLE_SPACING_M,
              'width_sources': sorted(set(width_sources)), 'samples': samples}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'centerline.json').write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')) + '\n')
    readme = OUTPUT / 'README.md'
    if not readme.exists():
        readme.write_text('''# Données préparatoires : Col du Mollendruz

Le tracé relie la sortie du parking OSM 76238299 au panneau d’entrée de Mont-la-Ville, avec 200 m supplémentaires. Ce fichier n’est pas encore intégré au jeu.

- Coordonnées horizontales : CH1903+ / LV95 (EPSG:2056), altitudes : LN02 (EPSG:5728).
- Origine : `E0`, `N0`, `H0` dans `centerline.json`. Repère du jeu : `x = E - E0`, `z = N0 - N`, `y = H - H0` (mètres).
- Route : [OpenStreetMap](https://www.openstreetmap.org/copyright), © contributeurs OpenStreetMap, [ODbL](https://opendatacommons.org/licenses/odbl/). Données Overpass mises en cache localement. Géométrie OSM approximative, pas un relevé cadastral.
- Altitude : [swissALTI3D](https://www.swisstopo.admin.ch/en/height-model-swissalti3d), © swisstopo, tuiles 2 m les plus récentes disponibles au téléchargement ; conditions officielles de swisstopo applicables.
- La largeur est estimée à partir des voies OSM si `width` manque ; `UNVERIFIED` désigne le défaut de 6 m. Le dévers est estimé à partir du terrain nu et limité à ±6 % : ce n’est pas une mesure de la chaussée.
- Le profil est interpolé bilinéairement puis lissé sur environ 30 m. Les surfaces de ponts et accotements peuvent différer du terrain nu ; aucune précision de route exacte n’est garantie.

Les scripts reproductibles sont dans `tools/geo/`, les tuiles brutes restent ignorées dans `data/raw/`.
''', encoding='utf-8')
    print('Export', OUTPUT / 'centerline.json', (OUTPUT / 'centerline.json').stat().st_size, 'octets')


if __name__ == '__main__':
    main()
