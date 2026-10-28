/**
 * Panneaux de freinage 150/100/50 m : le plan se vérifie sans WebGL. Ces tests
 * tiennent les trois promesses qui comptent — chaque entrée de virage reçoit
 * les annonces que sa ligne droite permet, les panneaux sont dans le
 * dégagement (jamais sur l'asphalte ni dans le mur), et leur face regarde la
 * voiture qui arrive.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRAKING_DISTANCES,
  CORNER_RADIUS,
  MARKER_LATERAL,
  MARKER_MARGIN,
  MIN_STRAIGHT,
  WALL_CLEARANCE,
  brakingMarkers,
  cornerEntries,
  sampleAtDistance,
} from '../src/world/brakingMarkers.ts';
import { KERB_WIDTH, TRACK, WALL_OFFSET, cornerRadius } from '../src/world/trackLayout.ts';

test('chaque entrée de virage reçoit les annonces que sa ligne droite permet', () => {
  const entries = cornerEntries();
  assert.ok(entries.length >= 4, `${entries.length} entrées de virage`);
  const markers = brakingMarkers(entries);
  const total = TRACK.length;
  for (const entry of entries) {
    assert.ok(entry.straight >= MIN_STRAIGHT, `ligne droite de ${entry.straight.toFixed(0)} m`);
    const expected = BRAKING_DISTANCES.filter((value) => value + MARKER_MARGIN <= entry.straight);
    assert.ok(expected.length > 0, `aucune annonce pour l’entrée ${entry.distance.toFixed(0)}`);
    for (const value of expected) {
      const placed = markers.filter(
        (marker) =>
          marker.value === value &&
          marker.cornerDistance === entry.distance &&
          Math.abs(
            (((marker.cornerDistance - marker.distance + total) % total) + total) % total - value,
          ) < 1e-6,
      );
      assert.equal(
        placed.length,
        2,
        `${value} m : ${placed.length} panneaux pour l’entrée ${entry.distance.toFixed(0)}`,
      );
    }
    // L'annonce tombe sur de la ligne droite, jamais dans le virage précédent.
    const approach = sampleAtDistance(entry.distance - expected[0]);
    assert.ok(
      cornerRadius(approach) > CORNER_RADIUS,
      `annonce à ${expected[0]} m de l’entrée ${entry.distance.toFixed(0)} : rayon ${cornerRadius(approach).toFixed(0)} m`,
    );
  }
  // La longue ligne droite de départ porte les trois annonces, dans l'ordre.
  const longest = entries.reduce((best, entry) => (entry.straight > best.straight ? entry : best));
  const values = new Set(
    markers.filter((marker) => marker.cornerDistance === longest.distance).map((marker) => marker.value),
  );
  assert.deepEqual([...values].sort((a, b) => b - a), [...BRAKING_DISTANCES]);
});

test('les panneaux sont dans le dégagement, de part et d’autre de la piste', () => {
  const markers = brakingMarkers();
  assert.ok(markers.length >= 8, `${markers.length} panneaux`);
  const sides = new Set<number>();
  for (const marker of markers) {
    sides.add(marker.side);
    // Après le vibreur, donc jamais sur l'asphalte…
    assert.ok(
      Math.abs(marker.lateral) >= TRACK.halfWidth + KERB_WIDTH,
      `panneau à ${marker.lateral.toFixed(2)} m de l’axe`,
    );
    // … et devant la face intérieure du mur, qu'il ne traverse pas.
    assert.ok(
      Math.abs(marker.lateral) <= WALL_OFFSET - WALL_CLEARANCE,
      `panneau à ${Math.abs(marker.lateral).toFixed(2)} m, mur à ${WALL_OFFSET.toFixed(2)} m`,
    );
    assert.ok(Math.abs(Math.abs(marker.lateral) - MARKER_LATERAL) < 1e-6);
    // La position calculée est bien le long de l'axe, à l'écart latéral voulu.
    const axis = sampleAtDistance(marker.distance);
    const dx = marker.x - axis.x;
    const dz = marker.z - axis.z;
    assert.ok(Math.abs(dx * axis.tx + dz * axis.tz) < 1e-6, 'panneau décalé le long de l’axe');
    assert.ok(Math.abs(Math.hypot(dx, dz) - MARKER_LATERAL) < 1e-6);
  }
  assert.deepEqual([...sides].sort(), [-1, 1], 'un seul côté de la piste est équipé');
});

test('les faces regardent la voiture qui arrive', () => {
  for (const marker of brakingMarkers()) {
    const axis = sampleAtDistance(marker.distance);
    // 1 quand la face est exactement à l'opposé de la tangente.
    const facing = -(marker.fx * axis.tx + marker.fz * axis.tz);
    assert.ok(facing > 0.98, `face à ${facing.toFixed(3)} du sens d’arrivée`);
    assert.ok(Math.abs(Math.hypot(marker.fx, marker.fz) - 1) < 1e-6);
  }
});

test('le plan est vide plutôt que faux', () => {
  assert.deepEqual(brakingMarkers([]), []);
  // Aucune entrée retenue ne peut être annoncée depuis un virage déjà commencé.
  for (const entry of cornerEntries()) {
    assert.ok(entry.straight >= MIN_STRAIGHT);
  }
});
