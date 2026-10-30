import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import RAPIER from '@dimforge/rapier3d-compat';
import './styles.css';
import { GROUP_WORLD, Vehicle, type VehicleInput, type VehicleSpec } from './physics/vehicle.ts';
import { Bike } from './physics/bike.ts';
import { SUPERMOTARD } from './game/bikes.ts';
import {
  bikePresetLabel,
  loadBikeSetup,
  resolveBikeSpec,
  saveBikeSetup,
  type BikeSetup,
} from './game/bikeTuning.ts';
import {
  CIRCUIT,
  COL_START,
  MOUNTAIN_MAP,
  MOUNTAIN_ROADS,
  RACE_START,
  RALLY_START,
  SPAWN,
  SUMMIT_START,
  buildRaceCheckpoints,
  setTrackSurface,
  surfaceAt,
  isWetRoad,
  setWetRoad,
  sprayActive,
} from './world/layout.ts';
import {
  buildArenaPads,
  buildGradedRoads,
  buildGuardrails,
  buildRaceGates,
  buildRoads,
  buildTerrain,
  roadEnds,
} from './world/terrain.ts';
import { NEIGHBOURHOODS, buildCity, syncProps } from './world/city.ts';
import { buildCircuit, circuitFloor, type CircuitHandles } from './world/circuit.ts';
import { buildFlatCircuit } from './world/flatCircuit.ts';
import { TRACK, trackDistanceAt, trackSurfaceAt } from './world/trackLayout.ts';
import { insidePit } from './world/pitLayout.ts';
import { insideDriftPad } from './world/driftPad.ts';
import { MAPS, MAP_ID, mapUrl, type MapId } from './game/maps.ts';
import { BUILDINGS } from './world/buildings.ts';
import { buildStreetKit, type StreetKitSummary } from './world/streetkit.ts';
import { buildPuddles, type PuddleField } from './world/puddles.ts';
import { buildVegetation, type VegetationSummary } from './world/vegetation.ts';
import { createEnvironmentMaterials } from './render/materials.ts';
import { createSky, NIGHT_PRESET, pickSkyPreset } from './render/sky.ts';
import { createCar, updateCarVisual, type CarVisual } from './render/car.ts';
import { createBike, type BikeVisual } from './render/bike.ts';
import { loadBikeVisual } from './render/bikeModel.ts';
import { loadDeerModel } from './render/deerModel.ts';
import { spawnDeerRagdoll, type DeerRagdoll } from './render/deerRagdoll.ts';
import { deerWithinCarFootprint, speedAfterDeerImpact } from './game/deerImpact.ts';
import { createSparks } from './render/sparks.ts';
import { createTireSmoke } from './render/tireSmoke.ts';
import { loadCarVisual } from './render/carModel.ts';
import { buildPitProps } from './render/pitProps.ts';
import { CARS, findCar, loadCarId, saveCarId, type CarDef, type CarId } from './game/cars.ts';
import { QualityGovernor } from './render/quality.ts';
import { ChaseCamera, cameraModeLabel } from './core/camera.ts';

/** Les vues du replay, dans l'ordre où `C` les fait défiler. */
type ReplayView = 'chase' | 'tv' | 'onboard' | 'trackside';
const REPLAY_VIEWS: ReplayView[] = ['chase', 'tv', 'onboard', 'trackside'];

function replayViewLabel(view: ReplayView): string {
  switch (view) {
    case 'tv':
      return 'Caméra TV';
    case 'onboard':
      return 'Embarquée';
    case 'trackside':
      return 'Bord de piste';
    default:
      return 'Replay · poursuite libre';
  }
}
import { InputManager } from './core/input.ts';
import { Hud, type GameMode } from './game/hud.ts';
import { DriftScore } from './game/drift.ts';
import { ReplayBuffer, samplePoses, type ReplayPose, type VisualPose } from './game/replay.ts';
import { StuntScore } from './game/stunt.ts';
import { BAVETTE_ANGLE } from './physics/wheelie.ts';
import { Race } from './game/race.ts';
import { CarAudio } from './game/audio.ts';
import { AudioPanel } from './game/audioPanel.ts';
import {
  SOUND_CHANNELS,
  loadVehicleMixes,
  mixForVehicle,
  rememberMix,
  saveVehicleMixes,
} from './game/audioMix.ts';
import { Garage } from './game/garage.ts';
import { Showroom } from './game/showroom.ts';
import { Chrono, formatLap } from './game/chrono.ts';
import { SectorTimer } from './game/sectors.ts';
import { PRESETS, loadSetup, resolveSpec, saveSetup, type Setup } from './game/tuning.ts';

const FIXED = 1 / 120;

/** Asphalte sec / mouillé : le mouillé fonce la chaussée (touche G). */
const DRY_ASPHALT_COLOR = 0x8f9096;
const WET_ASPHALT_COLOR = 0x6b7178;
const DRY_PAD_COLOR = 0x808086;
const WET_PAD_COLOR = 0x63696f;
/** La ligne du chrono, posée devant la sortie des stands : on démarre avant. */
const CHRONO_LINE_OFFSET = 8;

type FreeSpawn = 'city' | 'col' | 'rally' | 'summit' | 'circuit';

/** La carte de la session : la ville, ou le circuit seul sur la sienne. */
const MAP = MAP_ID;
/**
 * Premier écran : l'URL ne demande aucune carte. On n'en construit alors
 * aucune — ni la ville, ni Suzuka, ni la piste — et chaque bouton du menu part
 * vers la carte choisie. Charger le monde avant le premier clic coûtait
 * plusieurs secondes pour un écran qu'on quitte aussitôt.
 */
const MENU_ONLY = !new URLSearchParams(window.location.search).has('map');
const SUZUKA_MAP = MAP === 'suzuka';
/** La piste dessinée par le jeu : plate de bout en bout, sans dalle importée. */
const FLAT_MAP = MAP === 'sp95';
/** Les deux cartes de circuit : pas de ville, pas de course à la ceinture. */
const TRACK_MAP = SUZUKA_MAP || FLAT_MAP;
const TRACK_LABEL = SUZUKA_MAP ? 'Circuit · Suzuka' : FLAT_MAP ? 'Circuit · SP95' : undefined;

/**
 * Cadence visée, en images par seconde. Le jeu rendait à la fréquence de
 * l'écran — 165 images par seconde pour la même image sur un écran 165 Hz — et
 * faisait chauffer les machines. À 60 la conduite ne change pas ; `?fps=120`
 * (ou `?fps=0`, qui rend la main à l'écran) choisit autre chose.
 */
const FRAME_TARGET = readFrameTarget();
/** `?collide` affiche le maillage de collision dès le chargement (F9 le bascule). */
const COLLIDE_VIEW = new URLSearchParams(window.location.search).has('collide');

const canvas = document.getElementById('game') as HTMLCanvasElement;
const loading = document.getElementById('loading') as HTMLDivElement;
const loadingText = document.getElementById('loading-text') as HTMLParagraphElement;
const loadingFill = document.getElementById('loading-fill') as HTMLSpanElement;
const menu = document.getElementById('menu') as HTMLDivElement;
const pause = document.getElementById('pause') as HTMLDivElement;
const hudElement = document.getElementById('hud') as HTMLDivElement;
const menuBest = document.getElementById('menu-best') as HTMLParagraphElement;

