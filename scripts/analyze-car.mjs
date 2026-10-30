#!/usr/bin/env node
/**
 * Radiographie d'un GLB de voiture : doublons de maillages, moyeux trouvés
 * géométriquement, orientation de la caisse.
 *
 *   node --experimental-strip-types scripts/analyze-car.mjs public/models/vehicles/go_kart_opt.glb
 */
import { inspect, readPrimitive } from './inspect-glb.mjs';
import { clusterWheels, contactHubs } from '../src/render/wheels.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: analyze-car.mjs <fichier.glb>');
  process.exit(1);
}

const report = inspect(file);
const box = report.totalBox;
const size = [0, 1, 2].map((axis) => box.max[axis] - box.min[axis]);
const length = Math.max(size[0], size[2]);
console.log(
  `\n${file}\nboîte ${size.map((v) => v.toFixed(2)).join(' × ')} · ` +
    `longueur ${length.toFixed(2)} · hauteur/longueur ${(size[1] / length).toFixed(3)} · ` +
    `largeur/longueur ${(Math.min(size[0], size[2]) / length).toFixed(3)}`,
);

const parts = [];
for (const entry of report.meshEntries) {
  const { positions, indices } = readPrimitive(file, entry);
  const centroids = new Set();
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const x = Math.round((positions[a] + positions[b] + positions[c]) / 3);
    const y = Math.round((positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3);
    const z = Math.round((positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3);
    centroids.add(`${x},${y},${z}`);
  }
  parts.push({ entry, positions, indices, centroids });
}

// Doublons : deux maillages qui partagent la plupart de leurs triangles.
for (let i = 0; i < parts.length; i++) {
  for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i];
    const b = parts[j];
    let shared = 0;
    for (const key of a.centroids) if (b.centroids.has(key)) shared++;
    const ratio = shared / Math.min(a.centroids.size, b.centroids.size);
    if (ratio > 0.5) {
      console.log(
        `  DOUBLON ${(ratio * 100).toFixed(0)} % : ` +
          `${a.entry.nodeName} ↔ ${b.entry.nodeName}`,
      );
    }
  }
}

const clusters = clusterWheels(
  parts.map((part) => ({ positions: part.positions, indices: part.indices })),
  box,
);
if (!clusters) {
  console.log('  moyeux géométriques : aucun (les sommets bas ne forment pas 4 roues)');
} else {
  console.log(`  moyeux géométriques (${clusters.length}) :`);
  for (const pick of clusters) {
    console.log(
      `    coin ${pick.corner} · centre ${pick.hub.map((v) => v.toFixed(1)).join(', ')}` +
        ` · rayon ${pick.radius.toFixed(1)} (${(pick.radius / length).toFixed(3)} de la longueur)`,
    );
  }
  const radius = clusters[0].radius / length;
  console.log(`    rayon / longueur ${radius.toFixed(3)} ${radius > 0.05 && radius < 0.24 ? 'plausible' : 'SUSPECT'}`);
}

const wheelParts = parts.map((part) => ({ positions: part.positions, indices: part.indices }));
const contact = contactHubs(wheelParts, box);
console.log(
  '  contactHubs : ' +
    (contact
      ? contact
          .map(
            (pick) =>
              `coin ${pick.corner} (${pick.hub.map((v) => v.toFixed(1)).join(', ')}) ` +
              `r${pick.radius.toFixed(1)} largeur ${(pick.halfWidth ?? 0).toFixed(1)}`,
          )
          .join(' | ')
      : 'aucun'),
);

// Plan des sommets bas : les roues sont les masses qui touchent le sol.
// #plan-view
const lowLimit = box.min[1] + size[1] * 0.3;
const cols = 34;
const rows = 16;
const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
let counted = 0;
for (const part of parts) {
  const step = Math.max(3, Math.floor(part.positions.length / 20000) * 3);
  for (let i = 0; i < part.positions.length; i += step) {
    const y = part.positions[i + 1];
    if (y > lowLimit) continue;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(((part.positions[i] - box.min[0]) / size[0]) * cols)));
    const cz = Math.min(rows - 1, Math.max(0, Math.floor(((part.positions[i + 2] - box.min[2]) / size[2]) * rows)));
    grid[cz][cx]++;
    counted++;
  }
}
const peak = Math.max(1, ...grid.flat());
const ramp = ' .:-=+*#%@';
console.log(`  plan des sommets bas (y < ${lowLimit.toFixed(1)}, ${counted} points) :`);
for (const row of grid) {
  console.log(
    '   |' +
      row.map((value) => (value === 0 ? ' ' : ramp[Math.min(9, Math.ceil((value / peak) * 9))])).join('') +
      '|',
  );
}

// Répartition des sommets par hauteur : une caisse n'a rien sous le plancher,
// des roues si.
const ys = [];
for (const part of parts) {
  const step = Math.max(3, Math.floor(part.positions.length / 6000) * 3);
  for (let i = 1; i < part.positions.length; i += step) ys.push(part.positions[i]);
}
ys.sort((a, b) => a - b);
const quantile = (q) => ys[Math.min(ys.length - 1, Math.floor(q * ys.length))];
console.log(
  `  hauteurs : min ${ys[0].toFixed(1)} · q25 ${quantile(0.25).toFixed(1)} · ` +
    `médiane ${quantile(0.5).toFixed(1)} · q75 ${quantile(0.75).toFixed(1)} · max ${ys[ys.length - 1].toFixed(1)}`,
);
