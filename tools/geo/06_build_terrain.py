#!/usr/bin/env python3
"""Étape 5 : blocs 16 bits, raccord à la chaussée et mosaïque SWISSIMAGE."""
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.merge import merge
from scipy.ndimage import map_coordinates
from scipy.spatial import cKDTree
from shapely.geometry import LineString, box

RAW = Path('data/raw')
OUT = Path('public/data/mollendruz')
CHUNK_M = 256
NEAR_M = 150
MID_M = 800
NEAR_STEP_M = 1
MID_STEP_M = 4
FAR_STEP_M = 16
HEIGHT_SCALE_M = 0.02
SHOULDER_M = 1.5
BLEND_M = 8
IMAGE_MAX_SIZE = 4096
WEBP_QUALITY = 85
HILLSHADE_WIDTH = 1200
HILLSHADE_SUN_AZIMUTH = 315
HILLSHADE_SUN_ALTITUDE = 45
MAX_TOTAL_BYTES = 50 * 1024 * 1024


def main():
    route = json.loads((OUT / 'centerline.json').read_text())
    origin = route['origin']
    samples = route['samples']
    xy = np.array([[p['x'], p['z']] for p in samples])
    road_height = np.array([p['y'] for p in samples])
    widths = np.array([p['width'] for p in samples])
    banks = np.array([p['bank'] for p in samples])
    tree = cKDTree(xy)
    road = LineString(xy)
    image_paths = sorted((RAW / 'swissimage').glob('*_2_2056.tif'))
    if not image_paths:
        raise ValueError('Orthophotos absentes')
    with rasterio.open(RAW / 'dem_mosaic.tif') as dem:
        data = dem.read(1, masked=True)
        if np.ma.getmaskarray(data).any():
            raise ValueError('MNT incomplet')
        data = np.asarray(data)
        inverse = ~dem.transform
        x0 = float(dem.bounds.left - origin['E0'])
        x1 = float(dem.bounds.right - origin['E0'])
        z0 = float(origin['N0'] - dem.bounds.top)
        z1 = float(origin['N0'] - dem.bounds.bottom)
        base = math.floor(float(data.min()) / HEIGHT_SCALE_M) * HEIGHT_SCALE_M - origin['H0']
        # Ombrage de contrôle produit depuis le MNT, sans lire l'image comme du texte.
        shade_rows = max(1, round(dem.height * HILLSHADE_WIDTH / dem.width))
        shade_dem = dem.read(1, out_shape=(shade_rows, HILLSHADE_WIDTH), resampling=Resampling.bilinear)
        dy, dx = np.gradient(shade_dem, (z1-z0)/shade_rows, (x1-x0)/HILLSHADE_WIDTH)
        az = math.radians(HILLSHADE_SUN_AZIMUTH); alt = math.radians(HILLSHADE_SUN_ALTITUDE)
        nx, ny, nz = -dx, np.ones_like(dx), -dy
        normal = np.sqrt(nx*nx + ny*ny + nz*nz)
        light = (nx*math.sin(az)*math.cos(alt) + ny*math.sin(alt) - nz*math.cos(az)*math.cos(alt)) / normal
        shade = np.uint8(np.clip((light*0.65+0.35)*255, 0, 255))
        Image.fromarray(shade).save(OUT / 'hillshade.webp', 'WEBP', quality=WEBP_QUALITY)
        print('Terrain repère jeu', (x0, z0, x1, z1), 'offset', base, 'pas', HEIGHT_SCALE_M, flush=True)
        if float(data.max() - data.min()) / HEIGHT_SCALE_M > 65535:
            raise ValueError('Altitude trop étendue pour la précision choisie')
        manifest = []
        counts = {NEAR_STEP_M: 0, MID_STEP_M: 0, FAR_STEP_M: 0}
        rows = math.ceil((z1 - z0) / CHUNK_M)
        cols = math.ceil((x1 - x0) / CHUNK_M)
        for iz in range(rows):
            for ix in range(cols):
                left, top = x0 + ix * CHUNK_M, z0 + iz * CHUNK_M
                width, depth = min(CHUNK_M, x1 - left), min(CHUNK_M, z1 - top)
                distance = road.distance(box(left, top, left + width, top + depth))
                step = NEAR_STEP_M if distance <= NEAR_M else MID_STEP_M if distance <= MID_M else FAR_STEP_M
                nx, nz = math.ceil(width / step), math.ceil(depth / step)
                xs = np.linspace(left, left + width, nx + 1)
                zs = np.linspace(top, top + depth, nz + 1)
                gx, gz = np.meshgrid(xs, zs)
                e = gx + origin['E0']; n = origin['N0'] - gz
                col, row = inverse * (e, n)
                h = map_coordinates(data, [row - 0.5, col - 0.5], order=1, mode='nearest') - origin['H0']
                pts = np.column_stack((gx.ravel(), gz.ravel()))
                distances, nearest = tree.query(pts, workers=1)
                mask = distances < (widths[nearest] / 2 + SHOULDER_M + BLEND_M + 2)
                if np.any(mask):
                    p = pts[mask]
                    mid = nearest[mask]
                    # Deux segments adjacents : projection continue et interpolation du profil.
                    i0 = np.maximum(0, mid - 1); i1 = np.minimum(len(xy) - 2, mid)
                    def projection(indices):
                        a = xy[indices]; delta = xy[indices + 1] - a
                        t = np.clip(np.sum((p-a)*delta, axis=1) / np.maximum(np.sum(delta*delta, axis=1), 1e-9), 0, 1)
                        nearest_xy = a + t[:, None]*delta
                        return np.sum((p-nearest_xy)**2, axis=1), t, nearest_xy, delta
                    d0, t0, q0, v0 = projection(i0); d1, t1, q1, v1 = projection(i1)
                    choose = d1 < d0
                    idx = np.where(choose, i1, i0); t = np.where(choose, t1, t0)
                    q = np.where(choose[:, None], q1, q0); v = np.where(choose[:, None], v1, v0)
                    dist = np.sqrt(np.where(choose, d1, d0))
                    signed = ((p[:, 0] - q[:, 0]) * -v[:, 1] + (p[:, 1] - q[:, 1]) * v[:, 0]) / np.maximum(np.linalg.norm(v, axis=1), 1e-9)
                    width_here = widths[idx] * (1-t) + widths[idx+1]*t
                    bank = banks[idx] * (1-t) + banks[idx+1]*t
                    center = road_height[idx]*(1-t) + road_height[idx+1]*t
                    road_y = center + bank * signed
                    fade = np.clip((dist - (width_here/2 + SHOULDER_M)) / BLEND_M, 0, 1)
                    fade = fade * fade * (3 - 2*fade)
                    hflat = h.ravel(); hflat[mask] = road_y*(1-fade) + hflat[mask]*fade
                quantized = np.rint((h - base) / HEIGHT_SCALE_M)
                if quantized.min() < 0 or quantized.max() > 65535:
                    raise ValueError(f'Altitude hors plage dans le bloc {ix} {iz}')
                manifest.append({'x': round(left, 4), 'z': round(top, 4), 'width': round(width, 4),
                                 'depth': round(depth, 4), 'nx': nx, 'nz': nz, 'spacing': step,
                                 'values': quantized.astype('<u2')})
                counts[step] += 1
            print('Rangée terrain', iz + 1, '/', rows, flush=True)
    # Les frontières fines adoptent l'interpolation de la frontière grossière :
    # les maillages et leurs collisions ne présentent ainsi aucune fissure LOD.
    for iz in range(rows):
        for ix in range(cols):
            a = manifest[iz * cols + ix]
            for nx, nz, axis in ((ix + 1, iz, 'x'), (ix, iz + 1, 'z')):
                if nx >= cols or nz >= rows:
                    continue
                b = manifest[nz * cols + nx]
                if a['spacing'] == b['spacing']:
                    continue
                if axis == 'x':
                    edge_a, edge_b = a['values'][:, -1], b['values'][:, 0]
                else:
                    edge_a, edge_b = a['values'][-1, :], b['values'][0, :]
                fine, coarse = (edge_a, edge_b) if len(edge_a) > len(edge_b) else (edge_b, edge_a)
                fine[:] = np.rint(np.interp(np.linspace(0, 1, len(fine)),
                                           np.linspace(0, 1, len(coarse)), coarse)).astype('<u2')
    offset = 0
    with (OUT / 'terrain_chunks.bin').open('wb') as output:
        for chunk in manifest:
            values = chunk.pop('values')
            encoded = values.tobytes()
            chunk['offset'] = offset
            chunk['bytes'] = len(encoded)
            output.write(encoded)
            offset += len(encoded)
    sources = [rasterio.open(p) for p in image_paths]
    try:
        # Merge limité à la taille de texture finale, évitant une mosaïque géante en mémoire.
        resolution = max((x1-x0)/IMAGE_MAX_SIZE, (z1-z0)/IMAGE_MAX_SIZE, 2)
        image, transform = merge(sources, bounds=(origin['E0']+x0, origin['N0']-z1,
                                                   origin['E0']+x1, origin['N0']-z0),
                                 res=resolution, resampling=Resampling.bilinear, indexes=[1, 2, 3])
    finally:
        for source in sources: source.close()
    img = Image.fromarray(np.moveaxis(image, 0, 2).astype(np.uint8))
    img.save(OUT / 'swissimage.webp', 'WEBP', quality=WEBP_QUALITY, method=4)
    header = {'chunkSize': CHUNK_M, 'file': 'terrain_chunks.bin', 'heightOffset': round(base, 4), 'heightScale': HEIGHT_SCALE_M,
              'origin': origin, 'bounds': [x0,z0,x1,z1], 'image': 'swissimage.webp', 'hillshade': 'hillshade.webp',
              'imageBounds': [float(transform.c-origin['E0']), float(origin['N0']-transform.f),
                              float(transform.c+image.shape[2]*transform.a-origin['E0']),
                              float(origin['N0']-(transform.f+image.shape[1]*transform.e))],
              'chunks': manifest}
    (OUT / 'terrain.json').write_text(json.dumps(header, separators=(',', ':'))+'\n')
    total = sum(p.stat().st_size for p in OUT.iterdir() if p.is_file())
    print('Blocs par pas', counts, 'image', img.size, 'octets image', (OUT / 'swissimage.webp').stat().st_size,
          'total fichiers traités', total, flush=True)
    if max(img.size) > IMAGE_MAX_SIZE or total > MAX_TOTAL_BYTES:
        raise ValueError('Limite de dimensions ou de taille dépassée')


if __name__ == '__main__':
    main()
