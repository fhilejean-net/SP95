import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GROUP_GROUND, GROUP_WORLD } from '../physics/vehicle.ts';
import type { EnvironmentMaterials } from '../render/materials.ts';
import { addGuardrailModel } from '../render/guardrailModel.ts';
import { buildMollendruzTrees } from './vegetation.ts';
import type { GuardrailPlacement, GuardrailRun } from './terrain.ts';
import type { ParkingPoint } from './colParking.ts';
import { parkingAccessGeometry, parkingPadGeometry } from './parkingSurface.ts';

const ROOT = `${import.meta.env.BASE_URL}data/mollendruz/`;
const GROUND_GROUP = (GROUP_GROUND << 16) | 0xffff;
const WORLD_GROUP = (GROUP_WORLD << 16) | 0xffff;
const TERRAIN_DRAW_DISTANCE = 440;
const TERRAIN_COLLISION_DISTANCE = 250;
const TERRAIN_HYSTERESIS = 64;
const ROAD_CELL = 32;
const ROAD_LIFT = 0.04;
const PARKING_LIFT = 0.04;
const ACCESS_LIFT = 0.05;
const ACCESS_WIDTH = 5.5;
const PARKING_SPAWN_X = -17;
const PARKING_SPAWN_Z = 6;
const RAIL_LOOKAHEAD_M = 15;
const RAIL_DROP_M = 3;
const RAIL_STEP = 4;
const RAIL_SEGMENT_M = 4.7;
const RAIL_MIN_RUN_M = 25;

export interface ColPoint { s: number; x: number; y: number; z: number; width: number; bank: number }
interface ColRoute { end_s: number; samples: ColPoint[]; origin: { E0: number; N0: number; H0: number } }
interface Chunk { x: number; z: number; width: number; depth: number; nx: number; nz: number; spacing: number; offset: number; bytes: number }
interface TerrainHeader { chunkSize: number; file: string; heightOffset: number; heightScale: number; bounds: number[]; image: string; imageBounds: number[]; chunks: Chunk[] }
interface Features { parking: ParkingPoint[]; parking_upper?: ParkingPoint[]; plaza?: ParkingPoint[]; road_northwest?: ParkingPoint[]; accesses?: { id: number; points: ParkingPoint[] }[]; buildings: { id: number; height: number; points: number[][] }[]; walls: { kind: string; points: number[][] }[]; trees: number[][] }
interface ColHit { s: number; y: number; distance: number; signed: number; width: number; bank: number }

export function triangleHeight(h00:number,h10:number,h01:number,h11:number,tx:number,tz:number): number {
  return tx+tz <= 1 ? h00 + tx*(h10-h00) + tz*(h01-h00)
    : h11 + (1-tx)*(h01-h11) + (1-tz)*(h10-h11);
}

/** PRNG déterministe : la forêt doit être identique à chaque chargement. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * OSM ne relève que les polygones boisés : tout le reste du versant est planté
 * ici, de part et d'autre de la chaussée, pour retrouver la forêt qui entoure
 * réellement le col. Tirage déterministe le long du tracé, ni sur la route, ni
 * sur le parking, ni dans une maison, ni sur une paroi trop raide.
 */
