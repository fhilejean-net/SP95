#!/usr/bin/env node
/**
 * Audit d'un GLB sans dépendance : lit le chunk JSON, calcule la boîte monde de
 * chaque maillage, et sort la hiérarchie, les matériaux et les textures.
 *
 *   node scripts/inspect-glb.mjs <fichier.glb> [--tree] [--meshes] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

function parseGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: pas un GLB`);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    offset += 8 + length + ((4 - (length % 4)) % 4);
  }
  return { json, bin, bytes: buf.length };
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessorBounds(json, index) {
  const accessor = json.accessors?.[index];
  if (!accessor) return null;
  if (accessor.min && accessor.max) return { min: accessor.min, max: accessor.max };
  return null;
}

function composeMatrix(node) {
  // Colonne-major, comme glTF.
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function transformPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function imageSize(buffer, mime) {
  try {
    if (mime === 'image/png' && buffer.length > 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < buffer.length) {
        if (buffer[i] !== 0xff) { i++; continue; }
        const marker = buffer[i + 1];
        const length = buffer.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        }
        i += 2 + length;
      }
    }
    if (mime === 'image/webp' && buffer.length > 30) {
      const chunk = buffer.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        const w = 1 + buffer.readUIntLE(24, 3);
        const h = 1 + buffer.readUIntLE(27, 3);
        return { width: w, height: h };
      }
      if (chunk === 'VP8 ') {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    /* image illisible : on le dit par des zéros */
  }
  return { width: 0, height: 0 };
}

function imageBytes(json, bin, image) {
  if (image.bufferView === undefined) return null;
  const view = json.bufferViews[image.bufferView];
  if (!bin || view.byteLength === undefined) return null;
  return bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}

const ACCESSOR_COMPONENTS = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

function readComponent(view, offset, componentType) {
  switch (componentType) {
    case 5120:
      return view.getInt8(offset);
    case 5121:
      return view.getUint8(offset);
    case 5122:
      return view.getInt16(offset, true);
    case 5123:
      return view.getUint16(offset, true);
    case 5125:
      return view.getUint32(offset, true);
    case 5126:
      return view.getFloat32(offset, true);
    default:
      throw new Error(`composante inconnue ${componentType}`);
  }
}

/**
 * Lit les positions d'une primitive en repère monde.
 *
 * Sert aux vérifications qui doivent raisonner au triangle près — le
 * découpage des roues d'un maillage qui contient les quatre, par exemple.
 * Les composantes normalisées sont divisées comme le fait le GPU.
 */
