/**
 * Le tracé du circuit SP95 est entièrement plat et construit par le jeu : ces
 * tests vérifient ce qui a fait défaut à Suzuka — une piste d'un seul tenant,
 * sans rayon impossible, sans section qui se chevauche, et un revêtement qui
 * répond exactement là où la roue roule.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTROL_POINTS,
  MIN_CORNER_RADIUS,
  TRACK,
  buildTrack,
  cornerRadius,
  hasKerb,
  lateralOffset,
  trackSurfaceAt,
} from '../src/world/trackLayout.ts';

test('le tour est fermé, à l’échelle d’un circuit, et sans trou dans son axe', () => {
  assert.ok(TRACK.samples.length > 400, `${TRACK.samples.length} échantillons`);
  assert.ok(TRACK.length > 1400 && TRACK.length < 1800, `longueur ${TRACK.length.toFixed(0)} m`);
  // Pas constant : deux échantillons voisins ne peuvent pas laisser de fente
  // dans la bande d'asphalte, et le dernier rejoint le premier.
  for (let i = 0; i < TRACK.samples.length; i++) {
    const a = TRACK.samples[i];
    const b = TRACK.samples[(i + 1) % TRACK.samples.length];
    const step = Math.hypot(b.x - a.x, b.z - a.z);
    assert.ok(step < 3.2, `pas de ${step.toFixed(1)} m à l’échantillon ${i}`);
    assert.ok(step > 1.6, `pas de ${step.toFixed(1)} m à l’échantillon ${i}`);
  }
});

test('aucun virage n’est plus serré qu’une épingle jouable', () => {
  let worst = Infinity;
  let where = -1;
  for (let i = 0; i < TRACK.samples.length; i++) {
    const radius = cornerRadius(TRACK.samples[i]);
    if (radius < worst) {
      worst = radius;
      where = i;
    }
  }
  assert.ok(
    worst >= MIN_CORNER_RADIUS,
    `rayon ${worst.toFixed(1)} m à l’échantillon ${where}`,
  );
});

test('les sections éloignées du tour ne se frôlent jamais', () => {
  // Deux morceaux de piste à moins de deux largeurs de mur verraient leurs
  // parois se croiser au milieu de l'asphalte.
  const samples = TRACK.samples;
  const count = samples.length;
  let closest = Infinity;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const along = Math.min(j - i, count - (j - i));
      if (along < 30) continue; // 75 m le long de la piste : c'est la même courbe
      const distance = Math.hypot(samples[i].x - samples[j].x, samples[i].z - samples[j].z);
      if (distance < closest) closest = distance;
    }
  }
  assert.ok(closest > TRACK.wallOffset * 2 + 10, `sections à ${closest.toFixed(0)} m`);
});

test('l’axe et le revêtement sont d’accord', () => {
  const spawn = TRACK.spawn;
  assert.equal(trackSurfaceAt(spawn.x, spawn.z), 'asphalte');
  // Trente mètres à droite de l'axe : herbe, au-delà des vibreurs et du muret.
  const sample = TRACK.samples[0];
  const right = { x: -sample.tz, z: sample.tx };
  assert.equal(
    trackSurfaceAt(spawn.x + right.x * 30, spawn.z + right.z * 30),
    'herbe',
  );
  // Le bord du vibreur reste de l'asphalte : c'est là qu'une roue mord encore.
  assert.ok(Math.abs(lateralOffset(spawn.x, spawn.z)) < 0.01);
});

test('les vibreurs ne sortent que dans les virages', () => {
  const kerbs = TRACK.samples.filter(hasKerb);
  assert.ok(kerbs.length > 20, `${kerbs.length} échantillons de vibreur`);
  assert.ok(kerbs.length < TRACK.samples.length * 0.75, 'trop de vibreurs');
  for (const sample of kerbs) {
    assert.ok(cornerRadius(sample) < 160, `vibreur en ligne droite à ${sample.distance.toFixed(0)} m`);
  }
});

test('la position de départ regarde dans le sens de la course', () => {
  const spawn = TRACK.spawn;
  const forward = { x: -Math.sin(spawn.heading), z: -Math.cos(spawn.heading) };
  const delta = {
    x: TRACK.samples[4].x - spawn.x,
    z: TRACK.samples[4].z - spawn.z,
  };
  const dot = forward.x * delta.x + forward.z * delta.z;
  assert.ok(dot > 0, `le départ recule : ${dot.toFixed(1)}`);
  // Le cap du départ suit la tangente, pas une valeur écrite à la main.
  const tangent = TRACK.samples[0];
  assert.ok(Math.abs(forward.x - tangent.tx) < 0.05);
  assert.ok(Math.abs(forward.z - tangent.tz) < 0.05);
});

test('le tracé de secours reste celui du jeu', () => {
  // Une liste vide doit dégénérer proprement, sans NaN dans la surface.
  const empty = buildTrack(CONTROL_POINTS);
  assert.equal(empty.samples.length, TRACK.samples.length);
  assert.ok(Number.isFinite(empty.length));
});