function forestAlong(
  samples: ColPoint[],
  ground: (x: number, z: number) => number,
  roadAt: (x: number, z: number) => ColHit | null,
  inParking: (x: number, z: number) => boolean,
  buildings: { points: number[][] }[],
): number[][] {
  const rand = mulberry32(0x5eed1e);
  const taken = new Set<string>();
  const trees: number[][] = [];
  // Emprise de chaque bâtiment, ramenée à un disque : un arbre ne pousse pas
  // dans un mur, et un test par sommet serait inutilement lourd.
  const roofs = buildings.map((b) => {
    const cx = b.points.reduce((sum, p) => sum + p[0], 0) / b.points.length;
    const cz = b.points.reduce((sum, p) => sum + p[1], 0) / b.points.length;
    let radius = 0;
    for (const [x, z] of b.points) radius = Math.max(radius, Math.hypot(x - cx, z - cz));
    return { cx, cz, radius };
  });
  const spacing = Math.max(0.5, (samples[1]?.s ?? 1) - (samples[0]?.s ?? 0));
  const step = Math.max(1, Math.round(9 / spacing));
  for (let i = 1; i + 1 < samples.length; i += step) {
    const a = samples[i], b = samples[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    if (len < 0.5) continue;
    const ex = dx / len, ez = dz / len, nx = -ez, nz = ex;
    for (const side of [-1, 1]) {
      const count = 1 + Math.floor(rand() * 2);
      for (let k = 0; k < count; k++) {
        // Serré en lisière, plus clairsemé au loin : une forêt, pas une haie.
        const lateral = a.width / 2 + 6 + Math.pow(rand(), 1.7) * 190;
        const along = (rand() - 0.5) * 10;
        const x = a.x + ex * along + nx * side * lateral;
        const z = a.z + ez * along + nz * side * lateral;
        const cell = `${Math.floor(x / 7)},${Math.floor(z / 7)}`;
        if (taken.has(cell)) continue;
        const y = ground(x, z);
        if (!(y > -900)) continue;
        const hit = roadAt(x, z);
        if (hit && hit.distance < hit.width / 2 + 5) continue;
        if (inParking(x, z) || inParking(x + 4, z) || inParking(x - 4, z)) continue;
        if (roofs.some((r) => Math.hypot(x - r.cx, z - r.cz) < r.radius + 4)) continue;
        // Un arbre sur une paroi verticale flotte : on exclut les pentes raides.
        const gx = ground(x + 3, z) - y, gz = ground(x, z + 3) - y;
        if (Math.hypot(gx, gz) / 3 > 1.05) continue;
        taken.add(cell);
        trees.push([x, z, 0.78 + rand() * 0.5]);
      }
    }
  }
  return trees;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(ROOT + path);
  if (!response.ok) throw new Error(`Mollendruz ${path} : HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function buildMollendruz(scene: THREE.Scene, world: RAPIER.World, mats: EnvironmentMaterials) {
  const [route, header, features] = await Promise.all([
    fetchJson<ColRoute>('centerline.json'), fetchJson<TerrainHeader>('terrain.json'), fetchJson<Features>('features.json'),
  ]);
  const binary = await fetch(ROOT + header.file);
  if (!binary.ok) throw new Error(`Mollendruz terrain : HTTP ${binary.status}`);
  const bytes = await binary.arrayBuffer();
  const texture = await new THREE.TextureLoader().loadAsync(ROOT + header.image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const terrainMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: 1 });
  // Le grain d'herbe existant se répète en coordonnées monde et s'efface au
  // loin. Près de la route, il redevient le motif dominant : la photo satellite
  // seule reste trop lisse sous les roues. Les zones abruptes gardent une
  // teinte de roche plus neutre.
  const detailTexture = mats.terrain.map;
  terrainMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.colDetail = { value: detailTexture };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 colWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\ncolWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 colWorld;\nuniform sampler2D colDetail;')
      .replace('#include <map_fragment>', '#include <map_fragment>\nfloat nearFade = 1.0 - smoothstep(18.0, 150.0, length(cameraPosition - colWorld));\nvec3 grassDetail = texture2D(colDetail, colWorld.xz / 5.0).rgb;\nfloat rock = smoothstep(0.25, 0.65, 1.0 - abs(normalize(cross(dFdx(colWorld), dFdy(colWorld))).y));\nvec3 grassPattern = clamp(grassDetail / 0.1, vec3(0.45), vec3(1.9));\ndiffuseColor.rgb *= mix(vec3(1.0), grassPattern, nearFade * mix(0.85, 0.3, rock));');
  };
  const chunkGrid = new Map<string, Chunk>();
  const chunks = header.chunks;
  const [x0, z0, x1, z1] = header.bounds;
  for (const c of chunks) chunkGrid.set(`${Math.round((c.x-x0)/header.chunkSize)},${Math.round((c.z-z0)/header.chunkSize)}`, c);
  const view = new DataView(bytes);
  const height = (c: Chunk, ix: number, iz: number) =>
    header.heightOffset + view.getUint16(c.offset + (iz*(c.nx+1)+ix)*2, true) * header.heightScale;
  const sample = (x: number, z: number): number => {
    if (x<x0 || x>x1 || z<z0 || z>z1) return -1000;
    const ix = Math.floor((Math.min(x,x1-0.0001)-x0)/header.chunkSize), iz = Math.floor((Math.min(z,z1-0.0001)-z0)/header.chunkSize);
    const c = chunkGrid.get(`${ix},${iz}`);
    if (!c) return -1000;
    const fx = Math.max(0, Math.min(c.nx-0.000001, (x-c.x)/c.width*c.nx));
    const fz = Math.max(0, Math.min(c.nz-0.000001, (z-c.z)/c.depth*c.nz));
    const a = Math.floor(fx), b = Math.floor(fz), tx = fx-a, tz = fz-b;
    const h00=height(c,a,b), h10=height(c,a+1,b), h01=height(c,a,b+1), h11=height(c,a+1,b+1);
    // Même diagonale que le collider : pas de divergence entre roues et sol.
    return triangleHeight(h00,h10,h01,h11,tx,tz);
  };
  // La Route de Fauchy ne commençait qu'à l'accès du parking, alors qu'elle
  // passe entre les deux parkings OSM (ways 256457163 et 513319895). On
  // prolonge le ruban vers le nord-ouest avec ses extrémités, posées sur le
  // terrain, pour que la route sépare bien les deux dalles.
  const northwest = features.road_northwest ?? [];
  if (northwest.length >= 2) {
    const chain: ParkingPoint[] = [...northwest, [0, 0]];
    const outward = [...chain].reverse();
    const width = route.samples[0]?.width ?? 6.5;
    const extension: ColPoint[] = [];
    let distance = 0;
    for (let i = 0; i < outward.length - 1; i++) {
      const [x0, z0] = outward[i];
      const [x1, z1] = outward[i + 1];
      const length = Math.hypot(x1 - x0, z1 - z0);
      const steps = Math.max(1, Math.ceil(length / 4));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        distance += length / steps;
        const y = sample(x, z);
        extension.push({ s: -distance, x, y: y > -900 ? y : 0, z, width, bank: 0 });
      }
    }
    extension.reverse();
    route.samples.unshift(...extension);
  }
  const roadGrid = new Map<string, number[]>();
  for (let i=0; i<route.samples.length-1; i++) {
    const a=route.samples[i], b=route.samples[i+1];
    const minX=Math.floor((Math.min(a.x,b.x)-8)/ROAD_CELL), maxX=Math.floor((Math.max(a.x,b.x)+8)/ROAD_CELL);
    const minZ=Math.floor((Math.min(a.z,b.z)-8)/ROAD_CELL), maxZ=Math.floor((Math.max(a.z,b.z)+8)/ROAD_CELL);
    for(let x=minX;x<=maxX;x++) for(let z=minZ;z<=maxZ;z++) {
      const key=`${x},${z}`; const bucket=roadGrid.get(key) ?? []; bucket.push(i); roadGrid.set(key,bucket);
    }
  }
  const roadAt = (x: number, z: number): ColHit | null => {
    const ids=roadGrid.get(`${Math.floor(x/ROAD_CELL)},${Math.floor(z/ROAD_CELL)}`);
    if (!ids) return null;
    let best: ColHit | null = null;
    for (const i of ids) {
      const a=route.samples[i], b=route.samples[i+1], dx=b.x-a.x, dz=b.z-a.z;
      const len2=dx*dx+dz*dz; if (len2 < 1e-9) continue;
      const t=Math.max(0,Math.min(1,((x-a.x)*dx+(z-a.z)*dz)/len2));
      const rx=x-a.x-t*dx, rz=z-a.z-t*dz, distance=Math.hypot(rx,rz);
      if (best && best.distance<=distance) continue;
      const signed=(rx*-dz+rz*dx)/Math.sqrt(len2);
      const bank=a.bank+(b.bank-a.bank)*t;
      best={ s:a.s+(b.s-a.s)*t, y:a.y+(b.y-a.y)*t+bank*signed+ROAD_LIFT,
        distance, signed, width:a.width+(b.width-a.width)*t, bank };
    }
    return best;
  };
  const parkingOutlines: ParkingPoint[][] = [features.parking];
  if (features.parking_upper) parkingOutlines.push(features.parking_upper);
  // Place en béton devant le vieil hôtel : même dalle conforme que les parkings.
  if (features.plaza) parkingOutlines.push(features.plaza);
  const insideParking = (outline: ParkingPoint[], x: number, z: number) => {
    let inside=false;
    for(let i=0,j=outline.length-1;i<outline.length;j=i++) {
      const [ax,az]=outline[i], [bx,bz]=outline[j];
      if ((az>z)!==(bz>z) && x < (bx-ax)*(z-az)/(bz-az)+ax) inside=!inside;
    }
    return inside;
  };
  const inParking = (x: number, z: number) =>
    parkingOutlines.some((outline) => insideParking(outline, x, z));
  // Les accès asphaltés viennent des ways OSM (parking_aisle). Le premier point
  // est sur l'axe de la route : on le rentre d'un mètre dans la chaussée, puis
  // on prolonge la bande dans la dalle pour que les deux bitumes se recouvrent.
  const accessLanes: { id: number; points: ParkingPoint[] }[] = [];
  for (const access of features.accesses ?? []) {
    const points = access.points.map(([x, z]) => [x, z] as ParkingPoint);
    if (points.length < 2) continue;
    // Les ways OSM ne sont pas tous dessinés dans le même sens : deux partent
    // du parking et finissent sur l'axe de la route. On met toujours la route
    // en tête pour découper le bon bout.
    const head = points[0], tail = points[points.length - 1];
    const headHit = roadAt(head[0], head[1]);
    const tailHit = roadAt(tail[0], tail[1]);
    const onRoad = (hit: ColHit | null) => hit !== null && hit.distance <= hit.width / 2 + 0.4;
    if (!onRoad(headHit) && onRoad(tailHit)) points.reverse();
    const [fx, fz] = points[0], [sx, sz] = points[1];
    const start = roadAt(fx, fz);
    const cut = Math.max(0, (start?.width ?? 6.5) / 2 - 0.8);
    const dx = sx - fx, dz = sz - fz, length = Math.hypot(dx, dz);
    if (length < 0.01) continue;
    points[0] = [fx + (dx / length) * cut, fz + (dz / length) * cut];
    const [ex, ez] = points[points.length - 1];
    const [px, pz] = points[points.length - 2];
    const lx = ex - px, lz = ez - pz, lastLength = Math.hypot(lx, lz);
    if (lastLength > 0.01) {
      points[points.length - 1] = [ex + (lx / lastLength) * 1.5, ez + (lz / lastLength) * 1.5];
    }
    accessLanes.push({ id: access.id, points });
  }
  const inAccess = (x: number, z: number) => accessLanes.some(({ points }) => {
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1], [bx, bz] = points[i];
      const dx = bx - ax, dz = bz - az, length2 = dx * dx + dz * dz;
      if (length2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2));
      if (Math.hypot(x - (ax + dx * t), z - (az + dz * t)) <= ACCESS_WIDTH / 2 + 0.1) return true;
    }
    return false;
  });
  const surface = (x: number, z: number) => {
    const hit=roadAt(x,z); return (hit && hit.distance <= hit.width/2) || inParking(x,z) || inAccess(x,z) ? 'asphalte' as const : 'herbe' as const;
  };
  const floor = (x: number, z: number) => {
    const hit=roadAt(x,z);
    if (hit && hit.distance <= hit.width/2) return hit.y;
    return sample(x,z)+(inParking(x,z)?PARKING_LIFT:inAccess(x,z)?ACCESS_LIFT:0);
  };

  const active = new Map<Chunk, { mesh: THREE.Mesh; body: RAPIER.RigidBody | null }>();
  function makeChunk(c: Chunk) {
    const positions=new Float32Array((c.nx+1)*(c.nz+1)*3);
    const uvs=new Float32Array((c.nx+1)*(c.nz+1)*2);
    const indices=new Uint32Array(c.nx*c.nz*6);
    const [imx,imz,imx1,imz1]=header.imageBounds;
    for(let z=0;z<=c.nz;z++) for(let x=0;x<=c.nx;x++) {
      const i=z*(c.nx+1)+x, px=c.x+x*c.width/c.nx, pz=c.z+z*c.depth/c.nz;
      positions[i*3]=px; positions[i*3+1]=height(c,x,z); positions[i*3+2]=pz;
      uvs[i*2]=(px-imx)/(imx1-imx); uvs[i*2+1]=1-(pz-imz)/(imz1-imz);
    }
    let k=0;
    for(let z=0;z<c.nz;z++) for(let x=0;x<c.nx;x++) {
      const a=z*(c.nx+1)+x, b=a+1, d=a+c.nx+1;
      indices[k++]=a; indices[k++]=d; indices[k++]=b; indices[k++]=b; indices[k++]=d; indices[k++]=d+1;
    }
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));
    geometry.setIndex(new THREE.BufferAttribute(indices,1)); geometry.computeVertexNormals();
    const mesh=new THREE.Mesh(geometry,terrainMaterial); mesh.name='mollendruz-terrain'; mesh.receiveShadow=true; scene.add(mesh);
    return {mesh,body:null as RAPIER.RigidBody | null};
  }
  const distanceToChunk = (x: number,z: number,c: Chunk) => Math.hypot(Math.max(c.x-x,0,x-c.x-c.width),Math.max(c.z-z,0,z-c.z-c.depth));
  function updateTerrain(x: number,z: number) {
    for (const c of chunks) {
      const distance=distanceToChunk(x,z,c);
      let current=active.get(c);
      if (distance<TERRAIN_DRAW_DISTANCE && !current) { current=makeChunk(c); active.set(c,current); }
      if (!current) continue;
      if (distance<TERRAIN_COLLISION_DISTANCE && !current.body) {
        const geo=current.mesh.geometry, pos=geo.getAttribute('position'), idx=geo.getIndex()!;
        current.body=world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(pos.array),new Uint32Array(idx.array))
          .setFriction(0.95).setCollisionGroups(GROUND_GROUP),current.body);
      } else if (distance>=TERRAIN_COLLISION_DISTANCE + TERRAIN_HYSTERESIS && current.body) {
        world.removeRigidBody(current.body); current.body=null;
      }
      if (distance>=TERRAIN_DRAW_DISTANCE + TERRAIN_HYSTERESIS) {
        scene.remove(current.mesh); current.mesh.geometry.dispose(); active.delete(c);
      }
    }
  }
  updateTerrain(0,0);

  const positions:number[]=[], uvs:number[]=[], indices:number[]=[];
  for (let i=0;i<route.samples.length;i++) {
    const p=route.samples[i], prev=route.samples[Math.max(0,i-1)], next=route.samples[Math.min(route.samples.length-1,i+1)];
    const dx=next.x-prev.x,dz=next.z-prev.z, len=Math.hypot(dx,dz)||1, nx=-dz/len,nz=dx/len;
    for(const side of [-1,1]) { const d=side*p.width/2; positions.push(p.x+nx*d,p.y+p.bank*d+ROAD_LIFT,p.z+nz*d); uvs.push(side<0?0:1,p.s/10); }
    if(i>0){const a=(i-1)*2; indices.push(a,a+1,a+2,a+1,a+3,a+2);}
  }
  const roadGeometry=new THREE.BufferGeometry(); roadGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  roadGeometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2)); roadGeometry.setIndex(indices); roadGeometry.computeVertexNormals();
  mats.asphalt.side = THREE.DoubleSide;
  const roadMesh=new THREE.Mesh(roadGeometry,mats.asphalt); roadMesh.name='mollendruz-road'; roadMesh.receiveShadow=true; scene.add(roadMesh);
  const roadBody=world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(positions),new Uint32Array(indices))
    .setFriction(0.98).setCollisionGroups(GROUND_GROUP),roadBody);
  const paintPos:number[]=[]; const paintIndex:number[]=[];
  function addMark(a:ColPoint,b:ColPoint,offset:number,width:number) {
    const dx=b.x-a.x,dz=b.z-a.z,len=Math.hypot(dx,dz)||1,nx=-dz/len,nz=dx/len, base=paintPos.length/3;
    for(const p of [a,b]) for(const d of [offset-width/2,offset+width/2])
      paintPos.push(p.x+nx*d,p.y+p.bank*d+ROAD_LIFT+0.015,p.z+nz*d);
    paintIndex.push(base,base+1,base+2,base+1,base+3,base+2);
  }
  for(let i=0;i<route.samples.length-1;i++) {
    const a=route.samples[i],b=route.samples[i+1];
    addMark(a,b,-a.width/2+0.25,0.12); addMark(a,b,a.width/2-0.25,0.12);
    if(Math.floor(a.s/6)%2===0) addMark(a,b,0,0.12);
  }
  const paintGeo=new THREE.BufferGeometry(); paintGeo.setAttribute('position',new THREE.Float32BufferAttribute(paintPos,3)); paintGeo.setIndex(paintIndex); paintGeo.computeVertexNormals();
  mats.lines.side = THREE.DoubleSide;
  const paint=new THREE.Mesh(paintGeo,mats.lines); paint.name='mollendruz-road-markings'; scene.add(paint);

  // Les deux dalles OSM du col, de part et d'autre de la Route de Fauchy.
  // Chaque dalle a son collider et sa propre sonde de hauteur : les traits
  // peints doivent suivre la surface réellement visible.
  const parkingLots: { outline: ParkingPoint[]; surface: (x: number, z: number) => number }[] = [];
  for (let index = 0; index < parkingOutlines.length; index++) {
    const outline = parkingOutlines[index];
    if (outline.length < 3) continue;
    const parkingGeo = parkingPadGeometry(outline, sample, { lift: PARKING_LIFT });
    const pp = parkingGeo.getAttribute('position');
    const parkingMesh = new THREE.Mesh(parkingGeo, mats.asphaltPad);
    parkingMesh.name = index === 0 ? 'mollendruz-parking' : index === 1 ? 'mollendruz-parking-upper' : 'mollendruz-plaza';
    scene.add(parkingMesh);
    const parkingIdx = parkingGeo.getIndex();
    if (parkingIdx) {
      world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(pp.array), new Uint32Array(parkingIdx.array))
        .setFriction(0.98).setCollisionGroups(GROUND_GROUP), roadBody);
    }
    // La dalle est découpée finement : ses sommets suivent le terrain et
    // l'herbe ne perce plus entre les grands triangles. Les traits du parking
    // doivent se poser sur cette surface, pas sur le terrain dessous.
    parkingMesh.updateMatrixWorld(true);
    const parkingRay = new THREE.Raycaster();
    const parkingOrigin = new THREE.Vector3();
    const parkingDown = new THREE.Vector3(0, -1, 0);
    const surfaceAt = (x: number, z: number): number => {
      parkingOrigin.set(x, 200, z);
      parkingRay.set(parkingOrigin, parkingDown);
      const hit = parkingRay.intersectObject(parkingMesh, false)[0];
      return hit ? hit.point.y : sample(x, z) + 0.04;
    };
    parkingLots.push({ outline, surface: surfaceAt });
  }
  for (const access of accessLanes) {
    const accessGeo = parkingAccessGeometry(access.points, sample, ACCESS_WIDTH, ACCESS_LIFT);
    const accessIndex = accessGeo.getIndex();
    if (!accessIndex) continue;
    const accessMesh = new THREE.Mesh(accessGeo, mats.asphaltPad);
    accessMesh.name = `mollendruz-access-${access.id}`;
    accessMesh.receiveShadow = true;
    scene.add(accessMesh);
    world.createCollider(RAPIER.ColliderDesc.trimesh(
      new Float32Array(accessGeo.getAttribute('position').array),
      new Uint32Array(accessIndex.array),
    ).setFriction(0.98).setCollisionGroups(GROUND_GROUP), roadBody);
  }
  const first = route.samples.find((p) => p.s >= 0) ?? route.samples[0];
  const next = route.samples[route.samples.indexOf(first) + 1] ?? first;

  const spawn={x:PARKING_SPAWN_X,z:PARKING_SPAWN_Z,
    heading:Math.atan2(-(first.x-PARKING_SPAWN_X),-(first.z-PARKING_SPAWN_Z))};
  if(!Number.isFinite(spawn.heading)) spawn.heading=Math.atan2(-(next.x-first.x),-(next.z-first.z));

  const buildingsGroup=new THREE.Group(); buildingsGroup.name='mollendruz-buildings'; scene.add(buildingsGroup);
  const houseMat=mats.house;
  for(const b of features.buildings) {
    if(b.points.length<4) continue;
    const shape=new THREE.Shape(); b.points.forEach(([x,z],i)=>i===0?shape.moveTo(x,-z):shape.lineTo(x,-z));
    const geo=new THREE.ExtrudeGeometry(shape,{depth:b.height,bevelEnabled:false});
    // Le plan de forme est (x,-z), la profondeur devient +y.
    geo.applyMatrix4(new THREE.Matrix4().set(1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1));
    const cx=b.points.reduce((s,p)=>s+p[0],0)/b.points.length, cz=b.points.reduce((s,p)=>s+p[1],0)/b.points.length;
    geo.translate(0,sample(cx,cz),0); const mesh=new THREE.Mesh(geo,houseMat); mesh.castShadow=true; mesh.receiveShadow=true; buildingsGroup.add(mesh);
    // Les bâtiments de forme concave doivent suivre leur empreinte : une boîte
    // englobante peut recouvrir la route alors que le bâtiment en est éloigné.
    for (let i=1;i<b.points.length;i++) {
      const [ax,az]=b.points[i-1], [bx,bz]=b.points[i], dx=bx-ax, dz=bz-az;
      const length=Math.hypot(dx,dz); if(length<0.1) continue;
      const angle=-Math.atan2(dz,dx);
      world.createCollider(RAPIER.ColliderDesc.cuboid(length/2,b.height/2,0.08)
        .setTranslation((ax+bx)/2,sample(cx,cz)+b.height/2,(az+bz)/2)
        .setRotation({x:0,y:Math.sin(angle/2),z:0,w:Math.cos(angle/2)}).setCollisionGroups(WORLD_GROUP),roadBody);
    }
  }
  const wallMat=new THREE.MeshStandardMaterial({color:0x77766f,roughness:1});
  for(const wall of features.walls) for(let i=1;i<wall.points.length;i++) {
    const [ax,az]=wall.points[i-1], [bx,bz]=wall.points[i]; const dx=bx-ax,dz=bz-az,len=Math.hypot(dx,dz);
    if(len<0.2) continue; const x=(ax+bx)/2,z=(az+bz)/2,y=sample(x,z)+0.6, angle=-Math.atan2(dz,dx);
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(len,1.2,0.2),wallMat); mesh.position.set(x,y,z); mesh.rotation.y=angle; scene.add(mesh);
    world.createCollider(RAPIER.ColliderDesc.cuboid(len/2,0.6,0.1).setTranslation(x,y,z)
      .setRotation({x:0,y:Math.sin(angle/2),z:0,w:Math.cos(angle/2)}).setCollisionGroups(WORLD_GROUP),roadBody);
  }
  // OSM ne cartographie ici aucune glissière : maintien prudent de l'ancien
  // garde-fou uniquement où le MNT descend fortement, emplacement estimé.
  const railPositions: number[] = [], railIndices: number[] = [], placements: GuardrailPlacement[] = [];
  const railSegments: {i:number; side:number}[] = [];
  for (let i=RAIL_STEP; i+RAIL_STEP<route.samples.length; i+=RAIL_STEP) {
    const a=route.samples[i], b=route.samples[i+RAIL_STEP];
    if (a.s < 45 || b.s > route.end_s - 20) continue;
    const dx=b.x-a.x, dz=b.z-a.z, len=Math.hypot(dx,dz); if (len < 0.5) continue;
    const nx=-dz/len, nz=dx/len, mx=(a.x+b.x)/2, mz=(a.z+b.z)/2;
    for (const side of [-1,1]) {
      if (sample(mx+nx*side*RAIL_LOOKAHEAD_M,mz+nz*side*RAIL_LOOKAHEAD_M) < (a.y+b.y)/2-RAIL_DROP_M)
        railSegments.push({i,side});
    }
  }
  const eligible = new Set<string>();
  for (const side of [-1,1]) {
    const indices=railSegments.filter(s=>s.side===side).map(s=>s.i);
    let run:number[]=[];
    const finish=()=>{
      if (run.length && route.samples[run[run.length-1]+RAIL_STEP].s-route.samples[run[0]].s>=RAIL_MIN_RUN_M)
        for (const i of run) eligible.add(`${i},${side}`);
      run=[];
    };
    for (const i of indices) { if (run.length && i!==run[run.length-1]+RAIL_STEP) finish(); run.push(i); }
    finish();
  }
  for (let i=RAIL_STEP; i+RAIL_STEP<route.samples.length; i+=RAIL_STEP) {
    const a=route.samples[i], b=route.samples[i+RAIL_STEP];
    if (a.s < 45 || b.s > route.end_s - 20) continue;
    const dx=b.x-a.x, dz=b.z-a.z, len=Math.hypot(dx,dz); if (len < 0.5) continue;
    const nx=-dz/len, nz=dx/len;
    for (const side of [-1,1]) {
      if (!eligible.has(`${i},${side}`)) continue;
      const distance=a.width/2+0.65, x0=a.x+nx*side*distance, z0=a.z+nz*side*distance;
      const x1=b.x+nx*side*distance, z1=b.z+nz*side*distance;
      // La glissière est boulonnée à l'accotement : on la pose au plus bas du
      // bord de chaussée et du terrain, sinon elle flotte au-dessus du ravin.
      const sy0=sample(x0,z0), sy1=sample(x1,z1);
      const ya=sy0>-900?Math.min(a.y+ROAD_LIFT,sy0):a.y+ROAD_LIFT;
      const yb=sy1>-900?Math.min(b.y+ROAD_LIFT,sy1):b.y+ROAD_LIFT;
      const base=railPositions.length/3;
      railPositions.push(x0,a.y+ROAD_LIFT,z0,x0,a.y+1+ROAD_LIFT,z0,x1,b.y+ROAD_LIFT,z1,x1,b.y+1+ROAD_LIFT,z1);
      railIndices.push(base,base+1,base+2,base+2,base+1,base+3);
      const pieces=Math.max(1,Math.round(len/RAIL_SEGMENT_M));
      for(let part=0;part<pieces;part++) {
        const t=(part+0.5)/pieces;
        placements.push({x:x0+(x1-x0)*t,y:ya+(yb-ya)*t,z:z0+(z1-z0)*t,
          yaw:Math.atan2(-dz,dx)+(side<0?Math.PI:0),pitch:Math.atan2(b.y-a.y,len),stretch:len/pieces/RAIL_SEGMENT_M});
      }
    }
  }
  let guardrail: GuardrailRun | null = null;
  if (railIndices.length) {
    const geometry=new THREE.BufferGeometry(); geometry.setAttribute('position',new THREE.Float32BufferAttribute(railPositions,3));
    geometry.setIndex(railIndices); geometry.computeVertexNormals();
    const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:0xa8adb2,metalness:0.6,roughness:0.45,side:THREE.DoubleSide}));
    mesh.name='guardrails-estimated'; scene.add(mesh);
    const collider=world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(railPositions),new Uint32Array(railIndices))
      .setFriction(0.32).setRestitution(0.02).setCollisionGroups(WORLD_GROUP),roadBody);
    guardrail={placements,fallback:[mesh],segment:RAIL_SEGMENT_M,collider};
  }
  if (guardrail) {
    // Le modèle fourni remplace le ruban ; celui-ci ne reste que pour la
    // collision et comme repli si le GLB manque.
    await addGuardrailModel(scene, guardrail).catch((error) =>
      console.warn('Modèle de glissière indisponible, ruban de secours.', error),
    );
  }
  const treeLocations = [...features.trees, ...forestAlong(route.samples, sample, roadAt, (x, z) => inParking(x, z) || inAccess(x, z), features.buildings)];
  let treeCount = 0;
  try {
    treeCount = await buildMollendruzTrees(scene, treeLocations, sample);
  } catch (error) {
    console.warn('Modèle d’arbres indisponible, cônes de secours.', error);
    const treeGeo=new THREE.ConeGeometry(2.2,9,7), treeMat=new THREE.MeshStandardMaterial({color:0x283c2c,roughness:1});
    const trees=new THREE.InstancedMesh(treeGeo,treeMat,treeLocations.length), matrix=new THREE.Matrix4(), p=new THREE.Vector3(), q=new THREE.Quaternion(), scale=new THREE.Vector3();
    treeLocations.forEach(([x,z,s],i)=>{p.set(x,sample(x,z)+4.5*s,z);scale.set(s,s,s);trees.setMatrixAt(i,matrix.compose(p,q,scale));});
    trees.instanceMatrix.needsUpdate=true; trees.name='mollendruz-trees'; scene.add(trees);
    treeCount = treeLocations.length;
  }
  const last=route.samples[route.samples.length-1], penultimate=route.samples[route.samples.length-2];
  const endAngle=Math.atan2(-(last.x-penultimate.x),-(last.z-penultimate.z));
  world.createCollider(RAPIER.ColliderDesc.cuboid(last.width/2+2,2,0.3).setTranslation(last.x,last.y+2,last.z)
    .setRotation({x:0,y:Math.sin(endAngle/2),z:0,w:Math.cos(endAngle/2)}).setCollisionGroups(WORLD_GROUP),roadBody);
  return {route, bounds: header.bounds, sample, roadAt, parking: features.parking, parkingLots, accessCount: accessLanes.length, floor, surface, updateTerrain, spawn, guardrail, treeCount, buildingCount:features.buildings.length, wallCount:features.walls.length};
}