function setLoading(progress: number, text: string): Promise<void> {
  loadingFill.style.width = `${Math.round(progress * 100)}%`;
  loadingText.textContent = text;
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function makeRenderer(lowFx: boolean): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
  // Past one device pixel per CSS pixel there is nothing left to see, but a lot
  // of pixels left to shade: on a HiDPI screen 1.25 costs 56 % more fragments
  // than 1.0 for a difference you cannot spot in motion. It is the first thing
  // that makes a weak GPU drop the frame.
  renderer.setPixelRatio(lowFx ? 0.7 : Math.min(window.devicePixelRatio, 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = !lowFx;
  // three a retiré PCFSoftShadowMap en r186 : PCFShadowMap est le seul filtre
  // disponible, et le choisir explicitement évite l'avertissement par défaut.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Debug telemetry should count every pass of the frame.
  renderer.info.autoReset = false;
  return renderer;
}

function forwardFromHeading(heading: number): THREE.Vector3 {
  return new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
}

/** Cadence demandée dans l'URL : 60 par défaut, 0 pour suivre l'écran. */
function readFrameTarget(): number {
  const raw = new URLSearchParams(window.location.search).get('fps');
  if (raw === null) return 60;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(240, value) : 0;
}

function readBestLap(): number | null {
  try {
    const raw = localStorage.getItem('sp95.bestLap');
    if (!raw) return null;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function refreshMenuBest(): void {
  // Sur une carte de circuit il n'y a pas de course à la ceinture : le meilleur
  // tour affiché serait celui d'une autre carte.
  if (TRACK_MAP) {
    menuBest.textContent = `${MAPS[MAP].name} — ${MAPS[MAP].blurb}`;
    return;
  }
  const best = readBestLap();
  menuBest.textContent =
    best === null ? 'Aucun temps enregistré — lance une course pour établir la référence.'
      : `Meilleur tour : ${Race.formatTime(best)}`;
}

async function boot() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const fxParam = new URLSearchParams(window.location.search).get('fx');
  const lowFx = fxParam === 'low';
  // `?fx=full` verrouille la qualité : le gouverneur ne baisse plus la
  // résolution ni les ombres, quelle que soit la cadence mesurée. Sert aux
  // machines qui tiennent la charge et aux captures de contrôle.
  const lockedFx = fxParam === 'full';
  if (coarse) document.body.classList.add('touch');
  hudElement.classList.add('hidden');
  menu.classList.add('hidden');
  pause.classList.add('hidden');

  await setLoading(0.08, 'Initialisation du moteur…');
  await RAPIER.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.2, 2600);
  const renderer = makeRenderer(lowFx);
  const chase = new ChaseCamera(camera);
  // La vue capot est la vue par défaut du col, C permet toujours de la changer.
  if (MOUNTAIN_MAP) chase.mode = 'hood';

  await setLoading(0.18, 'Ciel et éclairage…');
  // La lumière du jour est tirée une fois par chargement (ou forcée par
  // `?light=`), et son exposition vient avec : c'est elle qui cramait les
  // carrosseries claires et le sol sous le plein soleil.
  const sky = createSky(scene, renderer, MOUNTAIN_MAP ? NIGHT_PRESET : pickSkyPreset());
  renderer.toneMappingExposure = sky.preset.exposure;
  console.log(`Lumière : ${sky.preset.label} (exposition ${sky.preset.exposure})`);

  // Accueil sans carte : le ciel suffit derrière le menu, et rien de lourd
  // n'est construit tant que le joueur n'a pas choisi sa destination.
  if (MENU_ONLY) {
    camera.position.set(0, 9, 34);
    camera.lookAt(0, 5, 0);
    renderer.render(scene, camera);
    menuBest.textContent = 'Choisis une destination — la carte ne se charge qu’au clic.';
    await setLoading(1, 'Prêt');
    await new Promise((resolve) => setTimeout(resolve, 120));
    loading.classList.add('done');
    window.setTimeout(() => loading.classList.add('hidden'), 500);
    menu.classList.remove('hidden');
    wireMenuOnly();
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.render(scene, camera);
    });
    return;
  }

  // DIAGNOSTIC CYCLE 10 (temporaire) : compte les dessins réellement émis
  // pendant la passe d'ombre — on reconnaît la passe à sa target.
  let shadowPassDraws = 0;
  const baseRenderBufferDirect = renderer.renderBufferDirect.bind(renderer);
  renderer.renderBufferDirect = (cam, scn, geo, mat, obj, grp) => {
    const map = sky.sun.shadow.map;
    if (map && renderer.getRenderTarget() === map) shadowPassDraws++;
    baseRenderBufferDirect(cam, scn, geo, mat, obj, grp);
  };
  const materials = createEnvironmentMaterials();

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED;

  // Le circuit doit être posé avant le terrain : sa dalle définit le sol de son
  // emprise, et la grille de terrain se cale dessus. Il n'existe que sur sa
  // propre carte : la ville ne l'a plus du tout.
  let circuit: CircuitHandles | null = null;
  /** Chrono de la piste : seulement là où il y a une piste. */
  let chrono: Chrono | null = null;
  /** Les trois secteurs du tour, sur le circuit dessiné par le jeu. */
  let sectors: SectorTimer | null = null;
  if (SUZUKA_MAP) {
    await setLoading(0.26, 'Pose du circuit de Suzuka…');
    circuit = await buildCircuit(scene, world, {
      anisotropy: renderer.capabilities.getMaxAnisotropy(),
    });
    console.log(
      `Circuit de Suzuka : ${circuit.meshes} maillages, ${circuit.triangles} triangles, ` +
        `chargé en ${circuit.loadMs} ms, collider en ${circuit.buildMs} ms`,
    );

    // Le chrono de la piste. La ligne est posée quelques mètres devant la sortie
    // des stands : le départ arrêté a donc lieu avant elle, et c'est le premier
    // franchissement qui lance le tour lancé.
    const lineForward = forwardFromHeading(circuit.spawn.heading);
    chrono = new Chrono(
      {
        x: circuit.spawn.x + lineForward.x * CHRONO_LINE_OFFSET,
        z: circuit.spawn.z + lineForward.z * CHRONO_LINE_OFFSET,
        heading: circuit.spawn.heading,
      },
      'sp95.chrono.suzuka',
    );
  } else if (FLAT_MAP) {
    await setLoading(0.26, 'Construction du circuit SP95…');
    const flat = buildFlatCircuit(scene, world, {
      anisotropy: renderer.capabilities.getMaxAnisotropy(),
      lowFx,
    });
    circuit = flat;
    console.log(
      `Circuit SP95 : ${flat.triangles} triangles, ${flat.walls} murs, ` +
        `${Math.round(flat.length)} m de piste, collider en ${flat.buildMs} ms`,
    );
    // Même règle que Suzuka : la ligne est posée huit mètres devant le départ,
    // le premier franchissement lance le tour chronométré.
    const lineForward = forwardFromHeading(circuit.spawn.heading);
    chrono = new Chrono(
      {
        x: circuit.spawn.x + lineForward.x * CHRONO_LINE_OFFSET,
        z: circuit.spawn.z + lineForward.z * CHRONO_LINE_OFFSET,
        heading: circuit.spawn.heading,
      },
      'sp95.chrono.sp95',
    );
    // Les secteurs se mesurent sur la longueur du tour : leurs frontières
    // tombent au tiers et aux deux tiers, toujours sur les mêmes virages.
    sectors = new SectorTimer(TRACK.length, 'sp95.sectors.sp95');
  }

  // L'outillage des boxes part en tâche de fond : 3,6 Mo de modèles n'ont pas
  // à bloquer l'écran de chargement. Il est attendu juste avant « Prêt », le
  // temps que le terrain et la voiture se montent en parallèle.
  const propsPromise = FLAT_MAP
    ? buildPitProps(scene, world, renderer.capabilities.getMaxAnisotropy())
    : null;

  await setLoading(TRACK_MAP ? 0.42 : 0.3, 'Génération du terrain…');
  // Le terrain déborde du monde jouable et s'y redresse en barrière (voir
  // layout.borderHeight) : on ne peut plus sortir de la carte.
  const terrain = buildTerrain(scene, world, materials);
  // Le circuit SP95 fournit lui-même son revêtement : la physique doit lire
  // l'asphalte de la piste et l'herbe du reste, pas la grille de la ville.
  // La voie des stands et ses raccordements sont du bitume : sans cette
  // exception, la physique les lisait comme de l'herbe et la voiture y glissait.
  setTrackSurface(
    FLAT_MAP
      ? (x, z) =>
          insidePit(x, z) || insideDriftPad(x, z) ? 'asphalte' : trackSurfaceAt(x, z)
      : null,
  );
  /** Sol de jeu sous une roue : la dalle du circuit passe avant le terrain. */
  const groundAt = (x: number, z: number) =>
    Math.max(terrain.sample(x, z), circuitFloor(x, z) ?? -Infinity);

  // Contrôle de l'invariant : le terrain de secours doit rester *sous* la dalle
  // du circuit. Un nœud au-dessus ferait percer l'herbe à travers l'asphalte —
  // des plaques de texture qui clignotent sous les roues et une voiture qui
  // bute sur du vide. La valeur est exposée en debug (`__sp95.groundClearance`).
  let groundClearance = -Infinity;
  let trackClearance = -Infinity;
  let clearanceProbes = 0;
  let worstAt = { x: 0, z: 0 };
  let trackWorstAt = { x: 0, z: 0 };
  if (circuit && SUZUKA_MAP) {
    const halfX = CIRCUIT.plateHalfX * CIRCUIT.scale;
    const halfZ = CIRCUIT.plateHalfZ * CIRCUIT.scale;
    for (let z = CIRCUIT.cz - halfZ; z <= CIRCUIT.cz + halfZ; z += 12) {
      for (let x = CIRCUIT.cx - halfX; x <= CIRCUIT.cx + halfX; x += 12) {
        const floor = circuitFloor(x, z);
        // Seules les cases du modèle comptent : au-delà, c'est le terrain qui
        // est la surface et il n'y a rien à comparer.
        const kind = CIRCUIT.surface?.(x, z) ?? null;
        if (floor === null || kind === null) continue;
        clearanceProbes++;
        const gap = terrain.sample(x, z) - floor;
        if (gap > groundClearance) {
          groundClearance = gap;
          worstAt = { x: Math.round(x), z: Math.round(z) };
        }
        if (kind === 'asphalte') {
          trackClearance = Math.max(trackClearance, gap);
          if (gap === trackClearance) trackWorstAt = { x: Math.round(x), z: Math.round(z) };
        }
      }
    }
    // Aucune sonde (dalle absente) : l'écart n'a pas de sens, on le remet à zéro.
    if (clearanceProbes === 0) {
      groundClearance = 0;
      trackClearance = 0;
    }
    console.log(
      `Terrain sous la dalle : écart max ${groundClearance.toFixed(2)} m ` +
        `(en ${worstAt.x},${worstAt.z}) · sous la piste ${trackClearance.toFixed(2)} m ` +
        `(en ${trackWorstAt.x},${trackWorstAt.z}) sur ${clearanceProbes} sondes`,
    );
  } else if (FLAT_MAP) {
    // La piste dessinée par le jeu n'a pas de dalle importée : le terrain plat
    // est la seule couche, il n'y a rien à comparer. Surtout, la boucle de
    // contrôle ci-dessus balayait la dalle de la *ville* (des milliers de
    // sondes toutes vides) et coûtait 2,5 s au démarrage.
    groundClearance = 0;
    trackClearance = 0;
  }

  // Ce que la carte de la ville a en plus : routes, ville, mobilier, arbres et
  // circuit de la ceinture. Sur la carte du circuit, tout cela reste vide.
  let puddles: PuddleField | null = null;
  let props: Awaited<ReturnType<typeof buildCity>> = [];
  let streetKit: StreetKitSummary = { models: 0, instances: 0, colliders: 0, roadMaterials: [] };
  let vegetation: VegetationSummary = { trees: 0, grass: 0 };
  let checkpoints: THREE.Vector3[] = [];
  /** Dry colour of each street-kit road tile, so the wet tint can be undone. */
  const streetKitDryColors = new Map<THREE.MeshStandardMaterial, THREE.Color>();

  if (!TRACK_MAP) {
    await setLoading(0.52, 'Tracé des routes…');
    buildGradedRoads(scene, materials, world);
    buildArenaPads(world);

    // La carte du col n'a que sa route de montagne : pas de rues, pas de ville,
    // pas de mobilier urbain, pas de course sur la ceinture. Des glissières à
    // la place, et une forêt dense.
    if (MOUNTAIN_MAP) {
      buildGuardrails(scene, world);
    } else {
      buildRoads(scene, materials);
      puddles = buildPuddles(scene);

      await setLoading(0.68, 'Construction de la ville…');
      props = await buildCity(scene, world, materials);

      await setLoading(0.74, 'Mobilier urbain…');
      streetKit = await buildStreetKit(scene, world, materials);
    }

    await setLoading(0.8, 'Plantation des arbres…');
    vegetation = await buildVegetation(scene, world, lowFx, sky.sunDirection);

    if (!MOUNTAIN_MAP) {
      await setLoading(0.85, 'Installation du circuit…');
      checkpoints = buildRaceCheckpoints(12);
      buildRaceGates(scene, materials, checkpoints);
    }
  }

  await setLoading(0.88, 'Montage de la voiture…');
  let setup: Setup = loadSetup();
  let carDef: CarDef = findCar(loadCarId());
  let spec: VehicleSpec = resolveSpec(setup, carDef.spec);
  // Drop the car in at its ride height: spawning higher makes it land on the
  // bump stops and bounce before the player can drive. Taller tires lift it.
  const rideHeightFor = (s: VehicleSpec) => s.rideHeight + s.wheelRadius - 0.12 + 0.04;
  /**
   * Cote du sol sous un point, mesurée au rayon depuis le dessus de la carte.
   * L'estimateur par cases se trompe d'un mètre sur la dalle du circuit : une
   * voiture née sous l'asphalte n'a aucun contact — les rayons des roues partent
   * sous la surface — elle traverse le collider et tombe sous la piste.
   */
  function dropHeightAt(x: number, z: number): number {
    const estimate = groundAt(x, z);
    // Trois mètres au-dessus de l'estimation : assez pour rattraper son erreur
    // d'un mètre, trop court pour accrocher le tablier d'un croisement ou un
    // toit de tribune au passage.
    const from = estimate + 3;
    const ray = new RAPIER.Ray({ x, y: from, z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 8, true);
    return hit ? from - hit.timeOfImpact : estimate;
  }
  /** Où la voiture attend : la ligne des stands sur le circuit, la rue en ville. */
  const startPose = circuit
    ? { x: circuit.spawn.x, z: circuit.spawn.z, heading: circuit.spawn.heading }
    : MOUNTAIN_MAP
      ? { x: COL_START.x, z: COL_START.z, heading: COL_START.heading }
      : { x: SPAWN.x, z: SPAWN.z, heading: SPAWN.heading };
  const spawnY = dropHeightAt(startPose.x, startPose.z) + rideHeightFor(spec);
  /**
   * Cote du sol pour la physique : la dalle du circuit d'abord, le terrain
   * ensuite. Elle sert de filet aux rayons de roue — la grille de collision de
   * la piste a des trous, et sans elle la voiture traversait l'asphalte.
   */
  const floorLookup = (x: number, z: number, reference?: number): number | null =>
    circuitFloor(x, z, reference) ?? groundAt(x, z);
  /** Profondeur sous le sol au-delà de laquelle on repose la caisse sur place. */
  const FALL_RECOVERY_DEPTH = 2;
  let carVehicle: Vehicle = new Vehicle(
    world,
    {
      x: startPose.x,
      y: spawnY,
      z: startPose.z,
      heading: startPose.heading,
      surfaceAt,
      floorAt: floorLookup,
    },
    spec,
  );
  /** Whichever vehicle is being ridden right now. */
  let vehicle: Vehicle | Bike = carVehicle;
  /** Where the car stands while the bike is out; rebuilt in place by the garage. */
  let carPose = { x: startPose.x, z: startPose.z, heading: startPose.heading };
  let bike: Bike | null = null;
  let bikeVisual: BikeVisual | null = null;
  let bikeSetup: BikeSetup = loadBikeSetup();
  /** The bike as the workshop built it: every bike readout uses this one. */
  let bikeSpec = resolveBikeSpec(bikeSetup, SUPERMOTARD.spec);
  let ridingBike = false;
  let tcsEnabled = loadTcs();
  let absEnabled = loadAbs();
  vehicle.tcsEnabled = tcsEnabled;
  vehicle.absEnabled = absEnabled;
  // The model is the real thing when it loads; the lofted shell stays as a
  // fallback so a missing or corrupt GLB never blocks the game.
  let car: CarVisual = createCar();
  let carIsModel = false;
  try {
    car = await loadCarVisual(carDef, spec);
    carIsModel = true;
  } catch (error) {
    console.warn('Modèle de voiture indisponible, voiture de secours.', error);
  }
  car.setWheelRadius(spec.wheelRadius);
  car.group.position.set(startPose.x, spawnY, startPose.z);
  scene.add(car.group);

  // Deux faisceaux réels suivent le véhicule, même après un changement de modèle.
  // Aucun profil photométrique IES n'est fourni dans les assets : cônes lissés.
  const headlamps = MOUNTAIN_MAP ? [-0.65, 0.65].map((side) => {
    const light = new THREE.SpotLight(0xfff4dc, 2600, 125, Math.PI / 6.5, 0.72, 2);
    light.castShadow = false;
    light.userData.side = side;
    scene.add(light, light.target);
    return light;
  }) : [];

  // Post-traitement léger, uniquement sur le col : aucune traînée à l'arrêt.
  const composer = MOUNTAIN_MAP && !lowFx ? new EffectComposer(renderer) : null;
  const motion = composer ? new AfterimagePass(0) : null;
  if (composer && motion) {
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(motion);
    composer.addPass(new OutputPass());
  }

  // Un cerf peut traverser devant la voiture ; sa collision suit sa pose. Il
  // s'arrête, fixe la caisse, charge — puis part en ragdoll sous le choc.
  type DeerPhase = 'off' | 'walk' | 'stare' | 'charge' | 'dead';
  let deer: {
    group: THREE.Group;
    body: RAPIER.RigidBody | null;
    scene: THREE.Object3D | null;
    mixer: THREE.AnimationMixer | null;
    action: THREE.AnimationAction | null;
    origin: THREE.Vector3;
    direction: THREE.Vector3;
    crossing: THREE.Vector3;
    position: THREE.Vector3;
    walked: number;
    limit: number;
    phase: DeerPhase;
    phaseTime: number;
    yaw: number;
    stared: boolean;
    ragdoll: DeerRagdoll | null;
    ready: boolean;
  } | null = null;
  let deerTimer = 32;
  /** Calé sur le clip : à 1,15 m/s la bête rampe sans glisser sur la route. */
  const DEER_WALK_SPEED = 1.15;
  const DEER_CHARGE_SPEED = 7.5;
  const DEER_CORPSE_TIME = 7;
  const DEER_UP = new THREE.Vector3(0, 1, 0);
  const deerQuat = new THREE.Quaternion();

  /** Corps cinématique du cerf : sa collision suit sa pose, sans le pousser. */
  function createDeerBody(): RAPIER.RigidBody {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.55, 1.4, 1.7)
      .setTranslation(0, 1.4, 0).setCollisionGroups((GROUP_WORLD << 16) | GROUP_WORLD), body);
    return body;
  }

  /** Angle le plus court entre deux caps, borné par `step`. */
  function turnTowards(current: number, target: number, step: number): number {
    let delta = target - current;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return current + Math.max(-step, Math.min(step, delta));
  }

  function deerDistance(): number {
    if (!deer) return Infinity;
    return Math.hypot(carPosition.x - deer.position.x, carPosition.z - deer.position.z);
  }

  /** Vrai quand la caisse touche vraiment la bête (les roues sont des rayons). */
  function deerTouchesCar(): boolean {
    if (!deer?.body) return false;
    const deerCollider = deer.body.collider(0);
    const carCollider = vehicle.body.collider(0);
    if (!deerCollider || !carCollider) return false;
    let touching = false;
    world.contactPair(carCollider, deerCollider, () => { touching = true; });
    return touching;
  }

  function despawnDeer(): void {
    if (!deer) return;
    deer.group.visible = false;
    deer.ragdoll?.dispose();
    deer.ragdoll = null;
    deer.phase = 'off';
    deer.phaseTime = 0;
    deer.body?.setNextKinematicTranslation({ x: 0, y: -100, z: 0 });
    deerTimer = 35 + Math.random() * 35;
  }

  /** La bête est fauchée : le squelette animé lâche la place au ragdoll. */
  function hitDeer(): void {
    if (!deer || deer.phase === 'dead' || !deer.scene) return;
    const v = vehicle.body.linvel();
    deer.phase = 'dead';
    deer.phaseTime = 0;
    deer.mixer?.stopAllAction();
    deer.group.updateMatrixWorld(true);
    deer.ragdoll = spawnDeerRagdoll(world, deer.scene, new THREE.Vector3(v.x, v.y, v.z));
    if (deer.body) {
      world.removeRigidBody(deer.body);
      deer.body = null;
    }
    // Le choc doit se sentir : la caisse perd près de la moitié de sa vitesse.
    const speed = Math.hypot(v.x, v.z);
    const kept = speedAfterDeerImpact(speed);
    const ratio = speed > 1e-3 ? kept / speed : 0;
    vehicle.body.setLinvel({ x: v.x * ratio, y: Math.min(v.y, 1.5), z: v.z * ratio }, true);
    lastCrashTime = performance.now() / 1000;
    audio.impact(0.85);
    hud.flash('Impact', { accent: true, duration: 900 });
  }

  if (MOUNTAIN_MAP) {
    const group = new THREE.Group();
    group.name = 'deer';
    group.visible = false;
    scene.add(group);
    deer = {
      group,
      body: createDeerBody(),
      scene: null,
      mixer: null,
      action: null,
      origin: new THREE.Vector3(),
      direction: new THREE.Vector3(),
      crossing: new THREE.Vector3(),
      position: new THREE.Vector3(),
      walked: 0,
      limit: 26,
      phase: 'off',
      phaseTime: 0,
      yaw: 0,
      stared: false,
      ragdoll: null,
      ready: false,
    };
    // Le GLB pèse 13 Mo : il arrive après le premier tour de roue, pas devant.
    void loadDeerModel()
      .then((model) => {
        if (!deer) return;
        deer.group.add(model.object);
        deer.scene = model.scene;
        deer.mixer = model.mixer;
        deer.action = model.action;
        deer.ready = true;
      })
      .catch((error) => console.warn('Modèle de cerf indisponible.', error));
  }

  function updateDeer(dt: number): void {
    if (!deer || !deer.ready || mode === 'menu' || paused || replay) return;
    const gap = deerDistance();

    if (deer.phase === 'off') {
      deerTimer -= dt;
      if (deerTimer > 0 || vehicle.telemetryState.speedKmh < 15) return;
      const road = MOUNTAIN_ROADS[0];
      let nearest = 0, distance = Infinity;
      for (let i = 0; i < road.points.length; i++) {
        const p = road.points[i];
        const d = (p.x - carPosition.x) ** 2 + (p.z - carPosition.z) ** 2;
        if (d < distance) { distance = d; nearest = i; }
      }
      // Cherche une apparition devant la voiture, aussi en sens inverse.
      const p0 = road.points[nearest];
      const p1 = road.points[Math.min(nearest + 1, road.points.length - 1)];
      const travel = (p1.x - p0.x) * carForward.x + (p1.z - p0.z) * carForward.z >= 0 ? 1 : -1;
      const index = Math.max(1, Math.min(road.points.length - 2, nearest + travel * 15));
      const p = road.points[index], a = road.points[index - 1], b = road.points[index + 1];
      deer.crossing.set(-(b.z - a.z), 0, b.x - a.x).normalize();
      deer.direction.copy(deer.crossing);
      deer.origin.copy(p).addScaledVector(deer.direction, -12);
      deer.origin.y = groundAt(deer.origin.x, deer.origin.z);
      deer.position.copy(deer.origin);
      deer.walked = 0;
      deer.limit = 26;
      deer.phase = 'walk';
      deer.phaseTime = 0;
      deer.stared = false;
      deer.yaw = Math.atan2(-deer.direction.x, -deer.direction.z);
      deer.group.rotation.y = deer.yaw;
      deer.group.position.copy(deer.position);
      deer.group.visible = true;
      if (!deer.body) deer.body = createDeerBody();
      deer.body.setTranslation(deer.position, true);
      deer.action?.reset().play();
      deer.mixer?.setTime(0);
      return;
    }

    deer.phaseTime += dt;

    if (deer.phase === 'dead') {
      deer.ragdoll?.update();
      if (deer.phaseTime > DEER_CORPSE_TIME) despawnDeer();
      return;
    }

    if (deer.phase === 'walk') {
      // Elle rampe vers la route sans glisser : 6,25 s de clip par cycle.
      deer.walked += DEER_WALK_SPEED * dt;
      deer.position.copy(deer.origin).addScaledVector(deer.direction, deer.walked);
      deer.position.y = Math.max(groundAt(deer.position.x, deer.position.z), deer.origin.y);
      deer.mixer?.update(dt);
      if (!deer.stared && deer.walked > 3 && gap < 45) {
        deer.phase = 'stare';
        deer.phaseTime = 0;
      }
      if (deer.walked > deer.limit) {
        despawnDeer();
        return;
      }
    } else if (deer.phase === 'stare') {
      // Elle s'arrête au bord de la route et fixe la voiture. C'est ce regard
      // qui doit faire peur, pas une bête qui glisse en ligne droite.
      deer.yaw = turnTowards(
        deer.yaw,
        Math.atan2(-(carPosition.x - deer.position.x), -(carPosition.z - deer.position.z)),
        2.2 * dt,
      );
      deer.mixer?.update(dt * 0.3);
      if (deer.phaseTime > 1.2 && gap < 22) {
        deer.phase = 'charge';
        deer.phaseTime = 0;
      } else if (deer.phaseTime > 4) {
        deer.phase = 'walk';
        deer.phaseTime = 0;
        deer.stared = true;
      }
    } else if (deer.phase === 'charge') {
      if (gap > 0.3) {
        deer.direction.set(
          (carPosition.x - deer.position.x) / gap,
          0,
          (carPosition.z - deer.position.z) / gap,
        );
        deer.yaw = turnTowards(deer.yaw, Math.atan2(-deer.direction.x, -deer.direction.z), 7 * dt);
      }
      deer.position.addScaledVector(deer.direction, DEER_CHARGE_SPEED * dt);
      deer.position.y = groundAt(deer.position.x, deer.position.z);
      deer.mixer?.update(dt * 3);
      if (deer.phaseTime > 3.5) {
        deer.phase = 'walk';
        deer.phaseTime = 0;
        deer.stared = true;
        deer.origin.copy(deer.position);
        deer.direction.copy(deer.crossing);
        deer.walked = 0;
        deer.limit = 14;
      }
    }

    deer.group.position.copy(deer.position);
    deer.group.rotation.y = deer.yaw;
    if (deer.body) {
      deer.body.setNextKinematicTranslation(deer.position);
      deerQuat.setFromAxisAngle(DEER_UP, deer.yaw);
      deer.body.setNextKinematicRotation(deerQuat);
    }

    const within = deerWithinCarFootprint({
      dx: deer.position.x - carPosition.x,
      dz: deer.position.z - carPosition.z,
      forwardX: carForward.x,
      forwardZ: carForward.z,
    });
    if (within || ((deer.phase === 'charge' || vehicle.telemetryState.speed > 3) && deerTouchesCar())) {
      hitDeer();
    }
  }

  const input = new InputManager(canvas);
  const hud = new Hud();
  // La mini-carte de la piste : son propre cadrage, sinon le tour tient dans
  // quelques pixels au centre de l'échelle de la ville.
  if (FLAT_MAP) hud.setCircuit(TRACK.samples);
  hud.setRedline(spec.redlineRpm);
  hud.setVehicle('car');
  setTcs(tcsEnabled, false);
  setAbs(absEnabled, false);
  const audio = new CarAudio();
  /** Car and bike keep their own balance; the master is shared. */
  let vehicleMixes = loadVehicleMixes();
  /** Overlay hidden while the sound panel is up, restored when it closes. */
  let soundReturn: HTMLElement | null = null;
  const audioPanel = new AudioPanel(
    audio.soundMix,
    (channel, value) => {
      audio.setChannel(channel, value);
      vehicleMixes = rememberMix(vehicleMixes, ridingBike ? 'bike' : 'car', audio.soundMix);
      saveVehicleMixes(vehicleMixes);
    },
    () => closeSound(),
  );
  applyVehicleMix();
  /** Réglage « Drift » monté : le tour se compte en points, pas en secondes. */
  const DRIFT_PRESET = PRESETS.find((entry) => entry.label === 'Drift')!;
  let driftMode = false;
  /** Total de points au moment où le tour en cours a commencé. */
  let driftLapBase = 0;
  let driftBestLap: number | null = (() => {
    try {
      const raw = localStorage.getItem('sp95.driftBestLap');
      const value = raw === null ? NaN : Number(raw);
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  })();
  const drift = new DriftScore();
  const stunt = new StuntScore();
  const governor = lockedFx ? null : new QualityGovernor(renderer, renderer.getPixelRatio(), sky.sun);

  let mode: GameMode = 'menu';
  let freeSpawn: FreeSpawn = 'city';
  let paused = false;
  let accumulator = 0;
  /**
   * Pose physique du pas précédent, pour interpoler le rendu entre deux pas
   * fixes : à basse cadence, la physique avance par bonds et la voiture semblait
   * se téléporter.
   */
  const physPrevious = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  let race: Race | null = null;
  /** Vrai quand la session en cours est chronométrée (conduite libre à Suzuka). */
  let timedLap = false;
  let menuTime = 0;
  let lastSpeed = 0;
  let lastCrashTime = -10;
  /** Last seconds of poses, and the replay currently playing them back. */
  const replayMemory = new ReplayBuffer();
  let replay: { poses: ReplayPose[]; elapsed: number; bike: boolean } | null = null;
  /** Held rewind: the same poses, walked backwards until the key is released. */
  let rewind: { poses: ReplayPose[]; elapsed: number } | null = null;
  let rewindHeld = false;
  /** Absolute angle the replay camera holds, in world space. */
  let replayCamYaw = 0;
  let replayCamOrbit = 0;
  /**
   * Vues du replay, comme dans un jeu de course : poursuite libre, caméra TV en
   * hauteur, embarquée, et caméra posée au bord de la piste que la voiture
   * traverse. `C` les fait défiler, `Q`/`E` et la souris tournent la poursuite.
   */
  let replayView: ReplayView = 'chase';
  const replayTrackside = new THREE.Vector3();

  /** Pose la caméra de bord de piste : côté extérieur, un peu en avant. */
  function placeReplayTrackside(): void {
    const side = new THREE.Vector3(-carForward.z, 0, carForward.x);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    replayTrackside.set(
      carPosition.x + side.x * 23 + carForward.x * 9,
      groundAt(carPosition.x, carPosition.z) + 5.2,
      carPosition.z + side.z * 23 + carForward.z * 9,
    );
  }
  const replayQuat = new THREE.Quaternion();
  /** Seconds of history travelled per real second while rewinding. */
  const REWIND_RATE = 1.7;
  let gravelTimer = 0;
  /** Inspection camera, set from the debug hook: no effect unless used. */
  let freeCamera: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  let lastFrame = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;
  let fps = 0;

  const smokeFx = createTireSmoke(lowFx ? 180 : 420);
  scene.add(smokeFx.object);
  const sparkFx = createSparks(lowFx ? 120 : 260);
  scene.add(sparkFx.object);
  let sparkDebt = 0;
  let scrapeTimer = 0;
  const platePoint = new THREE.Vector3();
  /** Fractional puffs owed to each wheel, so the rate does not depend on fps. */
  const smokeDebt = [0, 0, 0, 0];
  const smokeTint = new THREE.Color();
  const SMOKE_WHITE = new THREE.Color(0xe4e4e6);
  const SMOKE_DUST = new THREE.Color(0xc7ad86);
  /** Water thrown up by the rear tire: brighter and bluer than tire smoke. */
  const SMOKE_SPRAY = new THREE.Color(0xd6e4ee);
  const carVelocity = new THREE.Vector3();
  /** Scratches de l'image : réutilisés, jamais alloués dans la boucle. */
  const lightPos = new THREE.Vector3();
  const visualQuat = new THREE.Quaternion();

  const carPosition = new THREE.Vector3(startPose.x, spawnY, startPose.z);
  const carForward = forwardFromHeading(startPose.heading);
  /** Ground attitude under the bike, smoothed: the visual follows the hill. */
  const slopeState = { pitch: 0, roll: 0 };
  const slopeNormal = new THREE.Vector3();
  const localNormal = new THREE.Vector3();
  const bodyQuat = new THREE.Quaternion();
  const cameraGround = (x: number, z: number) => groundAt(x, z);

  /** How much of the car -> camera segment is free of walls and ground. */
  const cameraClearance = (from: THREE.Vector3, to: THREE.Vector3): number => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-4) return 1;
    const ray = new RAPIER.Ray(
      { x: from.x, y: from.y, z: from.z },
      { x: dx / length, y: dy / length, z: dz / length },
    );
    const hit = world.castRay(
      ray,
      length,
      true,
      undefined,
      undefined,
      undefined,
      vehicle.body,
    );
    if (!hit) return 1;
    return Math.min(1, Math.max(0, (hit.timeOfImpact - 0.2) / length));
  };

  const updateMenuBest = () => refreshMenuBest();

  /**
   * Cote exacte du sol sous un point : la dalle du circuit si elle est là, le
   * terrain sinon. La sonde part 4 m au-dessus de l'estimation — assez pour
   * rattraper son erreur, trop bas pour accrocher un pont ou un toit — et le
   * rayon ignore le véhicule lui-même.
   */
  function surfaceUnder(x: number, z: number): number {
    const fallback = groundAt(x, z);
    const from = fallback + 4;
    const ray = new RAPIER.Ray({ x, y: from, z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 8, true, undefined, undefined, undefined, vehicle.body);
    return hit ? from - hit.timeOfImpact : fallback;
  }

  function setCarPose(x: number, z: number, heading: number): void {
    // Sur la piste, la surface du circuit est au-dessus du terrain de jeu : on la
    // mesure au rayon, sinon la voiture tomberait sur l'asphalte au lieu d'y
    // être posée (l'estimateur par cases se trompe d'un mètre).
    const ground = surfaceUnder(x, z);
    const height = ridingBike ? bikeSpec.cgHeight : rideHeightFor(spec);
    vehicle.respawn(x, ground + height, z, heading);
    // Les ressorts se tassent à l'arrêt pour que les pneus touchent tout de
    // suite. Frein à main **seul** : soixante pas de `brake: 1` à l'arrêt font
    // passer la boîte en marche arrière (0,35 s suffisent), et le kart
    // démarrait en R, gaz au fond, à reculons.
    for (let i = 0; i < 60; i++) {
      vehicle.step(FIXED, { throttle: 0, brake: 0, steer: 0, handbrake: true }, world);
      world.step();
    }
    const p = vehicle.position;
    const r = vehicle.state.rotation;
    physPrevious.x = p.x;
    physPrevious.y = p.y;
    physPrevious.z = p.z;
    physPrevious.qx = r.x;
    physPrevious.qy = r.y;
    physPrevious.qz = r.z;
    physPrevious.qw = r.w;
    carPosition.set(p.x, p.y, p.z);
    carForward.copy(forwardFromHeading(heading));
    chase.snap(carPosition, carForward, ground);
    accumulator = 0;
    lastSpeed = 0;
    smokeFx.clear();
    sparkFx.clear();
    sparkDebt = 0;
    if (!ridingBike) carPose = { x, z, heading };
    stunt.reset();
    if (!ridingBike) drift.reset();
  }

  function spawnFree(): void {
    setCarPose(startPose.x, startPose.z, startPose.heading);
    drift.reset();
    lastSpeed = 0;
  }

  function startMode(next: GameMode, spawn: FreeSpawn = 'city'): void {
    // A menu button keeps the focus when its overlay is hidden, and Space would
    // then re-click it instead of pulling the handbrake.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // Sur la carte du circuit il n'y a qu'une piste : les départs de la ville y
    // retombent sur la ligne droite des stands, et la course sur la ceinture n'y
    // existe pas.
    const target: FreeSpawn = TRACK_MAP ? 'circuit' : spawn;
    const wanted: GameMode = next === 'race' && TRACK_MAP ? 'free' : next;
    mode = wanted;
    freeSpawn = target;
    paused = false;
    menu.classList.add('hidden');
    pause.classList.add('hidden');
    hudElement.classList.remove('hidden');
    // Sur la carte du circuit, la conduite libre se roule au chrono : le
    // panneau des tours affiche le tour en cours et le meilleur, sans course.
    timedLap = Boolean(chrono) && wanted === 'free' && target === 'circuit';
    if (timedLap) chrono?.reset();
    sectors?.reset();
    refreshScoringPanels();
    hud.setMode(wanted, TRACK_LABEL);
    input.clear();
    audio.init();
    configureAudio();
    race = null;
    hud.hideMessage();
    hudElement.dataset.count = '';

    if (wanted === 'race') {
      race = new Race(checkpoints);
      setCarPose(RACE_START.x, RACE_START.z, RACE_START.heading);
      drift.reset();
      lastSpeed = 0;
      hud.flash('Prêt ?', { accent: true, duration: 900 });
    } else if (target === 'col') {
      setCarPose(COL_START.x, COL_START.z, COL_START.heading);
      drift.reset();
      lastSpeed = 0;
      hud.flash('Route du Col', { duration: 1300 });
    } else if (target === 'rally') {
      setCarPose(RALLY_START.x, RALLY_START.z, RALLY_START.heading);
      drift.reset();
      lastSpeed = 0;
      hud.flash('Piste rallye', { duration: 1300 });
    } else if (target === 'summit') {
      setCarPose(SUMMIT_START.x, SUMMIT_START.z, SUMMIT_START.heading);
      drift.reset();
      lastSpeed = 0;
      hud.flash('Sommet', { duration: 1300 });
    } else if (target === 'circuit') {
      setCarPose(startPose.x, startPose.z, startPose.heading);
      drift.reset();
      lastSpeed = 0;
      hud.flash(FLAT_MAP ? 'Circuit SP95' : 'Circuit de Suzuka', { duration: 1600 });
    } else {
      spawnFree();
      hud.flash('Conduite libre', { duration: 1100 });
    }
    updateMenuBest();
  }

  function togglePause(): void {
    if (mode === 'menu') return;
    paused = !paused;
    pause.classList.toggle('hidden', !paused);
    if (paused) {
      input.clear();
      audio.update({
        rpm: 900,
        throttle: 0,
        speed: 0,
        slip: 0,
        gear: 1,
        grounded: true,
        limiter: false,
        roughness: 0,
        offRoad: false,
      });
    }
  }

  function respawn(): void {
    if (mode === 'race' && race && race.phase === 'running') {
      const pose = race.respawnPose();
      setCarPose(pose.x, pose.z, pose.heading);
    } else {
      if (freeSpawn === 'col') setCarPose(COL_START.x, COL_START.z, COL_START.heading);
      else if (freeSpawn === 'rally') setCarPose(RALLY_START.x, RALLY_START.z, RALLY_START.heading);
      else if (freeSpawn === 'summit') setCarPose(SUMMIT_START.x, SUMMIT_START.z, SUMMIT_START.heading);
      else spawnFree();
    }
    // Repartir des stands, c'est repartir du chrono : le tour en cours est perdu.
    if (timedLap) chrono?.reset();
    sectors?.reset();
    hud.flash('Réapparition', { duration: 700 });
  }

  /** Rebuilds the car physics body with the current setup, in place. */
  function rebuildVehicle(): void {
    spec = resolveSpec(setup, carDef.spec);
    const pose = carPose;
    world.removeRigidBody(carVehicle.body);
    carVehicle = new Vehicle(
      world,
      {
        x: pose.x,
        y: groundAt(pose.x, pose.z) + rideHeightFor(spec) + 0.35,
        z: pose.z,
        heading: pose.heading,
        surfaceAt,
        floorAt: floorLookup,
      },
      spec,
    );
    carVehicle.tcsEnabled = tcsEnabled;
    carVehicle.absEnabled = absEnabled;
    car.setWheelRadius(spec.wheelRadius);
    if (!ridingBike) {
      vehicle = carVehicle;
      configureAudio();
      hud.setRedline(spec.redlineRpm);
      setCarPose(pose.x, pose.z, pose.heading);
    } else {
      // The garage is open while the bike is out: rebuild the car on its marks
      // and leave the rider on two wheels.
      carVehicle.body.setEnabled(false);
    }
  }

  /** Builds the supermotard the first time it is asked for. */
  function ensureBike(): Bike {
    if (bike) return bike;
    const y = groundAt(SUMMIT_START.x, SUMMIT_START.z) + bikeSpec.cgHeight;
    bike = new Bike(
      world,
      {
        x: SUMMIT_START.x,
        y,
        z: SUMMIT_START.z,
        heading: SUMMIT_START.heading,
        surfaceAt,
        floorAt: floorLookup,
      },
      bikeSpec,
    );
    bike.body.setEnabled(false);
    return bike;
  }

  /** Rebuilds the bike on its marks: the workshop changed its spec. */
  function rebuildBike(): void {
    if (!bike) return;
    const position = bike.position;
    const rotation = bike.rotation;
    const heading = Math.atan2(2 * (rotation.w * rotation.y), 1 - 2 * rotation.y * rotation.y);
    world.removeRigidBody(bike.body);
    bike = new Bike(
      world,
      { x: position.x, y: position.y, z: position.z, heading, surfaceAt, floorAt: floorLookup },
      bikeSpec,
    );
    bike.body.setEnabled(ridingBike);
    vehicle = bike;
    configureAudio();
    hud.setRedline(bikeSpec.redlineRpm);
  }

  function applyBikeSetup(next: BikeSetup): void {
    bikeSetup = { ...next };
    saveBikeSetup(bikeSetup);
    bikeSpec = resolveBikeSpec(bikeSetup, SUPERMOTARD.spec);
    rebuildBike();
    hud.setBikePreset(bikePresetLabel(bikeSetup));
    hud.flash('Moto réglée', { duration: 900 });
  }

  /**
   * The modelled bike, loaded once and reused every time the rider comes back.
   * The procedural machine is the fallback: a 10 MB model that failed to load
   * must not take the whole mode with it.
   */
  let bikeVisualPromise: Promise<BikeVisual> | null = null;
  function bikeVisualReady(): Promise<BikeVisual> {
    bikeVisualPromise ??= loadBikeVisual(bikeSpec).catch((error) => {
      console.error(error);
      hud.flash('Modèle 3D indisponible — moto de secours', { duration: 1900 });
      return createBike();
    });
    return bikeVisualPromise;
  }

  async function enterBike(): Promise<void> {
    const next = ensureBike();
    if (!bikeVisual) {
      bikeVisual = await bikeVisualReady();
      bikeVisual.group.visible = false;
      scene.add(bikeVisual.group);
    }
    ridingBike = true;
    car.group.visible = false;
    carVehicle.body.setEnabled(false);
    if (bikeVisual) bikeVisual.group.visible = true;
    next.body.setEnabled(true);
    vehicle = next;
    hud.setVehicle('bike');
    hud.setRedline(bikeSpec.redlineRpm);
    hud.setBikePreset(bikePresetLabel(bikeSetup));
    configureAudio();
    applyVehicleMix();
    drift.reset();
    stunt.reset();
  }

  /** Back to four wheels, wherever the bike happens to be standing. */
  function leaveBike(): void {
    if (!ridingBike) return;
    const p = vehicle.position;
    const heading = Math.atan2(-carForward.x, -carForward.z);
    ridingBike = false;
    bike?.body.setEnabled(false);
    if (bikeVisual) bikeVisual.group.visible = false;
    car.group.visible = true;
    carVehicle.body.setEnabled(true);
    vehicle = carVehicle;
    hud.setVehicle('car');
    configureAudio();
    applyVehicleMix();
    hud.setRedline(spec.redlineRpm);
    carPose = { x: p.x, z: p.z, heading };
    setCarPose(p.x, p.z, heading);
    drift.reset();
    stunt.reset();
  }

  /** Drops the supermotard on the summit pad, the stunt playground. */
  async function startBikeMode(): Promise<void> {
    // The model is a few megabytes: say so on the button that asked for it,
    // since the HUD is still hidden behind the menu.
    const buttons = ['btn-moto', 'btn-pause-moto']
      .map((id) => document.getElementById(id) as HTMLButtonElement | null)
      .filter((button): button is HTMLButtonElement => Boolean(button));
    const labels = buttons.map((button) => button.textContent);
    for (const button of buttons) {
      button.disabled = true;
      button.textContent = 'Chargement de la moto…';
    }
    try {
      await enterBike();
    } finally {
      buttons.forEach((button, i) => {
        button.disabled = false;
        button.textContent = labels[i];
      });
    }
    startMode('free', 'summit');
    hud.flash('Supermotard · Espace pour le wheelie', { accent: true, duration: 2200 });
  }

  /** TCS on/off: cuts the per-wheel torque cap, for drifts and burnouts. */
  function setTcs(enabled: boolean, announce = true): void {
    tcsEnabled = enabled;
    vehicle.tcsEnabled = enabled;
    saveTcs(enabled);
    hud.setTcs(enabled);
    const button = document.getElementById('btn-pause-tcs');
    if (button) button.textContent = `Antipatinage · ${enabled ? 'Actif' : 'Coupé'}`;
    if (announce) {
      hud.flash(enabled ? 'Antipatinage actif' : 'Antipatinage coupé', {
        accent: !enabled,
        duration: 1100,
      });
    }
  }

  function loadTcs(): boolean {
    try {
      return localStorage.getItem('sp95.tcs') !== 'off';
    } catch {
      return true;
    }
  }

  function saveTcs(enabled: boolean): void {
    try {
      localStorage.setItem('sp95.tcs', enabled ? 'on' : 'off');
    } catch {
      // Private mode: the switch just does not persist.
    }
  }

  function loadAbs(): boolean {
    try {
      return localStorage.getItem('sp95.abs') !== 'off';
    } catch {
      return true;
    }
  }

  function saveAbs(enabled: boolean): void {
    try {
      localStorage.setItem('sp95.abs', enabled ? 'on' : 'off');
    } catch {
      // Private mode: the switch just does not persist.
    }
  }

  /** ABS on/off : coupé, les roues se bloquent et la voiture glisse au freinage. */
  function setAbs(enabled: boolean, announce = true): void {
    absEnabled = enabled;
    carVehicle.absEnabled = enabled;
    saveAbs(enabled);
    hud.setAbs(enabled);
    const button = document.getElementById('btn-pause-abs');
    if (button) button.textContent = `ABS · ${enabled ? 'Actif' : 'Coupé'}`;
    if (announce) {
      hud.flash(enabled ? 'ABS actif' : 'ABS coupé', {
        accent: !enabled,
        duration: 1100,
      });
    }
  }

  /** Rebuilds the car with the garage setup, keeping where it stands. */
  function applySetup(next: Setup): void {
    setup = { ...next };
    saveSetup(setup);
    rebuildVehicle();
    syncDriveModes();
    refreshScoringPanels();
  }

  /**
   * Le bon panneau de score : temps et secteurs en réglage normal, points de
   * drift quand le kit Drift est monté. Appelé au départ et à chaque réglage.
   */
  function refreshScoringPanels(): void {
    driftMode = !ridingBike && sameSetup(setup, DRIFT_PRESET.setup);
    driftLapBase = drift.total;
    hud.setChrono(timedLap && !driftMode);
    hud.setSectors(timedLap && Boolean(sectors) && !driftMode);
    hud.setDriftLap(timedLap && driftMode);
  }

  /**
   * Les trois façons de rouler, à portée de clic depuis le HUD : route, drift,
   * piste. Ce sont les presets de l'atelier — le mode piste monte les slicks de
   * course — appliqués à la voiture en main, sans passer par la pause.
   */
  const DRIVE_MODES = [
    { id: 'route', label: 'Route', preset: PRESETS.find((entry) => entry.label === 'Série')! },
    { id: 'drift', label: 'Drift', preset: PRESETS.find((entry) => entry.label === 'Drift')! },
    { id: 'piste', label: 'Piste', preset: PRESETS.find((entry) => entry.label === 'Piste')! },
  ];

  function sameSetup(a: Setup, b: Setup): boolean {
    return (Object.keys(b) as (keyof Setup)[]).every((key) => a[key] === b[key]);
  }

  /** Le bouton allumé est celui dont le réglage est exactement monté. */
  function syncDriveModes(): void {
    const bar = document.getElementById('drive-modes');
    if (!bar) return;
    for (const button of bar.querySelectorAll<HTMLButtonElement>('button[data-drive-mode]')) {
      const entry = DRIVE_MODES.find((mode) => mode.id === button.dataset.driveMode);
      button.classList.toggle('active', Boolean(entry && sameSetup(setup, entry.preset.setup)));
    }
  }

  function applyDriveMode(id: string): void {
    const entry = DRIVE_MODES.find((mode) => mode.id === id);
    if (!entry) return;
    // Le bouton allumé et la voiture qui se remonte suffisent : un message
    // plein écran par-dessus la piste serait plus gênant qu'utile.
    applySetup(entry.preset.setup);
  }

  document.getElementById('drive-modes')?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button[data-drive-mode]');
    if (!button) return;
    (button as HTMLButtonElement).blur();
    applyDriveMode(button.getAttribute('data-drive-mode') ?? '');
  });

  function configureAudio(): void {
    if (ridingBike) {
      // One cylinder, one bang every other turn: that is the thumper. The
      // quickshifter is a fuel cut, not a dual-clutch fart.
      audio.configure({
        redline: bikeSpec.redlineRpm,
        cylinders: 1,
        turbo: false,
        exhaustLevel: 1,
        engineLevel: 0,
        transmission: 'quickshift',
      });
      return;
    }
    audio.configure({
      redline: spec.redlineRpm,
      cylinders: carDef.id === 'aventador' ? 12 : 4,
      // The Aventador is the only naturally aspirated car in the garage.
      turbo: carDef.id !== 'aventador' || setup.engine > 0,
      exhaustLevel: setup.exhaust,
      engineLevel: setup.engine,
      transmission: 'dsg',
    });
  }

  /**
   * Wet tarmac: much darker, and glossy enough to catch the sun. The puddles
   * are the part that reads as water from the driving seat, so they are shown
   * and hidden with the same switch.
   */
  function applyWetLook(wet: boolean): void {
    // Darker and glossier, but not metallic: this scene has no environment map,
    // so a high metalness would simply turn the road black.
    materials.asphalt.color.setHex(wet ? WET_ASPHALT_COLOR : DRY_ASPHALT_COLOR);
    materials.asphalt.roughness = wet ? 0.34 : 0.92;
    materials.asphalt.metalness = wet ? 0.03 : 0.02;
    materials.asphaltPad.color.setHex(wet ? WET_PAD_COLOR : DRY_PAD_COLOR);
    materials.asphaltPad.roughness = wet ? 0.36 : 0.88;
    materials.asphaltPad.metalness = wet ? 0.03 : 0.02;
    // Zebra crossings are their own street-kit tiles: tint them with the road
    // or they stay dry-bright on a soaked street.
    for (const material of streetKit.roadMaterials) {
      let dry = streetKitDryColors.get(material);
      if (!dry) {
        dry = material.color.clone();
        streetKitDryColors.set(material, dry);
      }
      material.color.copy(dry);
      if (wet) material.color.multiplyScalar(0.62);
      material.roughness = wet ? 0.4 : 0.82;
    }
    puddles?.setVisible(wet);
  }

  /** Restores the balance the player left for the vehicle they are now on. */
  function applyVehicleMix(): void {
    const mix = mixForVehicle(vehicleMixes, ridingBike ? 'bike' : 'car');
    for (const channel of SOUND_CHANNELS) audio.setChannel(channel, mix[channel]);
  }

  const garage = new Garage(setup, bikeSetup, carDef, applySetup, applyBikeSetup);
  // Le showroom choisit la voiture ; l'atelier ne s'occupe plus que des pièces.
  const showroom = new Showroom(
    setup,
    carDef,
    (id) => {
      void selectCar(id);
    },
    (id) => {
      void driveCar(id);
    },
    () => {
      if (paused && mode !== 'menu') pause.classList.remove('hidden');
    },
  );

  /** Swaps the model, then the physics footprint that goes with it. */
  async function selectCar(id: CarId): Promise<void> {
    const def = CARS.find((entry) => entry.id === id);
    if (!def || (def.id === carDef.id && !ridingBike)) {
      showroom.clearPending(id);
      return;
    }
    showroom.markLoading(id);
    let next: CarVisual;
    try {
      next = await loadCarVisual(def, resolveSpec(setup, def.spec));
    } catch (error) {
      console.error(error);
      showroom.clearPending(id);
      hud.flash('Modèle indisponible', { duration: 1600 });
      return;
    }
    scene.remove(car.group);
    car.dispose?.();
    car = next;
    carIsModel = true;
    carDef = def;
    saveCarId(def.id);
    scene.add(car.group);
    if (ridingBike) leaveBike();
    car.group.visible = true;
    rebuildVehicle();
    garage.setCar(def);
    showroom.setCar(def);
    hud.flash(def.label, { duration: 1200 });
  }

  function openGarage(): void {
    if (mode !== 'menu' && !paused) togglePause();
    // The panel tunes whatever is in the garage: two wheels or four.
    if (ridingBike) garage.openBike(bikeSetup);
    else garage.open(setup);
  }

  /** L'écran de sélection : il montre la voiture, l'atelier la règle. */
  function openShowroom(): void {
    if (mode !== 'menu' && !paused) togglePause();
    // Le showroom est au premier plan, pas dessiné à travers le menu pause.
    // Garder la voiture en pause pendant le choix évite aussi qu'elle reparte
    // sous le doigt lorsque le modèle sélectionné finit de charger.
    if (paused) pause.classList.add('hidden');
    showroom.open(setup);
  }

  /** « Conduire » depuis le showroom : on charge, puis on rend le volant. */
  async function driveCar(id: CarId): Promise<void> {
    const fromMenu = mode === 'menu';
    await selectCar(id);
    showroom.close();
    if (fromMenu) startMode('free');
    else if (paused) togglePause();
  }

  function openSound(): void {
    if (mode !== 'menu' && !paused) togglePause();
    // One panel at a time: the menu behind the mix would otherwise show
    // through the card and blur its own buttons.
    soundReturn = null;
    if (mode === 'menu' && !menu.classList.contains('hidden')) soundReturn = menu;
    else if (paused && !pause.classList.contains('hidden')) soundReturn = pause;
    soundReturn?.classList.add('hidden');
    audioPanel.open(audio.soundMix);
  }

  function closeSound(): void {
    audioPanel.close();
    soundReturn?.classList.remove('hidden');
    soundReturn = null;
  }

  /** Bascule de carte : un rechargement, la ville ne suit pas la piste. */
  function openMap(id: MapId): void {
    audio.init();
    window.location.href = mapUrl(id, window.location.href);
  }

  /**
   * Le menu d'une carte de circuit ne propose que ce qui y existe : la piste,
   * l'atelier, le son et le retour en ville. Les départs de la ville (course,
   * col, rallye, sommet) sont masqués par la classe `map-track`.
   */
  function applyTrackMenu(): void {
    document.body.classList.add('map-track');
    if (SUZUKA_MAP) document.body.classList.add('map-suzuka');
    if (FLAT_MAP) document.body.classList.add('map-sp95');
    const labels: Record<string, string> = {
      'btn-free': 'Piste · ligne des stands',
      'btn-pause-free': 'Piste · ligne des stands',
      'btn-circuit': 'Retour en ville',
    };
    if (FLAT_MAP) {
      labels['btn-flat'] = 'Relancer la piste';
      labels['btn-pause-flat'] = 'Circuit · SP95';
    }
    for (const [id, label] of Object.entries(labels)) {
      const button = document.getElementById(id);
      if (button) button.textContent = label;
    }
  }

  /**
   * Menu de la carte du col : elle n'a ni course, ni rallye, ni sommet — les
   * boutons correspondants sont cachés par `body.map-col`. Le départ libre se
   * prend au pied de la route, et le circuit ramène en ville.
   */
  function applyMapMenu(): void {
    document.body.classList.add('map-col');
    const labels: Record<string, string> = {
      'btn-free': 'Col · pied de la route',
      'btn-pause-free': 'Col · pied de la route',
      'btn-circuit': 'Retour en ville',
    };
    for (const [id, label] of Object.entries(labels)) {
      const button = document.getElementById(id);
      if (button) button.textContent = label;
    }
  }

  document.getElementById('btn-free')?.addEventListener('click', () => startMode('free'));
  document.getElementById('btn-moto')?.addEventListener('click', () => void startBikeMode());
  document.getElementById('btn-pause-moto')?.addEventListener('click', () => void startBikeMode());
  document.getElementById('btn-race')?.addEventListener('click', () => startMode('race'));
  document.getElementById('btn-garage')?.addEventListener('click', openGarage);
  document.getElementById('btn-pause-garage')?.addEventListener('click', openGarage);
  document.getElementById('btn-cars')?.addEventListener('click', openShowroom);
  document.getElementById('btn-pause-cars')?.addEventListener('click', openShowroom);
  document.getElementById('btn-sound')?.addEventListener('click', openSound);
  document.getElementById('btn-pause-sound')?.addEventListener('click', openSound);
  document.getElementById('btn-col')?.addEventListener('click', () => startMode('free', 'col'));
  // La carte dédiée au col : un rechargement, comme les circuits.
  document.getElementById('btn-colmap')?.addEventListener('click', () => openMap('col'));
  // Le circuit a sa propre carte : le bouton y bascule, et en revient.
  document
    .getElementById('btn-circuit')
    ?.addEventListener('click', () => openMap(TRACK_MAP || MOUNTAIN_MAP ? 'ville' : 'suzuka'));
  // La piste plate du jeu, joignable depuis n'importe quelle carte.
  document
    .getElementById('btn-flat')
    ?.addEventListener('click', () => (FLAT_MAP ? startMode('free', 'circuit') : openMap('sp95')));
  document
    .getElementById('btn-pause-flat')
    ?.addEventListener('click', () => (FLAT_MAP ? startMode('free', 'circuit') : openMap('sp95')));
  document.getElementById('btn-pause-col')?.addEventListener('click', () => startMode('free', 'col'));
  document.getElementById('btn-rally')?.addEventListener('click', () => startMode('free', 'rally'));
  document.getElementById('btn-pause-rally')?.addEventListener('click', () => startMode('free', 'rally'));
  document.getElementById('btn-sommet')?.addEventListener('click', () => startMode('free', 'summit'));
  document.getElementById('btn-pause-sommet')?.addEventListener('click', () => startMode('free', 'summit'));
  document.getElementById('btn-resume')?.addEventListener('click', () => togglePause());
  document.getElementById('btn-pause-tcs')?.addEventListener('click', () => setTcs(!tcsEnabled));
  document.getElementById('btn-pause-abs')?.addEventListener('click', () => setAbs(!absEnabled));
  // The HUD chip is a button too: switching the assist must not need a pause.
  // It drops focus on use, otherwise Space (the handbrake) would press it again.
  document.getElementById('tcs-chip')?.addEventListener('click', (event) => {
    (event.currentTarget as HTMLElement).blur();
    setTcs(!tcsEnabled);
  });
  document.getElementById('abs-chip')?.addEventListener('click', (event) => {
    (event.currentTarget as HTMLElement).blur();
    setAbs(!absEnabled);
  });
  /** Dumps the clutch: the kick, then the clack of the lever letting go. */
  function triggerWheelie(): void {
    if (!ridingBike || !bike) return;
    const bavette = bike.pitch > 0.45;
    audio.init();
    if (bike.popWheelie()) audio.clutchBang(bavette ? 0.7 : 1);
  }

  document.getElementById('wheelie-chip')?.addEventListener('click', (event) => {
    (event.currentTarget as HTMLElement).blur();
    triggerWheelie();
  });
  // The touch handbrake doubles as the wheelie button on the bike.
  document.getElementById('touch-handbrake')?.addEventListener('pointerdown', () => {
    triggerWheelie();
  });
  document.getElementById('btn-pause-free')?.addEventListener('click', () => startMode('free', freeSpawn));
  document.getElementById('btn-pause-race')?.addEventListener('click', () => startMode('race'));
  document.getElementById('touch-menu-btn')?.addEventListener('click', () => togglePause());
  document.getElementById('touch-cars-btn')?.addEventListener('click', () => {
    if (mode !== 'menu') openShowroom();
  });
  document.getElementById('btn-pause-menu')?.addEventListener('click', () => {
    mode = 'menu';
    paused = false;
    race = null;
    timedLap = false;
    hud.setChrono(false);
    pause.classList.add('hidden');
    hudElement.classList.add('hidden');
    menu.classList.remove('hidden');
    hud.setMode('menu');
    hud.hideMessage();
    drift.reset();
    setCarPose(startPose.x, startPose.z, startPose.heading);
    updateMenuBest();
  });

  const unlockAudio = () => audio.init();
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  // F9 : le maillage de collision sous les yeux. C'est l'outil de diagnostic des
  // trous de piste — un endroit où le treillis manque est un endroit où la
  // voiture passe à travers.
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'F9') return;
    event.preventDefault();
    hud.flash(toggleCollisionView() ? 'Collisions affichées' : 'Collisions masquées', {
      duration: 1600,
    });
  });

  window.addEventListener('resize', () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    composer?.setSize(width, height);
  });

  // If the GPU process resets, three can rebuild its resources as long as the
  // default behaviour is cancelled, and the canvas stops flashing black.
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    if (mode !== 'menu') togglePause();
    hud.flash('Pilote graphique réinitialisé', { duration: 2200 });
  });
  canvas.addEventListener('webglcontextrestored', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  refreshMenuBest();
  syncDriveModes();
  setCarPose(startPose.x, startPose.z, startPose.heading);
  if (TRACK_MAP) applyTrackMenu();
  if (MOUNTAIN_MAP) applyMapMenu();
  await setLoading(1, 'Prêt');
  await new Promise((resolve) => setTimeout(resolve, 220));
  loading.classList.add('done');
  window.setTimeout(() => loading.classList.add('hidden'), 500);
  menu.classList.remove('hidden');

  // L'atelier finit d'arriver *après* le menu : la partie ne doit pas attendre
  // 3,6 Mo de modèles. Les boxes se meublent une seconde plus tard, collisions
  // comprises, et personne ne roule encore dedans à ce moment-là.
  if (propsPromise) {
    void propsPromise
      .then((props) => {
        console.log(
          `Stands SP95 : ${props.models} modèles, ${props.meshes} maillages, ` +
            `${props.triangles} triangles, ${props.colliders} collisions ` +
            `en ${Math.round(props.loadMs)} ms`,
        );
      })
      .catch((error) => console.warn('Atelier des stands indisponible', error));
  }

  function simulate(dt: number, controls: VehicleInput): void {
    const locked = race ? race.locked : false;
    // Handbrake only: holding the brake would engage reverse during the
    // countdown. The vehicle's parking hold keeps the car still.
    const carInput: VehicleInput = locked
      ? { throttle: 0, brake: 0, steer: 0, handbrake: true }
      : controls;

    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED && steps < 8) {
      const before = vehicle.state;
      physPrevious.x = before.position.x;
      physPrevious.y = before.position.y;
      physPrevious.z = before.position.z;
      physPrevious.qx = before.rotation.x;
      physPrevious.qy = before.rotation.y;
      physPrevious.qz = before.rotation.z;
      physPrevious.qw = before.rotation.w;
      vehicle.step(FIXED, carInput, world);
      world.step();
      accumulator -= FIXED;
      steps++;
    }
    if (steps >= 8) accumulator = 0;

    // Filet de dernier recours : si la caisse est passée sous la piste — un
    // châssis qui traverse une dalle mince, un trou entre deux tuiles — on la
    // repose sur place, au lieu de la laisser tomber dans le vide.
    const state = vehicle.state;
    const floor = floorLookup(state.position.x, state.position.z);
    if (floor !== null && state.position.y < floor - FALL_RECOVERY_DEPTH) {
      const yaw = Math.atan2(
        2 * (state.rotation.w * state.rotation.y),
        1 - 2 * state.rotation.y * state.rotation.y,
      );
      setCarPose(state.position.x, state.position.z, yaw);
      hud.flash('Réapparition', { duration: 700 });
      return;
    }

    const telemetry = vehicle.telemetryState;

    // A rolling memory of poses for the replay. It never stores the physics
    // state, so playing a replay back cannot feed the simulation. The visual
    // bits ride along: without them the model would slide with frozen wheels.
    const pose = vehicle.state;
    replayMemory.record(
      {
        x: pose.position.x,
        y: pose.position.y,
        z: pose.position.z,
        qx: pose.rotation.x,
        qy: pose.rotation.y,
        qz: pose.rotation.z,
        qw: pose.rotation.w,
        vx: pose.velocity.x,
        vy: pose.velocity.y,
        vz: pose.velocity.z,
        visual: {
          wheels: telemetry.wheels.map((wheel) => ({
            suspension: wheel.suspensionLength,
            steer: wheel.steer,
            spin: wheel.spinAngle,
          })),
          brake: telemetry.brake,
          reverse: telemetry.gear === -1,
          lean: bike?.lean ?? 0,
          pitch: bike?.pitch ?? 0,
        },
      },
      performance.now() / 1000,
    );

    const speed = telemetry.speed;
    const crash = lastSpeed - speed > 4.2 && lastSpeed > 9 && performance.now() / 1000 - lastCrashTime > 0.4;
    if (crash) {
      lastCrashTime = performance.now() / 1000;
      audio.impact(Math.min(1, (lastSpeed - speed) / 14));
    }
    lastSpeed = speed;

    if (ridingBike) {
      const stuntEvent = stunt.update(
        dt,
        telemetry.pitch ?? 0,
        telemetry.speed,
        !telemetry.airborne,
        crash || Boolean(telemetry.looped),
      );
      if (stuntEvent.banked > 0) {
        hud.flash(`+${stuntEvent.banked}`, { accent: true, duration: 950 });
      } else if (stuntEvent.lost) {
        hud.flash('Wheelie perdu', { duration: 900 });
      }
      if (telemetry.looped) {
        hud.flash('Looping !', { duration: 1100 });
        audio.impact(0.55);
      }
    } else {
      const driftEvent = drift.update(
        dt,
        telemetry.speed,
        telemetry.slipAngle,
        !telemetry.airborne,
        crash,
      );
      if (driftEvent.banked > 0) {
        hud.flash(`+${driftEvent.banked}`, { accent: true, duration: 950 });
      } else if (driftEvent.lost) {
        hud.flash('Dérapage perdu', { duration: 900 });
      }
    }

    if (race) {
      const carPos = vehicle.position;
      const event = race.update(dt, new THREE.Vector3(carPos.x, carPos.y, carPos.z));
      if (event === 'beep') audio.impact(0.12);
      if (event === 'go') {
        hud.flash('GO !', { accent: true, duration: 800 });
      } else if (event === 'lap') {
        hud.flash(`Tour ${race.lap} / ${race.totalLaps}`, { duration: 1200 });
        updateMenuBest();
      } else if (event === 'finish') {
        hud.flash('Course terminée', { accent: true, duration: 2400 });
        updateMenuBest();
      } else if (race.phase === 'countdown') {
        const count = Math.ceil(race.countdown);
        hud.updateRace(race.snapshot());
        if (count > 0 && count < 4) {
          const label = String(count);
          if (hudElement.dataset.count !== label) {
            hudElement.dataset.count = label;
            hud.flash(label, { duration: 700 });
          }
        }
      }
    }

    // Le chrono tourne dans la simulation, pas dans le rendu : un tour compte
    // les secondes réellement simulées, pause et replay exclus.
    if (chrono && timedLap) {
      const pos = vehicle.position;
      const chronoEvent = chrono.update(dt, pos.x, pos.z, telemetry.speed);
      if (sectors) {
        if (chronoEvent === 'start') sectors.arm();
        // Distance depuis la ligne, ramenée dans [0, longueur du tour).
        const covered = trackDistanceAt(pos.x, pos.z) - CHRONO_LINE_OFFSET;
        const lapDistance = ((covered % TRACK.length) + TRACK.length) % TRACK.length;
        sectors.update(dt, lapDistance);
        if (chronoEvent === 'lap') sectors.completeLap(chrono.last);
      }
      if (chronoEvent === 'start') {
        driftLapBase = drift.total;
        hud.flash('Chrono lancé', { accent: true, duration: 1200 });
      } else if (chronoEvent === 'lap') {
        if (driftMode) {
          // En drift, le résultat du tour est le total de points bankés depuis
          // la ligne, pas les secondes.
          const points = Math.max(0, Math.round(drift.total - driftLapBase));
          driftLapBase = drift.total;
          const record = driftBestLap === null || points > driftBestLap;
          if (record) {
            driftBestLap = points;
            try {
              localStorage.setItem('sp95.driftBestLap', String(points));
            } catch {
              // Stockage refusé : le record reste valable pour la session.
            }
          }
          hud.flash(
            `Tour ${chrono.lap - 1} · ${points} pts${record ? ' · record' : ''}`,
            { accent: record, duration: 2100 },
          );
          updateMenuBest();
        } else {
          const isBest = chrono.best !== null && chrono.last <= chrono.best + 1e-6;
          hud.flash(
            `Tour ${chrono.lap - 1} · ${formatLap(chrono.last)}${isBest ? ' · meilleur' : ''}`,
            { accent: isBest, duration: 2100 },
          );
          updateMenuBest();
        }
      }
    }

    if (vehicle.isFlipped || vehicle.position.y < -25) {
      respawn();
    }

    audio.update({
      rpm: telemetry.rpm,
      throttle: controls.throttle,
      speed: telemetry.speed,
      slip: vehicle.rearSlipIntensity(),
      gear: telemetry.gear,
      grounded: !telemetry.airborne,
      limiter: telemetry.limiter,
      roughness: telemetry.surface.roughness,
      offRoad: telemetry.surface.kind !== 'asphalte',
    });

    // Stones under the sills when a wheel is on loose ground.
    gravelTimer -= dt;
    if (gravelTimer <= 0 && telemetry.surface.kind === 'terre' && speed > 4) {
      gravelTimer = 0.12 + Math.random() * 0.25;
      audio.gravelTick();
    }
  }

  /**
   * Replays the recent poses. The simulation is frozen and scoring is not
   * touched, so leaving the replay puts the player back exactly where the car
   * actually is, score included.
   */
  function toggleReplay(): void {
    if (replay) {
      stopReplay();
      return;
    }
    const poses = replayMemory.snapshot();
    if (poses.length < 2 || poses[poses.length - 1].t < 0.4) {
      hud.flash('Rien à rejouer encore', { duration: 900 });
      return;
    }
    replay = { poses, elapsed: 0, bike: ridingBike };
    // The camera starts where the car was looking, then keeps that world angle:
    // it must not swing round with the recorded car while the player aims it.
    replayCamYaw = Math.atan2(-carForward.x, -carForward.z);
    replayCamOrbit = input.orbitYaw;
    hud.flash('Replay · souris ou Q/E pour tourner', { accent: true, duration: 1500 });
  }

  function stopReplay(): void {
    if (!replay) return;
    replay = null;
    // Hand the chase camera back its normal range.
    input.orbitMax = 2.6;
    input.orbitYaw = Math.max(-2.6, Math.min(2.6, input.orbitYaw));
    hud.flash('Replay terminé', { duration: 700 });
  }

  /**
   * Rewind: the car walks back along the poses it actually drove, body and
   * all. The simulation is frozen meanwhile, so nothing moves but the clock.
   */
  function startRewind(): void {
    if (replay || rewind) return;
    const poses = replayMemory.snapshot();
    if (poses.length < 2) return;
    rewind = { poses, elapsed: poses[poses.length - 1].t };
    hud.flash('Rewind', { accent: true, duration: 900 });
  }

  function stepRewind(dt: number): void {
    if (!rewind) return;
    rewind.elapsed = Math.max(0, rewind.elapsed - dt * REWIND_RATE);
    const pose = samplePoses(rewind.poses, rewind.elapsed);
    if (!pose) return;
    replayQuat.set(pose.qx, pose.qy, pose.qz, pose.qw);
    carForward.set(0, 0, -1).applyQuaternion(replayQuat);
    // Heading only: the chassis is a yaw body, and respawn also clears the
    // velocities so the car does not shoot off when the key is released.
    vehicle.respawn(pose.x, pose.y, pose.z, Math.atan2(-carForward.x, -carForward.z));
  }

  function endRewind(): void {
    if (!rewind) return;
    const pose = samplePoses(rewind.poses, rewind.elapsed);
    // The rewind ate the poses ahead of the cursor: recording continues there.
    replayMemory.truncate(rewind.elapsed, performance.now() / 1000);
    rewind = null;
    accumulator = 0;
    if (!pose) return;
    // Hand the car back at the speed it actually carried at that instant,
    // instead of dropping it to a standstill.
    vehicle.setVelocity(pose.vx ?? 0, pose.vy ?? 0, pose.vz ?? 0);
  }

  /** Période des cadrans et de la mini-carte, en secondes. */
  const HUD_INTERVAL = 1 / 12;
  let hudClock = 0;

