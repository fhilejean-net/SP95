#!/usr/bin/env node
/**
 * Vérifie, hors navigateur, que chaque voiture importée donne une caisse saine
 * et quatre roues plausibles.
 *
 * Le rendu demande WebGL ; la partie qui décide du résultat, elle, est pure :
 * `pickWheels` lit des boîtes de pièces. On lui donne donc les boîtes réelles
 * des GLB exportés — en découpant au triangle les maillages qui contiennent
 * plusieurs roues, exactement comme le fait le loader — puis on contrôle le
 * verdict : quatre moyeux, dans les coins, avec un rayon de pneu crédible.
 *
 *   node --experimental-strip-types scripts/verify-models.mjs
 */
import { inspect, readPrimitive } from './inspect-glb.mjs';
import { clusterWheels, pickWheels } from '../src/render/wheels.ts';
import { CARS } from '../src/game/cars.ts';

// Bornes de vraisemblance, un peu plus larges que le seuil du loader : un pneu
// fait 6 à 9 % de la longueur d'une voiture.
const WHEEL_RADIUS_MIN_RATIO = 0.045;
const WHEEL_RADIUS_MAX_RATIO = 0.24;
const NAMED_WHEEL = /wheel|tyre|tire|tread|roue|jante|\brims?\b|rim|moyeu|hub/i;
const FIXED_WHEEL = /caliper|calliper|étrier|etrier|wheelhouse|well|fender|suspension|arche|arch/i;

let failures = 0;

/** Boîte des triangles d'une primitive, répartis par quadrant. */
function quadrantBoxes(file, entry, centre) {
  const { positions, indices } = readPrimitive(file, entry);
  const boxes = [0, 1, 2, 3].map(() => ({
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    triangles: 0,
  }));
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const x = (positions[a] + positions[b] + positions[c]) / 3;
    const z = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    const corner = (x >= centre[0] ? 1 : 0) + (z >= centre[2] ? 2 : 0);
    const box = boxes[corner];
    box.triangles++;
    for (const vertex of [a, b, c]) {
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[vertex + axis];
        if (value < box.min[axis]) box.min[axis] = value;
        if (value > box.max[axis]) box.max[axis] = value;
      }
    }
  }
  return boxes.filter((box) => box.triangles > 0);
}

for (const car of CARS) {
  const file = `public/${car.model}`;
  let report;
  try {
    report = inspect(file);
  } catch (error) {
    console.log(`✗ ${car.id}: illisible (${error?.message ?? error})`);
    failures++;
    continue;
  }

  const box = report.totalBox;
  const size = [0, 1, 2].map((axis) => box.max[axis] - box.min[axis]);
  const length = Math.max(size[0], size[2]);
  const centre = [0, 1, 2].map((axis) => (box.min[axis] + box.max[axis]) / 2);

  // Une caisse saine tient dans une boîte : pas de sommet à des kilomètres.
  const finite = [0, 1, 2].every((axis) => Number.isFinite(box.min[axis]) && Number.isFinite(box.max[axis]));
  const proportions = length > 0 && size[1] > length * 0.15 && size[1] < length * 1.2;
  if (!finite || !proportions) {
    console.log(`✗ ${car.id}: boîte invraisemblable ${size.map((v) => v.toFixed(2)).join('×')}`);
    failures++;
    continue;
  }

  const candidates = [];
  for (const entry of report.meshEntries) {
    const label = `${entry.nodeName} ${entry.material}`;
    const crossesX = entry.min[0] < centre[0] - size[0] * 0.05 && entry.max[0] > centre[0] + size[0] * 0.05;
    const crossesZ = entry.min[2] < centre[2] - size[2] * 0.05 && entry.max[2] > centre[2] + size[2] * 0.05;
    const wheelMesh = NAMED_WHEEL.test(label) && !FIXED_WHEEL.test(label);
    if (wheelMesh && (crossesX || crossesZ)) {
      // Maillage qui traverse la voiture : ses roues se lisent au triangle.
      for (const quadrant of quadrantBoxes(file, entry, centre)) {
        candidates.push({ name: label, box: { min: quadrant.min, max: quadrant.max } });
      }
      continue;
    }
    candidates.push({ name: label, box: { min: entry.min, max: entry.max } });
  }

  const bodyBox = {
    min: [box.min[0], box.min[1], box.min[2]],
    max: [box.max[0], box.max[1], box.max[2]],
  };
  let picks = pickWheels(candidates, bodyBox);

  if (!picks) {
    // Même repli que le loader : regrouper les sommets bas des pièces qui
    // contiennent plusieurs roues (jantes F1 livrées en un maillage).
    const parts = [];
    for (const entry of report.meshEntries) {
      const label = `${entry.nodeName} ${entry.material}`;
      if (!NAMED_WHEEL.test(label) || FIXED_WHEEL.test(label)) continue;
      const span = Math.max(
        entry.max[0] - entry.min[0],
        entry.max[2] - entry.min[2],
      );
      if (span <= length * 0.15) continue;
      parts.push(readPrimitive(file, entry));
    }
    picks = parts.length > 0 ? clusterWheels(parts, bodyBox) : null;
  }

  if (!picks) {
    // Le kart n'a aucun moyeu mesurable : il reçoit des roues procédurales.
    const fallbackOk = car.id === 'kart';
    console.log(
      `${fallbackOk ? '~' : '✗'} ${car.id}: roues non mesurables → ${fallbackOk ? 'roues procédurales (attendu)' : 'REPLI INATTENDU'}`,
    );
    if (!fallbackOk) failures++;
    continue;
  }

  const halfTrack = picks.reduce((sum, pick) => sum + Math.abs(pick.hub[0]), 0) / 4;
  const radius = picks[0].radius;
  const symmetric = picks.every((pick) => Math.abs(Math.abs(pick.hub[0]) - halfTrack) < halfTrack * 0.35);
  const radiusOk = radius > length * WHEEL_RADIUS_MIN_RATIO && radius < length * WHEEL_RADIUS_MAX_RATIO;
  const corners = new Set(picks.map((pick) => pick.corner)).size === 4;
  const base =
    (Math.abs(picks[0].hub[2] - picks[2].hub[2]) + Math.abs(picks[1].hub[2] - picks[3].hub[2])) / 2;
  const baseOk = base > length * 0.15;

  const ok = symmetric && radiusOk && corners && baseOk;
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} ${car.id.padEnd(13)} ${picks.length} roues · rayon ${(radius / length).toFixed(3)} de la longueur · empattement ${(base / length).toFixed(2)}${ok ? '' : ` · sym ${symmetric} ray ${radiusOk} coins ${corners} base ${baseOk}`}`,
  );
}

console.log(failures === 0 ? '\nToutes les voitures sont saines.' : `\n${failures} problème(s).`);
process.exitCode = failures === 0 ? 0 : 1;
