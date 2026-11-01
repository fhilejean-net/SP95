#!/usr/bin/env python3
"""Étapes 1–2 : choix du parking et calcul du trajet routier en LV95."""
import csv
import heapq
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
from pyproj import Transformer
from scipy.ndimage import gaussian_filter1d
from shapely.geometry import LineString, Point, Polygon

SEARCH_BBOX = (6.330, 46.600, 6.450, 46.670)
ROAD_WIDTH_DEFAULT = 6.0
DEM_MARGIN_M = 1500
CORRIDOR_M = 300
EXTRA_AFTER_END_M = 200
PASS_LON_LAT = (6.3645639, 46.6505139)
PARKING_HINT_LON_LAT = (6.3662, 46.6500)
PARKING_RADIUS_M = 500
ROAD_SEARCH_M = 150
ROAD_STEP_M = 2
SMOOTH_SIGMA_M = 4
MAX_SMOOTH_DEVIATION_M = 0.3
SEGMENT_CHECK_M = 0.25
BEND_JOIN_GAP_M = 30
CITY_SIGN_DISTANCE_M = 25
FALLBACK_BEFORE_VILLAGE_M = 150
DRIVABLE = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'}
ROAD_CLASSES = DRIVABLE - {'service'}
PENALTIES = {'unclassified': 3.0, 'service': 3.0, 'residential': 1.5}
RAW = Path('data/raw')
TO_LV95 = Transformer.from_crs('EPSG:4326', 'EPSG:2056', always_xy=True)
TO_WGS = Transformer.from_crs('EPSG:2056', 'EPSG:4326', always_xy=True)


def coords(element):
    return [(g['lon'], g['lat']) for g in element.get('geometry', [])]


def lv(point):
    return TO_LV95.transform(*point)


def poly(element):
    return Polygon([lv(p) for p in coords(element)])


def line(element):
    return LineString([lv(p) for p in coords(element)])