export function readPrimitive(file, entry) {
  const { json, bin } = parseGlb(file);
  const primitive = json.meshes[entry.meshIndex].primitives[entry.primitive];
  const accessor = json.accessors[primitive.attributes.POSITION];
  const view = json.bufferViews[accessor.bufferView];
  // L'accesseur peut être décalé dans sa vue : ignorer ce décalage lit des
  // indices hors bornes (des sommets `undefined`, donc des NaN partout).
  const accessorOffset = accessor.byteOffset ?? 0;
  const offset = (view.byteOffset ?? 0) + accessorOffset;
  const bytes = ACCESSOR_COMPONENTS[accessor.componentType] * 3;
  const stride = view.byteStride ?? bytes;
  const data = new DataView(bin.buffer, bin.byteOffset + offset, view.byteLength - accessorOffset);
  const divisor = accessor.normalized
    ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295, 5126: 1 }[accessor.componentType]
    : 1;
  const matrix = entry.world;
  const positions = new Float32Array(accessor.count * 3);
  for (let i = 0; i < accessor.count; i++) {
    const at = i * stride;
    const x = readComponent(data, at, accessor.componentType) / divisor;
    const y = readComponent(data, at + (bytes / 3), accessor.componentType) / divisor;
    const z = readComponent(data, at + (bytes / 3) * 2, accessor.componentType) / divisor;
    positions[i * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    positions[i * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    positions[i * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  }

  let indices;
  if (primitive.indices !== undefined) {
    const indexAccessor = json.accessors[primitive.indices];
    const indexView = json.bufferViews[indexAccessor.bufferView];
    const indexData = new DataView(
      bin.buffer,
      bin.byteOffset + (indexView.byteOffset ?? 0) + (indexAccessor.byteOffset ?? 0),
      indexView.byteLength - (indexAccessor.byteOffset ?? 0),
    );
    const size = ACCESSOR_COMPONENTS[indexAccessor.componentType];
    indices = new Uint32Array(indexAccessor.count);
    for (let i = 0; i < indexAccessor.count; i++) {
      indices[i] = readComponent(indexData, i * size, indexAccessor.componentType);
    }
  } else {
    indices = new Uint32Array(accessor.count);
    for (let i = 0; i < accessor.count; i++) indices[i] = i;
  }
  return { positions, indices };
}

export function inspect(file) {
  const { json, bin, bytes } = parseGlb(file);
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const materials = json.materials ?? [];
  const images = json.images ?? [];
  const textures = json.textures ?? [];

  // Parcours des nœuds racines avec transformées monde.
  const worldOf = new Map();
  const roots = [];
  const childSet = new Set();
  for (const node of nodes) for (const child of node.children ?? []) childSet.add(child);
  nodes.forEach((_, index) => { if (!childSet.has(index)) roots.push(index); });

  const walk = (index, parent) => {
    const node = nodes[index];
    const world = multiply(parent, composeMatrix(node));
    worldOf.set(index, world);
    for (const child of node.children ?? []) walk(child, world);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of roots) walk(root, identity);

  const meshEntries = [];
  nodes.forEach((node, nodeIndex) => {
    if (node.mesh === undefined) return;
    const world = worldOf.get(nodeIndex) ?? identity;
    const mesh = meshes[node.mesh];
    for (const [primitiveIndex, primitive] of (mesh.primitives ?? []).entries()) {
      const bounds = accessorBounds(json, primitive.attributes?.POSITION);
      if (!bounds) continue;
      const corners = [];
      for (let i = 0; i < 8; i++) {
        corners.push(transformPoint(world, [
          i & 1 ? bounds.max[0] : bounds.min[0],
          i & 2 ? bounds.max[1] : bounds.min[1],
          i & 4 ? bounds.max[2] : bounds.min[2],
        ]));
      }
      const min = [0, 1, 2].map((axis) => Math.min(...corners.map((c) => c[axis])));
      const max = [0, 1, 2].map((axis) => Math.max(...corners.map((c) => c[axis])));
      const position = json.accessors?.[primitive.attributes?.POSITION];
      const indexAccessor = primitive.indices !== undefined ? json.accessors?.[primitive.indices] : null;
      meshEntries.push({
        node: nodeIndex,
        meshIndex: node.mesh,
        world,
        nodeName: node.name ?? '',
        meshName: mesh.name ?? '',
        primitive: primitiveIndex,
        material: primitive.material !== undefined ? materials[primitive.material]?.name ?? `#${primitive.material}` : '(none)',
        triangles: indexAccessor ? Math.round(indexAccessor.count / 3) : Math.round((position?.count ?? 0) / 3),
        vertices: position?.count ?? 0,
        min,
        max,
      });
    }
  });

  const totalBox = {
    min: [0, 1, 2].map((axis) => Math.min(...meshEntries.map((m) => m.min[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...meshEntries.map((m) => m.max[axis]))),
  };

  const textureInfo = textures.map((texture, index) => {
    const image = images[texture.source];
    if (!image) return { index, name: `#${index}`, mime: '?', width: 0, height: 0, bytes: 0 };
    const buffer = imageBytes(json, bin, image);
    const size = buffer ? imageSize(buffer, image.mimeType) : { width: 0, height: 0 };
    return {
      index,
      name: image.name ?? `#${index}`,
      mime: image.mimeType ?? '?',
      width: size.width,
      height: size.height,
      bytes: buffer?.length ?? 0,
    };
  });

  return {
    file,
    bytes,
    generator: json.asset?.generator ?? '?',
    extensionsUsed: json.extensionsUsed ?? [],
    extensionsRequired: json.extensionsRequired ?? [],
    nodes,
    roots,
    meshes,
    materials,
    textures: textureInfo,
    meshEntries,
    totalBox,
    animations: json.animations?.length ?? 0,
    skins: json.skins?.length ?? 0,
  };
}

/** Les nœuds qui ont des enfants, en arbre lisible. */
function treeLines(report) {
  const lines = [];
  const walk = (index, depth) => {
    const node = report.nodes[index];
    const label = node.name || `(node ${index})`;
    const mesh = node.mesh !== undefined ? ` [mesh ${node.mesh}: ${report.meshes[node.mesh]?.name ?? ''}]` : '';
    lines.push(`${'  '.repeat(depth)}${label}${mesh}`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  for (const root of report.roots) walk(root, 0);
  return lines;
}

// Le module est aussi importé par `model-report.mjs` : la partie CLI ne doit
// tourner que lorsque le fichier est appelé directement.
const isCli = process.argv[1]?.endsWith('inspect-glb.mjs');
const args = isCli ? process.argv.slice(2) : [];
const files = args.filter((arg) => !arg.startsWith('--'));
const showTree = args.includes('--tree');
const showMeshes = args.includes('--meshes') || !showTree;
const asJson = args.includes('--json');

for (const file of files) {
  const report = inspect(file);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    continue;
  }
  const box = report.totalBox;
  const size = [0, 1, 2].map((axis) => (box.max[axis] - box.min[axis]).toFixed(2));
  console.log(`\n=== ${path.basename(file)} — ${(report.bytes / 1e6).toFixed(2)} Mo`);
  console.log(`generator: ${report.generator}`);
  console.log(`extensions: ${report.extensionsUsed.join(', ') || '(aucune)'}`);
  console.log(`nœuds: ${report.nodes.length} · maillages: ${report.meshes.length} · matériaux: ${report.materials.length} · textures: ${report.textures.length} · skins: ${report.skins}`);
  console.log(`boîte monde: x ${box.min[0].toFixed(2)}..${box.max[0].toFixed(2)} · y ${box.min[1].toFixed(2)}..${box.max[1].toFixed(2)} · z ${box.min[2].toFixed(2)}..${box.max[2].toFixed(2)}  (${size.join(' × ')})`);
  if (showTree) {
    console.log('--- hiérarchie ---');
    for (const line of treeLines(report)) console.log(line);
  }
  if (showMeshes) {
    console.log('--- maillages (triangles, boîte monde) ---');
    for (const entry of report.meshEntries) {
      const dims = [0, 1, 2].map((axis) => (entry.max[axis] - entry.min[axis]).toFixed(2));
      console.log(
        `${entry.nodeName || '?'} · ${entry.meshName || '?'} #${entry.primitive} · mat ${entry.material} · ${entry.triangles} tri · ${dims.join('×')} · y ${entry.min[1].toFixed(2)}..${entry.max[1].toFixed(2)}`,
      );
    }
  }
  console.log('--- textures ---');
  for (const texture of report.textures) {
    console.log(`${texture.name} · ${texture.mime} · ${texture.width}×${texture.height} · ${(texture.bytes / 1e6).toFixed(2)} Mo`);
  }
}
