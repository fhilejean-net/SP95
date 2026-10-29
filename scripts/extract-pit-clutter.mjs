/**
 * Le pack de circuit fourni (`public/models/tracks/lowpoly_racetrack.glb`,
 * 8,3 Mo, 300 nœuds) contient des piles de pneus, des cônes, des barils et des
 * barrières. On n'a pas besoin du tracé : ce script détache les neuf familles
 * utiles, cuit leur transformation monde (les groupes Sketchfab sont inclinés),
 * puis écrit un GLB autonome et allégé pour l'atelier.
 *
 *   node scripts/extract-pit-clutter.mjs
 */
import { NodeIO } from '@gltf-transform/core';
import { dedup, prune } from '@gltf-transform/functions';

const SOURCE = 'public/models/tracks/lowpoly_racetrack.glb';
const TARGET = 'public/models/pit/clutter.glb';
const FAMILIES = [
  'pneuWall',
  '3pneu',
  '1Bpneu',
  '1Wpneu',
  'cone',
  'barrelY',
  'barrelRed',
  'barriersSmall',
  'startLights',
];

const io = new NodeIO();
const doc = await io.read(SOURCE);
const root = doc.getRoot();
const source = root.listScenes()[0];
const found = new Map();

const walk = (node) => {
  const base = node.getName().replace(/\.\d+.*$/, '');
  if (FAMILIES.includes(base) && !found.has(base)) found.set(base, node);
  for (const child of node.listChildren()) walk(child);
};
for (const child of source.listChildren()) walk(child);
console.log(
  `familles trouvées : ${FAMILIES.filter((name) => found.has(name)).join(', ')}` +
    ` (${found.size}/${FAMILIES.length})`,
);

// Les nœuds utiles vivent sous trois groupes Sketchfab qui portent la rotation
// Z-up : on cuit la matrice monde avant de les détacher, sinon tout arrive
// couché.
const kept = [];
for (const [base, node] of found) {
  node.setMatrix(node.getWorldMatrix());
  node.detach();
  node.setName(base);
  kept.push(node);
}
for (const scene of root.listScenes()) scene.dispose();
const out = doc.createScene('pit-clutter');
for (const node of kept) out.addChild(node);
root.setDefaultScene(out);

await doc.transform(prune(), dedup());
await io.write(TARGET, doc);
console.log(`écrit ${TARGET}`);
