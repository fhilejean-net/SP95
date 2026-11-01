#!/usr/bin/env python3
"""Étape 6 : sélection reproductible des éléments OSM du corridor."""
import json
import math
import random
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon
from shapely.prepared import prep

RAW = Path('data/raw')
OUT = Path('public/data/mollendruz')
CORRIDOR_M = 300
BUILDING_END_RADIUS_M = 600
TREE_SPACING_M = 12
TREE_ROAD_CLEARANCE_M = 8
TREE_LIMIT = 5000
TREE_SEED = 151
DEFAULT_BUILDING_HEIGHT_M = 7
FLOOR_HEIGHT_M = 3
WALL_TYPES = {'guard_rail', 'wall', 'fence', 'retaining_wall'}
TO_LV95 = Transformer.from_crs(4326, 2056, always_xy=True)


def main():
    data = json.loads((OUT / 'centerline.json').read_text())
    ox, on = data['origin']['E0'], data['origin']['N0']
    def convert(g):
        e,n = TO_LV95.transform(g['lon'], g['lat'])
        return (e-ox, on-n)
    samples = data['samples']
    road = LineString([(p['x'], p['z']) for p in samples])
    corridor_shape = road.buffer(CORRIDOR_M)
    corridor = prep(corridor_shape)
    end = road.interpolate(data['end_s'])
    items = json.loads((RAW / 'osm_corridor.json').read_text())['elements']
    buildings, walls, forests = [], [], []
    for item in items:
        points = [convert(p) for p in item.get('geometry', [])]
        if len(points) < 2:
            continue
        tags = item.get('tags', {})
        line = LineString(points)
        if tags.get('barrier') in WALL_TYPES and corridor.intersects(line):
            walls.append({'id': item['id'], 'kind': tags['barrier'],
                          'points': [[round(x, 2), round(z, 2)] for x,z in points]})
        if len(points) < 4 or points[0] != points[-1]:
            continue
        shape = Polygon(points)
        if not shape.is_valid:
            shape = shape.buffer(0)
        if shape.is_empty or not corridor.intersects(shape):
            continue
        if tags.get('building') and shape.distance(end) < BUILDING_END_RADIUS_M:
            try:
                height = float(tags.get('height', '').replace(' m', ''))
            except ValueError:
                try:
                    height = float(tags.get('building:levels', '')) * FLOOR_HEIGHT_M
                except ValueError:
                    height = DEFAULT_BUILDING_HEIGHT_M
            buildings.append({'id': item['id'], 'height': min(30, max(2, height)),
                              'points': [[round(x,2), round(z,2)] for x,z in points]})
        if tags.get('landuse') == 'forest' or tags.get('natural') == 'wood':
            forests.append(shape.intersection(corridor_shape))
    # Tirage par grille locale, seed fixe ; aucune implantation sur la chaussée.
    rng = random.Random(TREE_SEED)
    trees = []
    covered = set()
    for forest in forests:
        minx,minz,maxx,maxz = forest.bounds
        prepared = prep(forest)
        for iz in range(math.floor(minz / TREE_SPACING_M), math.ceil(maxz / TREE_SPACING_M)):
            for ix in range(math.floor(minx / TREE_SPACING_M), math.ceil(maxx / TREE_SPACING_M)):
                key = (ix,iz)
                if key in covered:
                    continue
                x = (ix+rng.random())*TREE_SPACING_M
                z = (iz+rng.random())*TREE_SPACING_M
                p = Point(x,z)
                if prepared.contains(p) and corridor.contains(p) and road.distance(p) >= TREE_ROAD_CLEARANCE_M:
                    trees.append([round(x,2), round(z,2), round(rng.uniform(0.75,1.3),2)])
                    covered.add(key)
    rng.shuffle(trees)
    trees = trees[:TREE_LIMIT]
    osm = json.loads((RAW / 'osm_search.json').read_text())['elements']
    parking = next(e for e in osm if e['id'] == 76238299)
    result = {'parking': [[round(x,2),round(z,2)] for x,z in map(convert, parking['geometry'])],
              'buildings': buildings, 'walls': walls, 'trees': trees, 'seed': TREE_SEED}
    (OUT / 'features.json').write_text(json.dumps(result, separators=(',', ':'))+'\n')
    print('Bâtiments', len(buildings), 'murs/barrières', len(walls), 'arbres', len(trees),
          'forêts', len(forests), 'parking', len(result['parking']), flush=True)
    print('Types barrières', {t: sum(w['kind'] == t for w in walls) for t in WALL_TYPES}, flush=True)


if __name__ == '__main__':
    main()
