#!/usr/bin/env node
/**
 * Rapport compact par modèle : triangles, textures, et nœuds qui ressemblent à
 * une roue avec leur boîte monde. Sert à décider, modèle par modèle, si les
 * roues sont de vraies pièces nommées ou s'il faut un repli.
 *
 *   node scripts/model-report.mjs <fichier.glb> [...]
 */
import { inspect } from './inspect-glb.mjs';

const WHEEL = /wheel|tyre|tire|roue|jante|\brim|hub|wh[._-]?\d|_wh\b|3dwheel/i;
const FIXED = /caliper|calliper|étrier|etrier|wheelhouse|well|fender|arch|arche/i;

for (const file of process.argv.slice(2)) {
  const report = inspect(file);
  const triangles = report.meshEntries.reduce((sum, entry) => sum + entry.triangles, 0);
  const texturePixels = report.textures.map((texture) => texture.width * texture.height);
  const maxTexture = report.textures.reduce(
    (best, texture) => (texture.width > best ? texture.width : best),
    0,
  );
  const box = report.totalBox;
  const size = [0, 1, 2].map((axis) => box.max[axis] - box.min[axis]);

  const wheels = report.meshEntries.filter((entry) => {
    const label = `${entry.nodeName} ${entry.meshName} ${entry.material}`;
    return WHEEL.test(label) && !FIXED.test(label);
  });

  console.log(`\n=== ${file}`);
  console.log(
    `  ${(report.bytes / 1e6).toFixed(2)} Mo · ${triangles} triangles · ${report.textures.length} textures (max ${maxTexture} px) · ${report.meshes.length} maillages`,
  );
  console.log(`  boîte ${size.map((value) => value.toFixed(2)).join(' × ')} · anims ${report.animations} · skins ${report.skins}`);
  console.log(`  nœuds « roue » : ${wheels.length}`);
  const grouped = new Map();
  for (const entry of wheels) {
    // Le nœud le plus proche porteur d'un nom de roue décrit le coin.
    const name = (entry.nodeName || entry.meshName || '?').replace(/^.*?([^|]*)$/, '$1');
    grouped.set(name, entry);
  }
  for (const [name, entry] of grouped) {
    const centre = [0, 1, 2].map((axis) => ((entry.min[axis] + entry.max[axis]) / 2).toFixed(2));
    const dims = [0, 1, 2].map((axis) => (entry.max[axis] - entry.min[axis]).toFixed(2));
    console.log(`    ${name.slice(0, 70)} · ${entry.triangles} tri · dims ${dims.join('×')} · centre ${centre.join(',')}`);
  }
  if (wheels.length === 0) console.log('    (aucun nœud nommé : détection par forme ou repli)');
}
