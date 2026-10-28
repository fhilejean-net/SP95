/**
 * Audit du circuit de Suzuka : plaques horizontales suspectes (le bloc sous le
 * pont), et discontinuités de la cote lue par les roues (marches en bord de
 * piste, trous de la trame de collision).
 *
 *   node scripts/tmp-track-audit.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(300_000);
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`));
page.on('console', (message) => {
  const text = message.text();
  if (/Circuit|Piste|Matières|Terrain/.test(text)) console.log(`log: ${text}`);
});

await page.goto('http://127.0.0.1:3000/?map=suzuka&fx=low', { waitUntil: 'load' });
await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 300_000 });
await page.evaluate(() => window.__sp95.startFree());
await page.waitForTimeout(1200);

const audit = await page.evaluate(() => {
  const THREE = window.__sp95three.THREE;
  const c = window.__sp95Circuit;
  const inList = (list, m) => list.includes(m);
  const cls = (m) => {
    const tags = [];
    if (inList(c.asphaltMeshes, m)) tags.push('asphalt');
    if (inList(c.groundMeshes, m)) tags.push('ground');
    if (inList(c.looseMeshes, m)) tags.push('loose');
    if (inList(c.overlayMeshes, m)) tags.push('overlay');
    return tags.join('+') || 'structure';
  };
  const rows = [];
  c.root.traverse((object) => {
    if (!object.isMesh) return;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    rows.push({
      name: object.name,
      material: material?.name ?? '',
      map: material?.map ? `${material.map.image?.width}x${material.map.image?.height}` : 'none',
      color: material?.color ? material.color.getHexString() : '',
      kind: cls(object),
      visible: object.visible,
      verts: object.geometry.attributes.position.count,
      size: [+size.x.toFixed(1), +size.y.toFixed(1), +size.z.toFixed(1)],
      center: [+center.x.toFixed(1), +center.y.toFixed(1), +center.z.toFixed(1)],
    });
  });

  // Plaques horizontales larges qui ne sont pas de l'asphalte : c'est là que se
  // cache le bloc du pont, et les dalles noires posées sur la piste.
  const plates = rows
    .filter((row) => row.visible && row.kind !== 'asphalt')
    .filter((row) => row.size[1] <= Math.max(row.size[0], row.size[2]) * 0.35)
    .filter((row) => Math.max(row.size[0], row.size[2]) >= 4)
    .sort((a, b) => b.size[0] * b.size[2] - a.size[0] * a.size[2])
    .slice(0, 25);

  // Sondes de la cote lue par les roues : on marche sur une grille de 0,4 m et
  // on mesure la marche entre deux échantillons voisins, sur la piste.
  const flat = c.flatRoad;
  const verts = flat.vertices;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    minX = Math.min(minX, verts[i]);
    maxX = Math.max(maxX, verts[i]);
    minZ = Math.min(minZ, verts[i + 2]);
    maxZ = Math.max(maxZ, verts[i + 2]);
  }
  const step = 0.4;
  const jumps = [];
  let samples = 0;
  let nulls = 0;
  for (let z = minZ; z <= maxZ; z += step * 8) {
    for (let x = minX; x <= maxX; x += step) {
      const a = c.floorAt(x, z);
      const b = c.floorAt(x + step, z);
      const d = c.floorAt(x, z + step);
      samples++;
      if (a === null) nulls++;
      if (a !== null && b !== null) {
        const jump = Math.abs(b - a);
        if (jump > 0.12) jumps.push({ x: +x.toFixed(1), z: +z.toFixed(1), jump: +jump.toFixed(2), dir: 'x' });
      }
      if (a !== null && d !== null) {
        const jump = Math.abs(d - a);
        if (jump > 0.12) jumps.push({ x: +x.toFixed(1), z: +z.toFixed(1), jump: +jump.toFixed(2), dir: 'z' });
      }
    }
  }
  jumps.sort((p, q) => q.jump - p.jump);

  return {
    counts: {
      meshes: rows.length,
      asphalt: c.asphaltMeshes.length,
      ground: c.groundMeshes.length,
      overlay: c.overlayMeshes.length,
      flatTriangles: flat.triangles,
      maxGrade: +flat.maxGrade.toFixed(1),
    },
    plates,
    anchors: jumps.slice(0, 18),
    jumpCount: jumps.length,
    samples,
    nulls,
    spans: { minX, maxX, minZ, maxZ },
    spawn: c.spawn,
  };
});

console.log('COMPTES', JSON.stringify(audit.counts));
console.log('SONDES', audit.samples, 'échantillons,', audit.nulls, 'sans cote,', audit.jumpCount, 'marches > 0,12 m');
console.log('PLAQUES HORIZONTALES');
for (const row of audit.plates) {
  console.log(
    `  ${String(row.size[0] * row.size[2]).padStart(7)} m² · ${row.kind.padEnd(10)} · ` +
      `${row.material.padEnd(16)} map=${String(row.map).padEnd(9)} couleur=#${row.color} · ` +
      `taille ${row.size.join('x')} · centre (${row.center.join(', ')}) · ${row.verts} sommets`,
  );
}
console.log('MARCHES DE COTE');
for (const anchor of audit.anchors) {
  console.log(`  ${anchor.jump} m en ${anchor.dir} à (${anchor.x}, ${anchor.z})`);
}
console.log('EMPRISE', JSON.stringify(audit.spans));
console.log('DEPART', JSON.stringify(audit.spawn));

// Vues : dessus du circuit, puis rasante sur la ligne droite des stands.
const shots = [
  {
    path: 'artifacts/audit-overhead.png',
    camera: [audit.spawn.x, audit.spawn.y + 300, audit.spawn.z + 200, audit.spawn.x, audit.spawn.y, audit.spawn.z - 200],
  },
  {
    path: 'artifacts/audit-spawn.png',
    camera: [audit.spawn.x - 6, audit.spawn.y + 12, audit.spawn.z + 26, audit.spawn.x, audit.spawn.y, audit.spawn.z - 40],
  },
];
for (const shot of shots) {
  await page.evaluate((point) => window.__sp95.setCamera(...point), shot.camera);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot.path, timeout: 240_000 });
  console.log(`capture ${shot.path}`);
}

await browser.close();
