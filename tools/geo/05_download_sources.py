#!/usr/bin/env python3
"""Étape 5 : sources du corridor et orthophotos, téléchargées en cache."""
import hashlib
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

from pyproj import Transformer

RAW = Path('data/raw')
CORRIDOR_M = 300
DEM_MARGIN_M = 1500
TIMEOUT_SECONDS = 180
OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
STAC_URL = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissimage-dop10/items'
TO_WGS = Transformer.from_crs(2056, 4326, always_xy=True)
USER_AGENT = 'SP95 Mollendruz research/1.0'


def request_cached(url, path, data=None):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, data=data, headers={'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read()
        if not body:
            raise ValueError('réponse vide')
        if path.suffix == '.json':
            result = json.loads(body)
            if result.get('remark'):
                raise ValueError(result['remark'])
        temp = path.with_suffix(path.suffix + '.part')
        temp.write_bytes(body)
        temp.replace(path)
    except Exception as error:
        raise RuntimeError(f'Échec de {urllib.parse.urlparse(url).netloc} : {error}') from error


def geographic_bbox(bounds):
    x0, y0, x1, y1 = bounds
    points = [TO_WGS.transform(x, y) for x in (x0, x1) for y in (y0, y1)]
    return (min(p[0] for p in points), min(p[1] for p in points),
            max(p[0] for p in points), max(p[1] for p in points))


def expand(bounds, margin):
    x0, y0, x1, y1 = bounds
    return (x0 - margin, y0 - margin, x1 + margin, y1 + margin)


def main():
    route = json.loads((RAW / 'route.json').read_text())
    west, south, east, north = geographic_bbox(expand(route['bbox_lv95'], CORRIDOR_M))
    bbox = f'{south},{west},{north},{east}'
    query = f'''[out:json][timeout:90];
( way["barrier"]({bbox}); way["natural"~"wood|tree_row"]({bbox});
  way["landuse"~"forest|meadow|farmland"]({bbox}); way["building"]({bbox}); );
out geom tags;'''
    osm_path = RAW / 'osm_corridor.json'
    request_cached(OVERPASS_URL, osm_path, urllib.parse.urlencode({'data': query}).encode())
    elements = json.loads(osm_path.read_text())['elements']
    print('Corridor OSM bbox', (west, south, east, north), 'éléments', len(elements), flush=True)
    counts = {}
    for el in elements:
        for tag in ('barrier', 'natural', 'landuse', 'building'):
            if tag in el.get('tags', {}):
                key = f'{tag}={el["tags"][tag]}'
                counts[key] = counts.get(key, 0) + 1
    print('Éléments par catégorie', counts, flush=True)

    bbox = geographic_bbox(expand(route['bbox_lv95'], DEM_MARGIN_M))
    url = STAC_URL + '?' + urllib.parse.urlencode({'bbox': ','.join(map(str, bbox)), 'limit': 100})
    seen = set()
    items = []
    while url:
        if url in seen:
            raise ValueError('Boucle de pagination STAC')
        seen.add(url)
        key = hashlib.sha256(url.encode()).hexdigest()[:16]
        path = RAW / f'stac_image_{key}.json'
        request_cached(url, path)
        page = json.loads(path.read_text())
        items.extend(page['features'])
        url = next((urllib.parse.urljoin(url, link['href']) for link in page.get('links', [])
                    if link.get('rel') == 'next'), None)
    tiles = {}
    for item in items:
        match = re.fullmatch(r'swissimage-dop10_(\d{4})_(\d+-\d+)', item['id'])
        if not match:
            continue
        year, tile = int(match.group(1)), match.group(2)
        assets = [v['href'] for k, v in item.get('assets', {}).items() if k.endswith('_2_2056.tif')]
        if assets and (tile not in tiles or year > tiles[tile][0]):
            tiles[tile] = (year, assets[0])
    if not tiles:
        raise ValueError('Aucune tuile SWISSIMAGE 2 m')
    print('Orthophotos 2 m, tuiles', len(tiles), flush=True)
    total = 0
    for tile, (year, href) in sorted(tiles.items()):
        dest = RAW / 'swissimage' / Path(urllib.parse.urlparse(href).path).name
        request_cached(href, dest)
        total += dest.stat().st_size
        print(tile, year, dest.stat().st_size, flush=True)
    (RAW / 'swissimage_manifest.json').write_text(json.dumps(
        {'bbox': bbox, 'tiles': [{'id': t, 'year': y, 'url': u} for t, (y, u) in sorted(tiles.items())]}, indent=2))
    print('Total orthophotos octets', total, flush=True)


if __name__ == '__main__':
    main()