def route():
    elements = json.loads((RAW / 'osm_search.json').read_text())['elements']
    pass_pos = Point(lv(PASS_LON_LAT))
    hint = Point(lv(PARKING_HINT_LON_LAT))
    print(f'Col LV95 E={pass_pos.x:.3f}, N={pass_pos.y:.3f}')
    parking = []
    for e in elements:
        if e.get('tags', {}).get('amenity') != 'parking':
            continue
        if len(coords(e)) >= 4:
            shape = poly(e)
            if not shape.is_valid:
                shape = shape.buffer(0)
        elif 'lon' in e:
            shape = Point(lv((e['lon'], e['lat'])))
        else:
            continue
        if shape.distance(pass_pos) <= PARKING_RADIUS_M:
            parking.append((e, shape))
            print('Parking candidat', e['id'], 'nom', e.get('tags', {}).get('name', '—'),
                  'surface m²', round(shape.area), 'col m', round(shape.distance(pass_pos), 1),
                  'indice-centre m', round(shape.centroid.distance(hint), 1),
                  'centre lon/lat', tuple(round(x, 7) for x in TO_WGS.transform(*shape.centroid.coords[0])))
    if not parking:
        raise ValueError('Aucun parking OSM à moins de 500 m du col.')
    # Priorité demandée : plus grande surface, proximité de l’indice en cas d’égalité.
    chosen, parking_shape = max(parking, key=lambda p: (p[1].area, -p[1].centroid.distance(hint)))
    print('PARKING CHOISI', chosen['id'], 'surface m²', round(parking_shape.area),
          'distance au col m', round(parking_shape.distance(pass_pos), 1))
    ways = [e for e in elements if e.get('tags', {}).get('highway') in DRIVABLE and len(coords(e)) >= 2]
    for w in ways:
        if line(w).distance(pass_pos) <= ROAD_SEARCH_M:
            t = w['tags']
            print('Route près du col', w['id'], 'distance m', round(line(w).distance(pass_pos), 1),
                  {k: t.get(k) for k in ('name', 'ref', 'rcrc_ref', 'highway', 'surface', 'lanes', 'width', 'maxspeed', 'oneway')})
    village = next((e for e in elements if e.get('tags', {}).get('place') == 'village' and e['tags'].get('name') == 'Mont-la-Ville'), None)
    if not village:
        raise ValueError('Nœud du village introuvable.')
    village_point = Point(lv((village['lon'], village['lat'])))
    print('VILLAGE', village['id'], village['lat'], village['lon'])

    # Overpass out geom ne fournit pas les identifiants des nœuds : on relie
    # uniquement les sommets de coordonnées exactement identiques.
    membership = defaultdict(list)
    for w in ways:
        for point in coords(w):
            membership[point].append(w)
    exits = []
    for w in ways:
        if w['tags']['highway'] != 'service' or line(w).distance(parking_shape) > 5:
            continue
        for p in coords(w):
            for road in membership[p]:
                if road['tags']['highway'] in ROAD_CLASSES:
                    exits.append((Point(lv(p)).distance(parking_shape), p, w, road))
    if not exits:
        raise ValueError('Aucune sortie OSM reliant un service de parking à la route.')
    _, start, service, mainroad = min(exits, key=lambda e: e[0])
    print('START sortie parking :', start, 'service', service['id'], 'route', mainroad['id'],
          'distance au polygone m', round(Point(lv(start)).distance(parking_shape), 1))
    start_ref = mainroad['tags'].get('ref')
    road_nodes = [p for p, ws in membership.items() if any(w['tags']['highway'] in ROAD_CLASSES for w in ws)]
    target = min(road_nodes, key=lambda p: Point(lv(p)).distance(village_point))
    print('Nœud route le plus proche du village', target, 'distance m', round(Point(lv(target)).distance(village_point), 1))
    graph = defaultdict(list)
    for w in ways:
        t = w['tags']
        points = coords(w)
        for a, b in zip(points, points[1:]):
            length = math.dist(lv(a), lv(b))
            weight = length * PENALTIES.get(t['highway'], 1)
            if t.get('oneway') != '-1':
                graph[a].append((b, weight, length, w))
            if t.get('oneway') not in ('yes', '1', 'true') and t.get('junction') != 'roundabout':
                graph[b].append((a, weight, length, w))
    dist = {start: 0.0}
    prev = {}
    queue = [(0.0, start)]
    while queue:
        cost, a = heapq.heappop(queue)
        if cost != dist[a]:
            continue
        if a == target:
            break
        for b, weight, length, w in graph[a]:
            new = cost + weight
            if new < dist.get(b, math.inf):
                dist[b] = new
                prev[b] = (a, length, w)
                heapq.heappush(queue, (new, b))
    if target not in dist:
        raise ValueError('Aucun itinéraire dirigé entre la sortie du parking et le village.')
    steps = []
    cursor = target
    while cursor != start:
        a, length, w = prev[cursor]
        steps.append((a, cursor, length, w))
        cursor = a
    steps.reverse()
    grouped = []
    for a, b, length, w in steps:
        if grouped and grouped[-1]['id'] == w['id']:
            grouped[-1]['length'] += length
        else:
            grouped.append({'id': w['id'], 'length': length, 'tags': w['tags']})
    for g in grouped:
        print('Voie utilisée', g['id'], 'ref', g['tags'].get('ref'), 'rcrc_ref', g['tags'].get('rcrc_ref'),
              'nom', g['tags'].get('name'), 'classe', g['tags']['highway'], 'longueur m', round(g['length'], 1))
    route_line = LineString([lv(start)] + [lv(b) for _, b, _, _ in steps])
    print('Trajet complet vers le village m', round(route_line.length, 1))
    print('Part hors référence de départ m', round(sum(g['length'] for g in grouped if g['tags'].get('ref') != start_ref), 1))
    # L'entrée de la zone résidentielle considérée doit appartenir au village,
    # et non à une autre localité traversée en descendant.
    candidates = []
    for e in elements:
        t = e.get('tags', {})
        if t.get('landuse') == 'residential' and len(coords(e)) >= 4:
            shape = poly(e)
            if shape.distance(village_point) <= 500 and shape.intersects(route_line):
                inter = route_line.intersection(shape)
                pts = []
                def collect(g):
                    if g.is_empty: return
                    if g.geom_type == 'Point': pts.append(g)
                    elif g.geom_type in ('LineString', 'LinearRing'):
                        pts.extend((Point(g.coords[0]), Point(g.coords[-1])))
                    elif hasattr(g, 'geoms'):
                        for sub in g.geoms: collect(sub)
                collect(inter)
                if pts:
                    s = min(route_line.project(p) for p in pts)
                    candidates.append((s, e['id'], shape.distance(village_point)))
    nearest_village_s = route_line.project(village_point)
    sign_candidates = []
    for e in elements:
        sign = e.get('tags', {}).get('traffic_sign', '')
        if e['type'] == 'node' and 'city_limit' in sign and 'lon' in e:
            p = Point(lv((e['lon'], e['lat'])))
            s = route_line.project(p)
            if p.distance(route_line) <= CITY_SIGN_DISTANCE_M and s >= nearest_village_s - 1000:
                sign_candidates.append((s, e['id'], p.distance(route_line)))
    print('Candidats panneaux (distance depuis START, id, écart route m):', sign_candidates)
    print('Candidats zones résidentielles (distance depuis START, id, écart village m):', candidates)
    fallback = max(0, nearest_village_s - FALLBACK_BEFORE_VILLAGE_M)
    print('Fallback à 150 m du point de route le plus proche du village :', round(fallback, 1), 'm')
    if sign_candidates:
        end_s, end_id, _ = min(sign_candidates)
        rule = f'panneau city_limit {end_id}'
    elif candidates:
        end_s, end_id, _ = min(candidates)
        rule = f'entrée landuse=residential {end_id}'
    else:
        end_s, rule = fallback, 'fallback 150 m avant le village'
    print('END règle', rule, 'distance m', round(end_s, 1))
    final_s = min(route_line.length, end_s + EXTRA_AFTER_END_M)
    if final_s < end_s + EXTRA_AFTER_END_M - 0.01:
        print('ATTENTION : moins de 200 m de route disponibles après END.')
    print('Voies START–END et prolongement :')
    offset = 0.0
    for g in grouped:
        used = max(0.0, min(g['length'], final_s - offset))
        if used > 0:
            print('  ', g['id'], 'ref', g['tags'].get('ref'), 'nom', g['tags'].get('name'),
                  'utilisé m', round(used, 1))
        offset += g['length']
    ss = np.unique(np.append(np.arange(0, final_s, ROAD_STEP_M), [end_s, final_s]))
    original = np.array([route_line.interpolate(float(s)).coords[0] for s in ss])
    smoothed = gaussian_filter1d(original, SMOOTH_SIGMA_M / ROAD_STEP_M, axis=0, mode='nearest')
    offsets = np.linalg.norm(smoothed - original, axis=1)
    weights = np.minimum(1, MAX_SMOOTH_DEVIATION_M / np.maximum(offsets, 1e-9))
    smoothed = original + (smoothed - original) * weights[:, None]
    smoothed[0] = original[0]
    smoothed_line = LineString(smoothed)
    max_deviation = max(smoothed_line.interpolate(float(d)).distance(route_line)
                        for d in np.arange(0, smoothed_line.length, SEGMENT_CHECK_M))
    print('Déviation max du lissage, contrôlée tous les 25 cm :', round(max_deviation, 3), 'm')
    if max_deviation > 0.5:
        raise ValueError('Le tracé lissé coupe un virage de plus de 0,5 m')
    with (RAW / 'centerline_lv95.csv').open('w', newline='') as f:
        writer = csv.writer(f); writer.writerow(('s', 'E', 'N'))
        writer.writerows((round(float(s), 4), round(float(p[0]), 4), round(float(p[1]), 4)) for s, p in zip(ss, smoothed))
    headings = np.unwrap(np.arctan2(np.gradient(smoothed[:, 0], ss), np.gradient(smoothed[:, 1], ss)))
    curvature = np.gradient(headings, ss)
    sharp = np.abs(curvature) > 1 / 30
    bends = []
    groups = []
    for index in np.flatnonzero(sharp):
        if (not groups or ss[index] - ss[groups[-1][-1]] > BEND_JOIN_GAP_M
                or np.sign(curvature[index]) != np.sign(curvature[groups[-1][-1]])):
            groups.append([])
        groups[-1].append(index)
    for group in groups:
        i = group[np.argmax(np.abs(curvature[group]))]
        bends.append({'s': round(float(ss[i]), 1), 'radius': round(float(1 / abs(curvature[i])), 1),
                      'direction': 'droite' if curvature[i] > 0 else 'gauche',
                      'start_s': round(float(ss[group[0]]), 1), 'end_s': round(float(ss[group[-1]]), 1)})
    print('Virages sous 30 m (estimations OSM) :', bends)
    xs, ys = smoothed[:, 0], smoothed[:, 1]
    bbox_lv = (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))
    ll = [TO_WGS.transform(x, y) for x, y in smoothed]
    bbox_ll = (min(p[0] for p in ll), min(p[1] for p in ll), max(p[0] for p in ll), max(p[1] for p in ll))
    print('Bbox LV95', bbox_lv, 'WGS84', bbox_ll)
    metadata = {'parking_id': chosen['id'], 'parking_area_m2': parking_shape.area,
                'parking_distance_m': parking_shape.distance(pass_pos), 'start': start, 'village_id': village['id'],
                'end_s': end_s, 'end_rule': rule, 'route_length_with_extension': final_s,
                'bbox_lv95': bbox_lv, 'bbox_wgs84': bbox_ll, 'bends': bends,
                'ways': grouped, 'route_points': [lv(start)] + [lv(b) for _, b, _, _ in steps]}
    (RAW / 'route.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    route()
