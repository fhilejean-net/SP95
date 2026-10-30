#!/usr/bin/env node
/**
 * Ré-exporte les voitures importées depuis les GLB d'origine, sans perte.
 *
 * Le pipeline volontairement doux :
 *   - `dedupe` et `prune` : uniquement des doublons et du vide ;
 *   - `textureCompress` en WebP q92 à la résolution d'origine (aucun redimensionnement) ;
 *
 * Ce qu'on ne fait **pas**, et c'est le point : ni `simplify` (qui retire des
 * triangles), ni `join` (qui fusionne les maillages et détruit les nœuds de
 * roues), ni `flatten`. Les noms de nœuds et de matériaux sont donc conservés :
 * c'est eux qui permettent au jeu de trouver les roues.
 *
 *   node scripts/prep-models.mjs                 # tous les modèles listés
 *   node scripts/prep-models.mjs supra kart      # une sélection
 */
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';

/** Modèle de sortie → fichier d'origine. */
const MODELS = {
  supra_opt: '1994_toyota_supra_mk_iv_bomex_fast__furious.glb',
  rx7_veilside_opt: '1997_veilside_fortune_mazda_rx-7_fd_tokyo_drift.glb',
  skyline_r34_opt: 'public/models/vehicles/1999_nissan_skyline_gtr_r34_c-west__2f2f.glb',
  crz_opt: 'public/models/vehicles/2012_honda_cr-z_zf2.glb',
  go_kart_opt: 'public/models/vehicles/go_kart.glb',
  f1_mclaren_mcl35m_opt: 'public/models/vehicles/f1_2021_mclaren_mcl35m.glb',
};

/** WebP q92 : visuellement sans perte sur ces textures, moitié du poids d'un PNG. */
const WEBP_QUALITY = 92;

const only = process.argv.slice(2);
const selection = Object.entries(MODELS).filter(([id]) => only.length === 0 || only.includes(id));

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

for (const [id, source] of selection) {
  if (!fs.existsSync(source)) {
    console.error(`✗ ${id}: source absente (${source})`);
    process.exitCode = 1;
    continue;
  }
  const out = path.join('public/models/vehicles', `${id}.glb`);
  const before = (await fs.promises.stat(source)).size;
  const document = await io.read(source);

  // La référence est prise **après** dedup/prune : ces deux passes retirent les
  // primitives orphelines (aucun nœud ne les affiche), ce n'est pas une perte.
  await document.transform(dedup(), prune());
  const trianglesBefore = countTriangles(document);
  await document.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', quality: WEBP_QUALITY }),
  );
  const trianglesAfter = countTriangles(document);
  await io.write(out, document);

  const after = (await fs.promises.stat(out)).size;
  const change = trianglesAfter === trianglesBefore ? 'géométrie intacte' : `⚠ ${trianglesBefore} → ${trianglesAfter} triangles`;
  console.log(
    `${id}: ${(before / 1e6).toFixed(2)} Mo → ${(after / 1e6).toFixed(2)} Mo · ${change}`,
  );
  if (trianglesAfter !== trianglesBefore) process.exitCode = 1;
}

/** Compte les triangles réellement écrits, primitives comprises. */
function countTriangles(document) {
  let total = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const position = primitive.getAttribute('POSITION');
      total += Math.round((indices ? indices.getCount() : position ? position.getCount() : 0) / 3);
    }
  }
  return total;
}
