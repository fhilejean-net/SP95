#!/usr/bin/env python3
"""Étape 3 : inventaire STAC, téléchargement des tuiles et vérification du MNT."""
import hashlib
import json
import math
import re
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.merge import merge

DEM_MARGIN_M = 1500
HIGH_RES_CORRIDOR = False
COLLECTION = 'ch.swisstopo.swissalti3d'
STAC_URL = f'https://data.geo.admin.ch/api/stac/v1/collections/{COLLECTION}/items'
PASS_LON_LAT = (6.3645639, 46.6505139)
TIMEOUT_SECONDS = 120
RAW = Path('data/raw')
TILES = RAW / 'dem'
TO_LV95 = Transformer.from_crs(4326, 2056, always_xy=True)
TO_WGS = Transformer.from_crs(2056, 4326, always_xy=True)


def cached_download(url, dest):
    if dest.exists():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={'User-Agent': 'SP95 Mollendruz research/1.0'})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            data = response.read()
        if not data:
            raise ValueError('réponse vide')
        temp = dest.with_suffix(dest.suffix + '.part')
        temp.write_bytes(data)
        temp.replace(dest)
    except Exception as error:
        raise RuntimeError(f'Échec domaine {urllib.parse.urlparse(url).netloc}, URL {url}: {error}') from error


def main():
    route = json.loads((RAW / 'route.json').read_text())
    x0, y0, x1, y1 = route['bbox_lv95']
    # Aligner la mosaïque sur les pixels 2 m des tuiles évite une bordure nodata.
    bounds = (math.floor((x0 - DEM_MARGIN_M) / 2) * 2, math.floor((y0 - DEM_MARGIN_M) / 2) * 2,
              math.ceil((x1 + DEM_MARGIN_M) / 2) * 2, math.ceil((y1 + DEM_MARGIN_M) / 2) * 2)
    # La recherche en cache conserve la bbox exacte déjà interrogée.
    corners = [TO_WGS.transform(x, y) for x in (x0 - DEM_MARGIN_M, x1 + DEM_MARGIN_M)
               for y in (y0 - DEM_MARGIN_M, y1 + DEM_MARGIN_M)]
    bbox = (min(c[0] for c in corners), min(c[1] for c in corners), max(c[0] for c in corners), max(c[1] for c in corners))
    print('Bbox DEM WGS84', bbox, 'LV95', bounds, flush=True)
    url = STAC_URL + '?' + urllib.parse.urlencode({'bbox': ','.join(map(str, bbox)), 'limit': 100})
    features = []
    seen = set()
    page = 1
    while url:
        if url in seen:
            raise ValueError('Boucle de pagination STAC')
        seen.add(url)
        # Une bbox ou un curseur différent ne doit jamais réutiliser une autre page.
        key = hashlib.sha256(url.encode()).hexdigest()[:16]
        path = RAW / f'stac_alti_{key}.json'
        cached_download(url, path)
        data = json.loads(path.read_text())
        features.extend(data['features'])
        url = next((urllib.parse.urljoin(url, l['href']) for l in data.get('links', []) if l.get('rel') == 'next'), None)
        print('Page STAC', page, 'éléments', len(data['features']), flush=True)
        page += 1
    tiles = {}
    for item in features:
        match = re.fullmatch(r'swissalti3d_(\d{4})_(\d+-\d+)', item['id'])
        if not match:
            continue
        year, tile = int(match.group(1)), match.group(2)
        assets = [a for name, a in item.get('assets', {}).items() if name.endswith('_2_2056_5728.tif')]
        if assets and (tile not in tiles or year > tiles[tile][0]):
            tiles[tile] = (year, assets[0]['href'])
    if not tiles:
        raise ValueError('Aucune tuile 2 m trouvée')
    print('Tuiles 2 m retenues :', len(tiles), '(attendu approximativement 15–40)', flush=True)
    if not 15 <= len(tiles) <= 40:
        print('ATTENTION : nombre de tuiles très différent de l’estimation.', flush=True)
    paths = []
    for tile, (year, href) in sorted(tiles.items()):
        dest = TILES / Path(urllib.parse.urlparse(href).path).name
        cached_download(href, dest)
        paths.append(dest)
        print('Tuile', tile, 'année', year, 'octets', dest.stat().st_size, flush=True)
    sources = [rasterio.open(p) for p in paths]
    try:
        for src in sources:
            if src.crs.to_epsg() != 2056:
                raise ValueError(f'CRS inattendu : {src.name} {src.crs}')
        data, transform = merge(sources, bounds=bounds, res=2, nodata=-9999)
        out = RAW / 'dem_mosaic.tif'
        with rasterio.open(out, 'w', driver='GTiff', width=data.shape[2], height=data.shape[1], count=1,
                           dtype=data.dtype, crs='EPSG:2056', transform=transform, nodata=-9999, compress='deflate') as dst:
            dst.write(data)
    finally:
        for src in sources: src.close()
    with rasterio.open(out) as src:
        vals = data[0][data[0] != -9999]
        if not vals.size or np.any(data[0] == -9999):
            raise ValueError('Mosaïque vide ou incomplète dans la zone demandée')
        pts = [TO_LV95.transform(*PASS_LON_LAT), TO_LV95.transform(*route['start'])]
        pass_h, start_h = [float(value[0]) for value in src.sample(pts)]
        print(f'Altitude col {pass_h:.2f} m, START {start_h:.2f} m, min {vals.min():.2f} m, max {vals.max():.2f} m', flush=True)
        if abs(pass_h - 1180) > 5 or not 1170 <= start_h <= 1185:
            print('ATTENTION : altitude hors plage attendue ; vérifier la position et le MNT.', flush=True)
    (RAW / 'dem_manifest.json').write_text(json.dumps({'bounds_lv95': bounds, 'bbox_wgs84': bbox,
        'tiles': [{'id': t, 'year': y, 'url': u} for t, (y, u) in sorted(tiles.items())]}, indent=2))


if __name__ == '__main__':
    main()