/** Quaternion de travail de l'interpolation du rendu. */
  const prevQuat = new THREE.Quaternion();

  /**
   * États de roue réutilisés par le replay : il tourne à 60 Hz, une allocation
   * par frame et par roue finirait par se voir sur les machines modestes.
   */
  const replayWheels = [0, 1, 2, 3].map(() => ({
    suspensionLength: 0,
    steer: 0,
    spinAngle: 0,
    contact: true,
  }));

  /** Applique une frame de replay à la voiture, roues et feux compris. */
  function applyCarReplay(visual: VisualPose): void {
    for (let i = 0; i < replayWheels.length; i++) {
      const wheel = visual.wheels[i];
      if (!wheel) continue;
      const target = replayWheels[i];
      target.suspensionLength = wheel.suspension;
      target.steer = wheel.steer;
      target.spinAngle = wheel.spin;
    }
    updateCarVisual(
      car,
      carPosition,
      replayQuat,
      replayWheels,
      visual.brake > 0.1,
      visual.reverse,
    );
  }

  /** Applique une frame de replay à la moto : inclinaison, suspension, spin. */
  function applyBikeReplay(visual: VisualPose): void {
    if (!bikeVisual) return;
    const front = visual.wheels[0];
    const rear = visual.wheels[1];
    const rest = bike?.restLength ?? 0.3;
    bikeVisual.setPose({
      lean: visual.lean,
      pitch: visual.pitch,
      steer: front?.steer ?? 0,
      rearSuspension: rear?.suspension ?? rest,
      frontSuspension: front?.suspension ?? rest,
      restLength: rest,
      wheelRadius: bikeSpec.wheelRadius,
      // Le replay est joué sur une piste plate : aucune pente à relire.
      slopePitch: 0,
      slopeRoll: 0,
      accel: 0,
      brake: visual.brake,
      time: performance.now() / 1000,
    });
    bikeVisual.setSpin(front?.spin ?? 0, rear?.spin ?? 0);
    bikeVisual.setBrake(visual.brake > 0.1);
  }

  /**
   * La caméra du replay. Elle vivait après le `return` du chemin de replay :
   * elle ne tournait donc jamais, et la caméra restait figée sur la dernière
   * image de conduite. Elle est appelée directement depuis ce chemin.
   */
  function updateReplayCamera(dt: number): void {
    const turn = (input.isDown('KeyE') ? 1 : 0) - (input.isDown('KeyQ') ? 1 : 0);
    replayCamYaw += turn * dt * 1.5;
    const ground = groundAt(carPosition.x, carPosition.z);
    const lookY = carPosition.y + 0.7;
    // La souris tourne la caméra dans *toutes* les vues du replay, pas
    // seulement en poursuite : un angle figé n'est pas un replay.
    const yaw = replayCamYaw + (input.orbitYaw - replayCamOrbit);
    const pitch = Math.max(-0.2, Math.min(1.2, 0.24 + input.orbitPitch));
    if (replayView === 'tv') {
      const angle = yaw + Math.PI * 0.62;
      const distance = 17;
      camera.position.set(
        carPosition.x + Math.sin(angle) * distance,
        Math.max(ground + 5 + pitch * 10, carPosition.y + 7),
        carPosition.z + Math.cos(angle) * distance,
      );
      camera.lookAt(carPosition.x, lookY, carPosition.z);
    } else if (replayView === 'onboard') {
      // Embarquée : la souris tourne la tête du pilote sans sortir du cockpit.
      const look = yaw - replayCamYaw;
      const cos = Math.cos(look);
      const sin = Math.sin(look);
      const dx = carForward.x * cos + carForward.z * sin;
      const dz = -carForward.x * sin + carForward.z * cos;
      camera.position.set(
        carPosition.x - carForward.x * 1.35,
        carPosition.y + 1.18,
        carPosition.z - carForward.z * 1.35,
      );
      camera.lookAt(
        camera.position.x - dx * 30,
        camera.position.y - 0.55 + pitch * 6,
        camera.position.z - dz * 30,
      );
    } else if (replayView === 'trackside') {
      // Posée au bord de la piste : la voiture passe. La souris fait pivoter
      // le regard autour du point de pose, sinon cette vue serait la seule que
      // le joueur ne peut pas orienter.
      if (Math.hypot(carPosition.x - replayTrackside.x, carPosition.z - replayTrackside.z) > 45) {
        placeReplayTrackside();
      }
      camera.position.copy(replayTrackside);
      const base = Math.atan2(
        carPosition.x - replayTrackside.x,
        carPosition.z - replayTrackside.z,
      );
      const angle = base + (input.orbitYaw - replayCamOrbit);
      const reach = 30;
      camera.lookAt(
        replayTrackside.x + Math.sin(angle) * reach,
        replayTrackside.y + (pitch - 0.24) * reach,
        replayTrackside.z + Math.cos(angle) * reach,
      );
    } else {
      // Poursuite libre : la souris choisit l'angle, la molette la distance.
      const distance = Math.max(2.2, 6.2 + input.zoom * 1.6);
      const horizontal = Math.cos(pitch) * distance;
      camera.position.set(
        carPosition.x + Math.sin(yaw) * horizontal,
        Math.max(ground + 0.5, carPosition.y + Math.sin(pitch) * distance + 0.55),
        carPosition.z + Math.cos(yaw) * horizontal,
      );
      camera.lookAt(carPosition.x, lookY, carPosition.z);
    }
    const replayFov = replayView === 'onboard' ? 64 : replayView === 'tv' ? 45 : 58;
    camera.fov += (replayFov - camera.fov) * Math.min(1, dt * 6);
    camera.updateProjectionMatrix();
  }

  function updateVisuals(dt: number): void {
    if (replay) {
      const pose = samplePoses(replay.poses, replay.elapsed);
      if (pose) {
        replayQuat.set(pose.qx, pose.qy, pose.qz, pose.qw);
        carPosition.set(pose.x, pose.y, pose.z);
        carForward.set(0, 0, -1).applyQuaternion(replayQuat);
        const group = replay.bike && bikeVisual ? bikeVisual.group : car.group;
        group.position.copy(carPosition);
        group.quaternion.copy(replayQuat);
        if (pose.visual) {
          if (replay.bike && bikeVisual) applyBikeReplay(pose.visual);
          else applyCarReplay(pose.visual);
        }
      }
      // La caméra doit suivre les poses rejouées : sans cet appel, le `return`
      // laissait l'image figée sur la dernière frame de conduite.
      updateReplayCamera(dt);
      return;
    }
    const telemetry = vehicle.telemetryState;
    const state = vehicle.state;
    // Rendu interpolé entre les deux derniers pas fixes : sans ça, la voiture
    // saute d'un pas à l'autre dès que la cadence baisse.
    const alpha = Math.min(1, Math.max(0, accumulator / FIXED));
    carPosition.set(
      physPrevious.x + (state.position.x - physPrevious.x) * alpha,
      physPrevious.y + (state.position.y - physPrevious.y) * alpha,
      physPrevious.z + (state.position.z - physPrevious.z) * alpha,
    );
    visualQuat.set(state.rotation.x, state.rotation.y, state.rotation.z, state.rotation.w);
    prevQuat.set(physPrevious.qx, physPrevious.qy, physPrevious.qz, physPrevious.qw);
    prevQuat.slerp(visualQuat, alpha);
    visualQuat.copy(prevQuat);
    carForward.set(0, 0, -1).applyQuaternion(visualQuat);

    if (ridingBike && bike && bikeVisual) {
      bikeVisual.group.position.set(state.position.x, state.position.y, state.position.z);
      bikeVisual.group.quaternion.set(
        state.rotation.x,
        state.rotation.y,
        state.rotation.z,
        state.rotation.w,
      );

      // The physics body only ever yaws, so the ground normal under the tires
      // is what tells the visual about the hill. Average the two contact
      // normals (a wheelie leaves only the rear one), rotate them into the
      // bike's own frame, and smooth them: a raycast normal jitters on gravel
      // and the bike would shiver.
      slopeNormal.set(0, 0, 0);
      let slopeSamples = 0;
      for (const wheel of telemetry.wheels) {
        if (!wheel.contact || !wheel.contactNormal) continue;
        slopeNormal.x += wheel.contactNormal.x;
        slopeNormal.y += wheel.contactNormal.y;
        slopeNormal.z += wheel.contactNormal.z;
        slopeSamples++;
      }
      let targetPitch = 0;
      let targetRoll = 0;
      if (slopeSamples > 0) {
        slopeNormal.normalize();
        bodyQuat.set(state.rotation.x, state.rotation.y, state.rotation.z, state.rotation.w).invert();
        localNormal.copy(slopeNormal).applyQuaternion(bodyQuat);
        targetPitch = Math.atan2(localNormal.z, localNormal.y);
        targetRoll = Math.atan2(localNormal.x, localNormal.y);
      }
      const slopeRate = Math.min(1, dt * (slopeSamples > 0 ? 9 : 2.5));
      slopeState.pitch += (targetPitch - slopeState.pitch) * slopeRate;
      slopeState.roll += (targetRoll - slopeState.roll) * slopeRate;

      const rearSuspension = telemetry.wheels[1]?.suspensionLength ?? bike.restLength;
      const frontSuspension = telemetry.wheels[0]?.suspensionLength ?? bike.restLength;
      bikeVisual.setPose({
        lean: bike.lean,
        pitch: bike.pitch,
        steer: bike.steer,
        rearSuspension,
        frontSuspension,
        restLength: bike.restLength,
        wheelRadius: bikeSpec.wheelRadius,
        slopePitch: slopeState.pitch,
        slopeRoll: slopeState.roll,
        accel: bike.longAccel,
        brake: telemetry.brake,
        // The rider's idle motion runs on wall time: it must keep breathing
        // while the bike is moving, not only in the menu.
        time: performance.now() / 1000,
      });
      bikeVisual.setSpin(
        telemetry.wheels[0]?.spinAngle ?? 0,
        telemetry.wheels[1]?.spinAngle ?? 0,
      );
      bikeVisual.setBrake(telemetry.brake > 0.1 && telemetry.speed > 0.5);
    } else {
      updateCarVisual(
        car,
        carPosition,
        visualQuat,
        telemetry.wheels,
        telemetry.brake > 0.1 && telemetry.speed > 0.5,
        telemetry.gear === -1,
      );
    }

    // Tire smoke and gravel dust. A wheel smokes once it slips, which is the
    // only honest signal that the tires are spinning up or sliding: straight
    // line driving never emits, and a burnout at walking pace still will.
    carVelocity.set(state.velocity.x, state.velocity.y, state.velocity.z);
    if (mode !== 'menu' && !paused && !rewind && telemetry.speed > 1.5) {
      for (let i = 0; i < telemetry.wheels.length; i++) {
        const wheel = telemetry.wheels[i];
        const slip = Math.hypot(wheel.slipRatio * 1.15, wheel.slipAngle);
        const spray = sprayActive(telemetry.speed, wheel.contact) && wheel.name.startsWith('R');
        if (!spray && (!wheel.contact || slip < 0.2)) {
          smokeDebt[i] = 0;
          continue;
        }
        const load = Math.min(1, wheel.load / 5200);
        const bite = Math.min(1, (slip - 0.2) / 0.6);
        // Standing water sprays even when the tire grips, so its rate does not
        // depend on slip the way tire smoke does.
        const rate = spray ? 46 : 16 + 100 * Math.pow(bite, 1.4);
        smokeDebt[i] += dt * rate * (0.4 + load * 0.6);
        while (smokeDebt[i] >= 1) {
          smokeDebt[i] -= 1;
          const surface = surfaceAt(wheel.worldPosition.x, wheel.worldPosition.z).kind;
          smokeTint.copy(spray ? SMOKE_SPRAY : surface === 'asphalte' ? SMOKE_WHITE : SMOKE_DUST);
          const intensity = spray ? 0.6 : Math.min(1, 0.35 + slip * 1.1);
          smokeFx.emit(
            wheel.worldPosition.x + (Math.random() - 0.5) * 0.34,
            wheel.worldPosition.y - wheel.suspensionLength + 0.05,
            wheel.worldPosition.z + (Math.random() - 0.5) * 0.34,
            carVelocity.x * 0.24 + (Math.random() - 0.5) * 1.2,
            0.35 + Math.random() * 0.7,
            carVelocity.z * 0.24 + (Math.random() - 0.5) * 1.2,
            intensity,
            smokeTint,
          );
        }
      }
    } else {
      smokeDebt.fill(0);
    }

    // Sparks on a bavette: the tail unit is the lowest point once the bike is
    // past a certain angle, and it grinds along the tarmac behind the rear tire.
    if (ridingBike && bike && bikeVisual && mode !== 'menu' && !paused) {
      const pitch = telemetry.pitch ?? 0;
      const scraping = pitch > BAVETTE_ANGLE && Boolean(telemetry.wheels[1]?.contact) && telemetry.speed > 4;
      if (scraping) {
        bikeVisual.plateWorldPosition(platePoint);
        const ground = groundAt(platePoint.x, platePoint.z);
        const strength = Math.min(1, (pitch - BAVETTE_ANGLE) / 0.3);
        sparkDebt += dt * (80 + strength * 220);
        while (sparkDebt >= 1) {
          sparkDebt -= 1;
          sparkFx.emit(
            platePoint.x,
            Math.max(ground + 0.02, Math.min(platePoint.y, ground + 0.22)),
            platePoint.z,
            state.velocity.x * 0.55,
            0.5 + Math.random() * 1.6,
            state.velocity.z * 0.55,
            strength,
          );
        }
        scrapeTimer -= dt;
        if (scrapeTimer <= 0) {
          scrapeTimer = 0.075;
          audio.scrape(strength);
        }
      } else {
        sparkDebt = 0;
        scrapeTimer = 0;
      }
    }

    for (const lamp of headlamps) {
      const side = lamp.userData.side as number;
      lamp.position.set(carPosition.x - carForward.z * side, carPosition.y + 0.65, carPosition.z + carForward.x * side)
        .addScaledVector(carForward, ridingBike ? 0.6 : 1.8);
      lamp.target.position.copy(lamp.position).addScaledVector(carForward, 48);
      lamp.target.position.y -= 1.5;
      lamp.target.updateMatrixWorld();
    }

    lightPos.copy(carPosition).addScaledVector(sky.sunDirection, 260);
    sky.sun.position.copy(lightPos);
    sky.sun.target.position.copy(carPosition);
    sky.sun.target.updateMatrixWorld();

    syncProps(props);
    if (mode === 'menu') {
      menuTime += dt;
      const radius = 10.5;
      const angle = menuTime * 0.14 + 0.6;
      const ground = groundAt(startPose.x, startPose.z);
      camera.position.set(
        startPose.x + Math.cos(angle) * radius,
        ground + 3.4 + Math.sin(menuTime * 0.25) * 0.35,
        startPose.z + Math.sin(angle) * radius,
      );
      camera.lookAt(startPose.x, ground + 0.55, startPose.z);
      camera.fov += (52 - camera.fov) * Math.min(1, dt * 2);
      camera.updateProjectionMatrix();
    } else if (freeCamera) {
      camera.position.copy(freeCamera.pos);
      camera.lookAt(freeCamera.target);
      camera.fov = 55;
      camera.updateProjectionMatrix();
    } else if (replay) {
      updateReplayCamera(dt);
    } else {
      chase.update(
        dt,
        carPosition,
        carForward,
        telemetry.speed,
        input.orbitYaw,
        input.orbitPitch,
        input.zoom,
        cameraGround,
        cameraClearance,
        ridingBike ? 'bike' : 'car',
      );
      if (MOUNTAIN_MAP && !paused) {
        const vibration = Math.min(1, telemetry.rpm / (ridingBike ? bikeSpec.redlineRpm : spec.redlineRpm)) * 0.006
          + Math.min(1, Math.abs(telemetry.speed) / 35) * 0.012;
        const time = performance.now() / 1000;
        camera.position.y += Math.sin(time * 31) * vibration;
        camera.position.x += Math.sin(time * 23) * vibration * 0.45;
      }
    }

    // Point sizes are in pixels: convert from metres at the current fov.
    const fov = (camera.fov * Math.PI) / 180;
    const pixelsPerMeter = renderer.domElement.height / (2 * Math.tan(fov / 2));
    smokeFx.update(dt, pixelsPerMeter);
    sparkFx.update(dt, pixelsPerMeter);

    // Les cadrans changent douze fois par seconde, pas soixante : le temps du
    // processeur revient à la conduite.
    hudClock += dt;
    if (hudClock < HUD_INTERVAL) return;
    hudClock = 0;

    const redline = ridingBike ? bikeSpec.redlineRpm : spec.redlineRpm;
    hud.updateSpeed(telemetry.speedKmh, telemetry.gear, telemetry.rpm, redline);
    if (ridingBike) {
      hud.updateStunt(
        stunt.pending,
        stunt.total,
        stunt.multiplier,
        stunt.active,
        stunt.deep,
        ((telemetry.pitch ?? 0) * 180) / Math.PI,
      );
    } else {
      hud.updateDrift(drift.pending, drift.total, drift.multiplier, drift.active);
    }

    if (mode === 'race' && race) {
      hud.updateRace(race.snapshot(carPosition));
    }
    if (chrono && timedLap) {
      if (driftMode) {
        hud.updateDriftLap(drift.total - driftLapBase, driftBestLap);
      } else {
        hud.updateChrono(chrono.lap, chrono.current, chrono.best);
        if (sectors) hud.updateSectors(sectors.snapshot());
      }
    }

    if (mode !== 'menu') {
      const next = race ? checkpoints[race.next] : null;
      const yaw = Math.atan2(-carForward.x, -carForward.z);
      hud.drawMinimap(carPosition.x, carPosition.z, yaw, next);
    }
  }

  /** Instant de la dernière image calculée (voir FRAME_TARGET). */
  let lastRender = 0;

  function render(): void {
    renderer.info.reset();
    if (composer && motion) {
      motion.damp = mode === 'menu' || paused ? 0 : Math.min(0.42, Math.max(0, (Math.abs(vehicle.telemetryState.speed) - 12) / 60));
      composer.render();
    } else renderer.render(scene, camera);
  }

  function frame(now: number): void {
    requestAnimationFrame(frame);
    // Les battements d'écran plus rapprochés que la cible sont sautés : le temps
    // avance jusqu'à l'image suivante, la physique ne s'en aperçoit pas.
    if (FRAME_TARGET > 0 && now - lastRender < 1000 / FRAME_TARGET - 0.5) return;
    lastRender = now;
    const rawDt = Math.max(0.0001, (now - lastFrame) / 1000);
    const dt = Math.min(0.05, rawDt);
    lastFrame = now;

    fpsFrames++;
    fpsTime += rawDt;
    if (fpsTime > 0.5) {
      fps = Math.round(fpsFrames / fpsTime);
      fpsFrames = 0;
      fpsTime = 0;
    }

    governor?.update(dt);
    const controls = input.update(dt);

    if (input.consume('pause')) {
      if (audioPanel.isOpen) closeSound();
      else if (showroom.isOpen) showroom.close();
      else if (garage.isOpen) garage.close();
      else togglePause();
    }
    if (input.consume('mute')) audio.setMuted(!audio.isMuted);
    if (input.consume('tcs') && mode !== 'menu' && !ridingBike) setTcs(!tcsEnabled);
    if (input.consume('abs') && mode !== 'menu' && !ridingBike) setAbs(!absEnabled);
    if (input.consume('wet') && mode !== 'menu') {
      setWetRoad(!isWetRoad());
      applyWetLook(isWetRoad());
      hud.flash(isWetRoad() ? 'Route mouillée' : 'Route sèche', { duration: 900 });
    }
    if (input.consume('camera') && mode !== 'menu') {
      if (replay) {
        replayView = REPLAY_VIEWS[(REPLAY_VIEWS.indexOf(replayView) + 1) % REPLAY_VIEWS.length];
        if (replayView === 'trackside') placeReplayTrackside();
        hud.flash(replayViewLabel(replayView), { accent: true, duration: 1100 });
      } else {
        hud.flash(cameraModeLabel(chase.nextMode()), { duration: 900 });
      }
    }
    if (mode !== 'menu' && !paused && ridingBike && input.consume('wheelie')) {
      triggerWheelie();
    }
    if (mode !== 'menu' && input.consume('replay')) {
      toggleReplay();
    }

    // Rewind is a held key, not a toggle: it stops exactly where it is let go.
    const wantsRewind =
      mode !== 'menu' && !paused && !replay && input.isDown('KeyX');
    if (wantsRewind && !rewindHeld) startRewind();
    if (!wantsRewind && rewindHeld) endRewind();
    rewindHeld = wantsRewind;
    input.orbitLock = Boolean(replay);
    input.orbitMax = replay ? Math.PI : 2.6;
    if (!replay && mode !== 'menu' && !paused && input.consume('reset')) {
      respawn();
    }

    if (replay) {
      if (!paused) {
        replay.elapsed += dt;
        if (replay.elapsed >= replay.poses[replay.poses.length - 1].t) stopReplay();
      }
    } else if (rewind) {
      if (!paused) stepRewind(dt);
    } else if (mode !== 'menu' && !paused) {
      simulate(dt, controls);
    }
    updateVisuals(dt);
    updateDeer(dt);
    render();
  }

  requestAnimationFrame((now) => {
    lastFrame = now;
    requestAnimationFrame(frame);
  });

  /**
   * Diagnostic d'ombre, appelé depuis `__sp95.debug` : la carte du soleil existe
   *-t-elle, et quels maillages la projettent / la reçoivent ? Le décompte se
   * refait à chaque appel — le compteur ne doit pas se figer avant le chargement
   * de la végétation ou du circuit.
   */
  function shadowProbe(): {
    enabled: boolean;
    casting: boolean;
    mapReady: boolean;
    sunVisible: boolean;
    sunInScene: boolean;
    casters: number;
    castersInFrustum: number;
    receivers: number;
    /** Position du soleil (repère monde). */
    light: [number, number, number];
    /** Étendue de la caméra d'ombre, en mètres. */
    extent: number;
    /** La voiture tombe-t-elle dans le frustum d'ombre, en NDC ? */
    carInside: [number, number, number];
    /** Dessins cumulés émis dans la carte d'ombre depuis le démarrage. */
    passDraws: number;
  } {
    let casters = 0;
    let receivers = 0;
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.castShadow) casters++;
      if (mesh.receiveShadow) receivers++;
    });
    // Ordre obligatoire : monde -> vue (matrixWorldInverse), puis vue -> NDC
    // (projection). Les deux matrices ne commutent pas.
    const shadow = sky.sun.shadow;
    const ndc = carPosition.clone().applyMatrix4(shadow.camera.matrixWorldInverse);
    ndc.applyMatrix4(shadow.camera.projectionMatrix);
    // Combien des projeteurs passent la culling de la passe d'ombre, calculée
    // exactement comme three : frustum = projection × inverse(vue).
    const projScreen = new THREE.Matrix4().multiplyMatrices(
      shadow.camera.projectionMatrix,
      shadow.camera.matrixWorldInverse,
    );
    const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreen);
    let castersInFrustum = 0;
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.castShadow) return;
      if (frustum.intersectsObject(mesh)) castersInFrustum++;
    });
    return {
      enabled: renderer.shadowMap.enabled,
      casting: sky.sun.castShadow,
      mapReady: Boolean(shadow.map),
      sunVisible: sky.sun.visible,
      sunInScene: sky.sun.parent === scene,
      casters,
      castersInFrustum,
      receivers,
      light: [
        Math.round(sky.sun.position.x),
        Math.round(sky.sun.position.y),
        Math.round(sky.sun.position.z),
      ],
      extent: shadow.camera.right,
      carInside: [ndc.x, ndc.y, ndc.z].map((v) => Math.round(v * 100) / 100) as [
        number,
        number,
        number,
      ],
      passDraws: shadowPassDraws,
    };
  }

  // DIAGNOSTIC CYCLE 10 (temporaire) : accès direct à la scène pour sonder le
  // programme compilé du récepteur — la passe d'ombre tourne mais l'image ne
  // bouge pas, il reste à savoir si le matériau contient bien USE_SHADOWMAP.
  (window as unknown as { __sp95three: unknown }).__sp95three = {
    THREE,
    scene,
    renderer,
    sun: sky.sun,
  };

  /**
   * Affiche le maillage exact que lisent les roues : la plaque d'asphalte en
   * cyan (fil de fer), l'herbe et le gravier en ambre. Un trou dans le treillis
   * est un trou de collision — c'est là que la voiture tombe. `?collide` au
   * chargement, F9 en jeu, `__sp95.setCollisionView()` depuis un script.
   */
  let collisionView: THREE.Group | null = null;
  function toggleCollisionView(on?: boolean): boolean {
    if (!collisionView) {
      collisionView = new THREE.Group();
      collisionView.name = 'collision-view';
      const debug = (globalThis as unknown as {
        __sp95Circuit?: {
          flatRoad?: { vertices: Float32Array; indices: Uint32Array };
          offTrack?: { vertices: Float32Array; indices: Uint32Array };
        };
      }).__sp95Circuit;
      const addSurface = (
        surface: { vertices: Float32Array; indices: Uint32Array } | undefined,
        color: number,
        wireframe: boolean,
        lift: number,
      ): void => {
        if (!surface || surface.indices.length === 0) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(surface.vertices.slice(), 3));
        geometry.setIndex(new THREE.BufferAttribute(surface.indices.slice(), 1));
        // Quelques centimètres au-dessus de la surface visible, pour ne pas
        // clignoter contre elle.
        geometry.translate(0, lift, 0);
        collisionView!.add(
          new THREE.Mesh(
            geometry,
            new THREE.MeshBasicMaterial({
              color,
              wireframe,
              transparent: true,
              opacity: wireframe ? 0.9 : 0.14,
              depthWrite: false,
              side: THREE.DoubleSide,
            }),
          ),
        );
      };
      addSurface(debug?.flatRoad, 0x36e0ff, true, 0.03);
      addSurface(debug?.offTrack, 0xffb347, false, 0.05);
      scene.add(collisionView);
    }
    collisionView.visible = on ?? !collisionView.visible;
    return collisionView.visible;
  }
  if (COLLIDE_VIEW) toggleCollisionView(true);

  const debugSurface = {
    ready: true,
    map: MAP,
    groundClearance,
    trackClearance,
    openMap: (id: MapId) => openMap(id),
    get mode() {
      return mode;
    },
    get paused() {
      return paused;
    },
    get speedKmh() {
      return vehicle.telemetryState.speedKmh;
    },
    get gear() {
      return vehicle.telemetryState.gear;
    },
    get rpm() {
      return vehicle.telemetryState.rpm;
    },
    get driftTotal() {
      return drift.total;
    },
    get racePhase() {
      return race?.phase ?? null;
    },
    get raceLap() {
      return race?.lap ?? 0;
    },
    get position() {
      const p = vehicle.position;
      return { x: p.x, y: p.y, z: p.z };
    },
    get camera() {
      return {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        fov: camera.fov,
      };
    },
    get orbit() {
      return { yaw: input.orbitYaw, pitch: input.orbitPitch, active: input.orbitActive };
    },
    get replayView() {
      return replayView;
    },
    get debug() {
      return {
        fps,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        driftPending: drift.pending,
        shadow: shadowProbe(),
        // Permet au script de contrôle de comparer un frame avec et sans passe
        // d'ombre sur la même scène (mesure du coût et de la présence réelle).
        setShadows: (on: boolean) => {
          renderer.shadowMap.enabled = on;
        },
        setCollisionView: (on?: boolean) => toggleCollisionView(on),
      };
    },
    get setup() {
      return { ...setup };
    },
    get bikeSetup() {
      return { ...bikeSetup };
    },
    get bikeSpec() {
      return {
        peakTorque: bikeSpec.peakTorque,
        mass: bikeSpec.mass,
        redline: bikeSpec.redlineRpm,
        looseGrip: bikeSpec.looseGrip,
      };
    },
    get cameraMode() {
      return chase.mode;
    },
    get bikePitch() {
      return bike?.pitch ?? 0;
    },
    get pushingBack() {
      return bike?.pushingBack ?? false;
    },
    get surface() {
      return vehicle.telemetryState.surface.kind;
    },
    get gearFloat() {
      return vehicle.telemetryState.gear;
    },
    get audioEvents() {
      return audio.events;
    },
    get audioSamples() {
      return audio.loadedSamples;
    },
    get drivetrain() {
      const t = vehicle.telemetryState;
      return { gear: t.gear, rpm: t.rpm, limiter: t.limiter, shifting: t.shifting };
    },
    /** Les pédales réellement lues par la physique, pour les scripts de contrôle. */
    get pedals() {
      const t = vehicle.telemetryState;
      return {
        throttle: t.throttle,
        brake: t.brake,
        handbrake: t.handbrake,
        speed: t.speed,
        mode,
        paused,
      };
    },
    get spec() {
      return {
        name: spec.name,
        mass: spec.mass,
        peakTorque: spec.peakTorque,
        maxSteer: spec.maxSteer,
        wheelbase: spec.wheelbase,
        track: spec.track,
        wheelRadius: spec.wheelRadius,
      };
    },
    get garageOpen() {
      return garage.isOpen;
    },
    get showroomOpen() {
      return showroom.isOpen;
    },
    get chrono() {
      return chrono ? chrono.snapshot() : null;
    },
    get timedLap() {
      return timedLap;
    },
    get soundPanelOpen() {
      return audioPanel.isOpen;
    },
    get soundMix() {
      return audio.soundMix;
    },
    get tcs() {
      return tcsEnabled;
    },
    get abs() {
      return absEnabled;
    },
    get streetKit(): StreetKitSummary {
      return streetKit;
    },
    get vegetation(): VegetationSummary {
      return vegetation;
    },
    get roadEnds() {
      return roadEnds().length;
    },
    get neighbourhoods() {
      return { ...NEIGHBOURHOODS };
    },
    get buildings() {
      return { ...BUILDINGS };
    },
    get smoke() {
      return smokeFx.live;
    },
    get redline() {
      return ridingBike ? bikeSpec.redlineRpm : spec.redlineRpm;
    },
    get vehicleKind() {
      return ridingBike ? 'bike' : 'car';
    },
    get stuntTotal() {
      return stunt.total;
    },
    get stuntPending() {
      return stunt.pending;
    },
    get sparks() {
      return sparkFx.live;
    },
    get bikeState() {
      if (!ridingBike || !bike) return null;
      const t = bike.telemetryState;
      return {
        leanDeg: ((t.lean ?? 0) * 180) / Math.PI,
        pitchDeg: ((t.pitch ?? 0) * 180) / Math.PI,
        wheelie: Boolean(t.wheelie),
        bavette: Boolean(t.bavette),
        steerDeg: (bike.steer * 180) / Math.PI,
        rearSuspension: t.wheels[1]?.suspensionLength ?? 0,
        frontSuspension: t.wheels[0]?.suspensionLength ?? 0,
        slopePitchDeg: (slopeState.pitch * 180) / Math.PI,
        slopeRollDeg: (slopeState.roll * 180) / Math.PI,
        wheels: t.wheels.length,
      };
    },
    get carModel() {
      return carIsModel;
    },
    get wheelMounts() {
      return car.wheels.map((wheel) => ({ x: wheel.position.x, z: wheel.position.z }));
    },
    get wheelSpin() {
      return car.wheels.map((wheel) => wheel.rotation.x);
    },
    /**
     * Ce que la lecture du replay montre à l'instant présent : les scripts de
     * contrôle s'en servent pour attendre la portion roulée avant de mesurer.
     */
    get replayState() {
      const current = replay ? samplePoses(replay.poses, replay.elapsed) : null;
      return {
        active: Boolean(replay),
        elapsed: replay?.elapsed ?? 0,
        frames: replay?.poses.length ?? 0,
        visual: current?.visual ?? null,
      };
    },
    get wheels() {
      return vehicle.telemetryState.wheels.map((wheel) => ({
        name: wheel.name,
        contact: wheel.contact,
        slip: wheel.slipRatio,
        load: wheel.load,
        omega: wheel.omega,
      }));
    },
    get car() {
      return carDef.id;
    },
    get cars() {
      return CARS.map((entry) => entry.id);
    },
    setCar: (id: string) => selectCar(id as CarId),
    setTcs: (enabled: boolean) => setTcs(enabled, false),
    startBike: () => startBikeMode(),
    stopBike: () => leaveBike(),
    popWheelie: () => bike?.popWheelie() ?? false,
    openShowroom: () => openShowroom(),
    resetChrono: () => chrono?.reset(),
    startFree: () => startMode('free'),
    get collisionView() {
      return collisionView?.visible ?? false;
    },
    setCollisionView: (on?: boolean) => toggleCollisionView(on),
    startRace: () => startMode('race'),
    startCol: () => startMode('free', 'col'),
    // Le circuit vit sur sa carte : au clic on y bascule, au lieu de traverser
    // la ville. Les scripts de capture ouvrent l'URL avec `?map=suzuka`.
    startCircuit: () => (TRACK_MAP ? startMode('free', 'circuit') : openMap('suzuka')),
    // Ouvrir (ou relancer) la piste plate dessinée par le jeu.
    startFlat: () => (FLAT_MAP ? startMode('free', 'circuit') : openMap('sp95')),
    startRally: () => startMode('free', 'rally'),
    startSummit: () => startMode('free', 'summit'),
    teleport: (x: number, z: number, heading: number) => setCarPose(x, z, heading),
    setCamera: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
      freeCamera = {
        pos: new THREE.Vector3(px, py, pz),
        target: new THREE.Vector3(tx, ty, tz),
      };
    },
    clearCamera: () => {
      freeCamera = null;
    },
  };
  window.__sp95 = debugSurface;

  // Le menu d'accueil renvoie ici avec la destination : la carte est chargée,
  // on peut maintenant lancer directement la session demandée.
  const launch = new URLSearchParams(window.location.search);
  const open = launch.get('open');
  if (open === 'showroom') openShowroom();
  else if (open === 'garage') openGarage();
  else if (open === 'sound') openSound();
  const start = launch.get('start');
  if (start === 'moto') void startBikeMode();
  else if (start === 'race') startMode('race');
  else if (start === 'free') {
    const spawn = launch.get('spawn');
    const target: FreeSpawn | undefined =
      spawn === 'col' || spawn === 'rally' || spawn === 'summit' || spawn === 'circuit'
        ? spawn
        : undefined;
    startMode('free', target);
  }
  return debugSurface;
}

type Sp95DebugSurface = Awaited<ReturnType<typeof boot>>;

declare global {
  interface Window {
    __sp95?: Sp95DebugSurface;
  }
}

/**
 * Menu d'accueil sans carte. Chaque entrée navigue vers l'URL de sa carte et
 * de sa session : c'est le chargement de cette URL qui construit le monde.
 */
function wireMenuOnly(): void {
  const go = (params: Record<string, string>): void => {
    const url = new URL(window.location.href);
    // On conserve les réglages déjà dans l'URL (qualité, cadence, lumière) :
    // les effacer faisait perdre `?fps=` et `?fx=` au premier clic.
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    window.location.href = url.toString();
  };
  const on = (id: string, params: Record<string, string>): void => {
    document.getElementById(id)?.addEventListener('click', () => go(params));
  };
  // Chaque entrée porte sa carte : sans `map`, la navigation reviendrait sur
  // cet écran vide (MENU_ONLY teste justement l'absence de carte).
  on('btn-free', { map: 'sp95', start: 'free' });
  on('btn-race', { map: 'ville', start: 'race' });
  on('btn-circuit', { map: 'suzuka', start: 'free' });
  on('btn-flat', { map: 'sp95', start: 'free' });
  on('btn-col', { map: 'ville', start: 'free', spawn: 'col' });
  on('btn-rally', { map: 'ville', start: 'free', spawn: 'rally' });
  on('btn-sommet', { map: 'ville', start: 'free', spawn: 'summit' });
  on('btn-moto', { map: 'ville', start: 'moto' });
  // Showroom, atelier et son vivent sur la piste plate : y aller les ouvre.
  on('btn-cars', { map: 'sp95', open: 'showroom' });
  on('btn-garage', { map: 'sp95', open: 'garage' });
  on('btn-sound', { map: 'sp95', open: 'sound' });
}

boot().catch((error) => {
  console.error(error);
  loadingText.textContent = `Impossible de démarrer le jeu : ${(error as Error).message}`;
  loadingFill.style.background = '#d8342c';
});

