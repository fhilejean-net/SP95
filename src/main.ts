import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import './styles.css';
import { Vehicle, type VehicleInput, type VehicleSpec } from './physics/vehicle.ts';
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
  COL_START,
  RACE_START,
  RALLY_START,
  SPAWN,
  SUMMIT_START,
  buildRaceCheckpoints,
  surfaceAt,
  isWetRoad,
  setWetRoad,
  sprayActive,
} from './world/layout.ts';
import {
  buildArenaPads,
  buildGradedRoads,
  buildRaceGates,
  buildRoads,
  buildTerrain,
  roadEnds,
} from './world/terrain.ts';
import { NEIGHBOURHOODS, buildCity, syncProps } from './world/city.ts';
import { buildStreetKit, type StreetKitSummary } from './world/streetkit.ts';
import { buildPuddles } from './world/puddles.ts';
import { buildVegetation, type VegetationSummary } from './world/vegetation.ts';
import { createEnvironmentMaterials } from './render/materials.ts';
import { createSky } from './render/sky.ts';
import { createCar, updateCarVisual, type CarVisual } from './render/car.ts';
import { createBike, type BikeVisual } from './render/bike.ts';
import { loadBikeVisual } from './render/bikeModel.ts';
import { createSparks } from './render/sparks.ts';
import { createTireSmoke } from './render/tireSmoke.ts';
import { loadCarVisual } from './render/carModel.ts';
import { CARS, findCar, loadCarId, saveCarId, type CarDef, type CarId } from './game/cars.ts';
import { QualityGovernor } from './render/quality.ts';
import { ChaseCamera, cameraModeLabel } from './core/camera.ts';
import { InputManager } from './core/input.ts';
import { Hud, type GameMode } from './game/hud.ts';
import { DriftScore } from './game/drift.ts';
import { ReplayBuffer, samplePoses, type ReplayPose } from './game/replay.ts';
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
import { loadSetup, resolveSpec, saveSetup, type Setup } from './game/tuning.ts';

const FIXED = 1 / 120;

/** Asphalte sec / mouillé : le mouillé fonce la chaussée (touche G). */
const DRY_ASPHALT_COLOR = 0x8f9096;
const WET_ASPHALT_COLOR = 0x6b7178;
const DRY_PAD_COLOR = 0x808086;
const WET_PAD_COLOR = 0x63696f;

type FreeSpawn = 'city' | 'col' | 'rally' | 'summit';

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
  const mobile = matchMedia('(pointer: coarse)').matches;
  // Past ~1.25 device pixels there is nothing left to see, but a lot of pixels
  // left to shade: it is the first thing that makes weak GPUs drop the frame.
  const cap = mobile ? 1 : 1.25;
  renderer.setPixelRatio(lowFx ? 0.7 : Math.min(window.devicePixelRatio, cap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = !lowFx;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Debug telemetry should count every pass of the frame.
  renderer.info.autoReset = false;
  return renderer;
}

function forwardFromHeading(heading: number): THREE.Vector3 {
  return new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
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
  const best = readBestLap();
  menuBest.textContent =
    best === null ? 'Aucun temps enregistré — lance une course pour établir la référence.'
      : `Meilleur tour : ${Race.formatTime(best)}`;
}

async function boot(): Promise<void> {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const lowFx = new URLSearchParams(window.location.search).get('fx') === 'low';
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

  await setLoading(0.18, 'Ciel et éclairage…');
  const sky = createSky(scene, renderer);
  const materials = createEnvironmentMaterials();

  await setLoading(0.3, 'Génération du terrain…');
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED;
  const terrain = buildTerrain(scene, world, materials);

  await setLoading(0.52, 'Tracé des routes…');
  buildRoads(scene, materials);
  buildGradedRoads(scene, materials);
  buildArenaPads(world);
  const puddles = buildPuddles(scene);

  await setLoading(0.68, 'Construction de la ville…');
  const props = buildCity(scene, world, materials);

  await setLoading(0.74, 'Mobilier urbain…');
  const streetKit = await buildStreetKit(scene, world, materials);
  /** Dry colour of each street-kit road tile, so the wet tint can be undone. */
  const streetKitDryColors = new Map<THREE.MeshStandardMaterial, THREE.Color>();

  await setLoading(0.8, 'Plantation des arbres…');
  const vegetation = await buildVegetation(scene, world, lowFx, sky.sunDirection);

  await setLoading(0.85, 'Installation du circuit…');
  const checkpoints = buildRaceCheckpoints(12);
  buildRaceGates(scene, materials, checkpoints);

  await setLoading(0.88, 'Montage de la voiture…');
  let setup: Setup = loadSetup();
  let carDef: CarDef = findCar(loadCarId());
  let spec: VehicleSpec = resolveSpec(setup, carDef.spec);
  // Drop the car in at its ride height: spawning higher makes it land on the
  // bump stops and bounce before the player can drive. Taller tires lift it.
  const rideHeightFor = (s: VehicleSpec) => s.rideHeight + s.wheelRadius - 0.12 + 0.04;
  const spawnY = terrain.sample(SPAWN.x, SPAWN.z) + rideHeightFor(spec);
  let carVehicle: Vehicle = new Vehicle(
    world,
    { x: SPAWN.x, y: spawnY, z: SPAWN.z, heading: SPAWN.heading, surfaceAt },
    spec,
  );
  /** Whichever vehicle is being ridden right now. */
  let vehicle: Vehicle | Bike = carVehicle;
  /** Where the car stands while the bike is out; rebuilt in place by the garage. */
  let carPose = { x: SPAWN.x, z: SPAWN.z, heading: SPAWN.heading };
  let bike: Bike | null = null;
  let bikeVisual: BikeVisual | null = null;
  let bikeSetup: BikeSetup = loadBikeSetup();
  /** The bike as the workshop built it: every bike readout uses this one. */
  let bikeSpec = resolveBikeSpec(bikeSetup, SUPERMOTARD.spec);
  let ridingBike = false;
  let tcsEnabled = loadTcs();
  vehicle.tcsEnabled = tcsEnabled;
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
  car.group.position.set(SPAWN.x, spawnY, SPAWN.z);
  scene.add(car.group);

  const input = new InputManager(canvas);
  const hud = new Hud();
  hud.setRedline(spec.redlineRpm);
  hud.setVehicle('car');
  setTcs(tcsEnabled, false);
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
  const drift = new DriftScore();
  const stunt = new StuntScore();
  const governor = new QualityGovernor(renderer, renderer.getPixelRatio());

  let mode: GameMode = 'menu';
  let freeSpawn: FreeSpawn = 'city';
  let paused = false;
  let accumulator = 0;
  let race: Race | null = null;
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

  const carPosition = new THREE.Vector3(SPAWN.x, spawnY, SPAWN.z);
  const carForward = forwardFromHeading(SPAWN.heading);
  /** Ground attitude under the bike, smoothed: the visual follows the hill. */
  const slopeState = { pitch: 0, roll: 0 };
  const slopeNormal = new THREE.Vector3();
  const localNormal = new THREE.Vector3();
  const bodyQuat = new THREE.Quaternion();
  const cameraGround = (x: number, z: number) => terrain.sample(x, z);

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

  function setCarPose(x: number, z: number, heading: number): void {
    const ground = terrain.sample(x, z);
    const height = ridingBike ? bikeSpec.cgHeight : rideHeightFor(spec);
    vehicle.respawn(x, ground + height, z, heading);
    // Let the springs settle so the tires sit on the ground immediately.
    for (let i = 0; i < 60; i++) {
      vehicle.step(FIXED, { throttle: 0, brake: 1, steer: 0, handbrake: true }, world);
      world.step();
    }
    const p = vehicle.position;
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
    setCarPose(SPAWN.x, SPAWN.z, SPAWN.heading);
    drift.reset();
    lastSpeed = 0;
  }

  function startMode(next: GameMode, spawn: FreeSpawn = 'city'): void {
    // A menu button keeps the focus when its overlay is hidden, and Space would
    // then re-click it instead of pulling the handbrake.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    mode = next;
    freeSpawn = spawn;
    paused = false;
    menu.classList.add('hidden');
    pause.classList.add('hidden');
    hudElement.classList.remove('hidden');
    hud.setMode(next);
    input.clear();
    audio.init();
    configureAudio();
    race = null;
    hud.hideMessage();
    hudElement.dataset.count = '';

    if (next === 'race') {
      race = new Race(checkpoints);
      setCarPose(RACE_START.x, RACE_START.z, RACE_START.heading);
      drift.reset();
      lastSpeed = 0;
      hud.flash('Prêt ?', { accent: true, duration: 900 });
    } else if (spawn === 'col') {
      setCarPose(COL_START.x, COL_START.z, COL_START.heading);
      drift.reset();
      lastSpeed = 0;
      hud.flash('Route du Col', { duration: 1300 });
    } else if (spawn === 'rally') {
      setCarPose(RALLY_START.x, RALLY_START.z, RALLY_START.heading);
      drift.reset();
      lastSpeed = 0;
      hud.flash('Piste rallye', { duration: 1300 });
    } else if (spawn === 'summit') {
      setCarPose(SUMMIT_START.x, SUMMIT_START.z, SUMMIT_START.heading);
      drift.reset();
      lastSpeed = 0;
      hud.flash('Sommet', { duration: 1300 });
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
        y: terrain.sample(pose.x, pose.z) + rideHeightFor(spec) + 0.35,
        z: pose.z,
        heading: pose.heading,
        surfaceAt,
      },
      spec,
    );
    carVehicle.tcsEnabled = tcsEnabled;
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
    const y = terrain.sample(SUMMIT_START.x, SUMMIT_START.z) + bikeSpec.cgHeight;
    bike = new Bike(
      world,
      { x: SUMMIT_START.x, y, z: SUMMIT_START.z, heading: SUMMIT_START.heading, surfaceAt },
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
      { x: position.x, y: position.y, z: position.z, heading, surfaceAt },
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

  /** Rebuilds the car with the garage setup, keeping where it stands. */
  function applySetup(next: Setup): void {
    setup = { ...next };
    saveSetup(setup);
    rebuildVehicle();
  }

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
    puddles.setVisible(wet);
  }

  /** Restores the balance the player left for the vehicle they are now on. */
  function applyVehicleMix(): void {
    const mix = mixForVehicle(vehicleMixes, ridingBike ? 'bike' : 'car');
    for (const channel of SOUND_CHANNELS) audio.setChannel(channel, mix[channel]);
  }

  const garage = new Garage(
    setup,
    bikeSetup,
    carDef,
    applySetup,
    (id) => {
      void selectCar(id);
    },
    applyBikeSetup,
  );

  /** Swaps the model, then the physics footprint that goes with it. */
  async function selectCar(id: CarId): Promise<void> {
    const def = CARS.find((entry) => entry.id === id);
    if (!def || (def.id === carDef.id && !ridingBike)) {
      garage.clearPending();
      return;
    }
    let next: CarVisual;
    try {
      next = await loadCarVisual(def, resolveSpec(setup, def.spec));
    } catch (error) {
      console.error(error);
      garage.clearPending();
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
    hud.flash(def.label, { duration: 1200 });
  }

  function openGarage(): void {
    if (mode !== 'menu' && !paused) togglePause();
    // The panel tunes whatever is in the garage: two wheels or four.
    if (ridingBike) garage.openBike(bikeSetup);
    else garage.open(setup);
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

  document.getElementById('btn-free')?.addEventListener('click', () => startMode('free'));
  document.getElementById('btn-moto')?.addEventListener('click', () => void startBikeMode());
  document.getElementById('btn-pause-moto')?.addEventListener('click', () => void startBikeMode());
  document.getElementById('btn-race')?.addEventListener('click', () => startMode('race'));
  document.getElementById('btn-garage')?.addEventListener('click', openGarage);
  document.getElementById('btn-pause-garage')?.addEventListener('click', openGarage);
  document.getElementById('btn-sound')?.addEventListener('click', openSound);
  document.getElementById('btn-pause-sound')?.addEventListener('click', openSound);
  document.getElementById('btn-col')?.addEventListener('click', () => startMode('free', 'col'));
  document.getElementById('btn-pause-col')?.addEventListener('click', () => startMode('free', 'col'));
  document.getElementById('btn-rally')?.addEventListener('click', () => startMode('free', 'rally'));
  document.getElementById('btn-pause-rally')?.addEventListener('click', () => startMode('free', 'rally'));
  document.getElementById('btn-sommet')?.addEventListener('click', () => startMode('free', 'summit'));
  document.getElementById('btn-pause-sommet')?.addEventListener('click', () => startMode('free', 'summit'));
  document.getElementById('btn-resume')?.addEventListener('click', () => togglePause());
  document.getElementById('btn-pause-tcs')?.addEventListener('click', () => setTcs(!tcsEnabled));
  // The HUD chip is a button too: switching the assist must not need a pause.
  // It drops focus on use, otherwise Space (the handbrake) would press it again.
  document.getElementById('tcs-chip')?.addEventListener('click', (event) => {
    (event.currentTarget as HTMLElement).blur();
    setTcs(!tcsEnabled);
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
  document.getElementById('btn-pause-menu')?.addEventListener('click', () => {
    mode = 'menu';
    paused = false;
    race = null;
    pause.classList.add('hidden');
    hudElement.classList.add('hidden');
    menu.classList.remove('hidden');
    hud.setMode('menu');
    hud.hideMessage();
    drift.reset();
    setCarPose(SPAWN.x, SPAWN.z, SPAWN.heading);
    updateMenuBest();
  });

  const unlockAudio = () => audio.init();
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  window.addEventListener('resize', () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
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
  setCarPose(SPAWN.x, SPAWN.z, SPAWN.heading);
  await setLoading(1, 'Prêt');
  await new Promise((resolve) => setTimeout(resolve, 220));
  loading.classList.add('done');
  window.setTimeout(() => loading.classList.add('hidden'), 500);
  menu.classList.remove('hidden');

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
      vehicle.step(FIXED, carInput, world);
      world.step();
      accumulator -= FIXED;
      steps++;
    }
    if (steps >= 8) accumulator = 0;

    // A rolling memory of poses for the replay. It never stores the physics
    // state, so playing a replay back cannot feed the simulation.
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
      },
      performance.now() / 1000,
    );

    const telemetry = vehicle.telemetryState;
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
      }
      return;
    }
    const telemetry = vehicle.telemetryState;
    const state = vehicle.state;
    carPosition.set(state.position.x, state.position.y, state.position.z);
    carForward.set(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(state.rotation.x, state.rotation.y, state.rotation.z, state.rotation.w),
    );

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
        state.position,
        state.rotation,
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
        const ground = terrain.sample(platePoint.x, platePoint.z);
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

    const lightPos = carPosition.clone().addScaledVector(sky.sunDirection, 260);
    sky.sun.position.copy(lightPos);
    sky.sun.target.position.copy(carPosition);
    sky.sun.target.updateMatrixWorld();

    syncProps(props);
    if (mode === 'menu') {
      menuTime += dt;
      const radius = 10.5;
      const angle = menuTime * 0.14 + 0.6;
      const ground = terrain.sample(SPAWN.x, SPAWN.z);
      camera.position.set(
        SPAWN.x + Math.cos(angle) * radius,
        ground + 3.4 + Math.sin(menuTime * 0.25) * 0.35,
        SPAWN.z + Math.sin(angle) * radius,
      );
      camera.lookAt(SPAWN.x, ground + 0.55, SPAWN.z);
      camera.fov += (52 - camera.fov) * Math.min(1, dt * 2);
      camera.updateProjectionMatrix();
    } else if (freeCamera) {
      camera.position.copy(freeCamera.pos);
      camera.lookAt(freeCamera.target);
      camera.fov = 55;
      camera.updateProjectionMatrix();
    } else if (replay) {
      // Free orbit around the replayed car: the mouse chooses any angle round
      // it and the wheel sets the distance, without the chase lag or the
      // auto-return that would fight the player mid-shot.
      const turn = (input.isDown('KeyE') ? 1 : 0) - (input.isDown('KeyQ') ? 1 : 0);
      replayCamYaw += turn * dt * 1.5;
      const yaw = replayCamYaw + (input.orbitYaw - replayCamOrbit);
      const pitch = Math.max(-0.05, 0.24 + input.orbitPitch);
      const distance = Math.max(2.2, 6.2 + input.zoom * 1.6);
      const horizontal = Math.cos(pitch) * distance;
      const ground = terrain.sample(carPosition.x, carPosition.z);
      camera.position.set(
        carPosition.x + Math.sin(yaw) * horizontal,
        Math.max(ground + 0.5, carPosition.y + Math.sin(pitch) * distance + 0.55),
        carPosition.z + Math.cos(yaw) * horizontal,
      );
      camera.lookAt(carPosition.x, carPosition.y + 0.7, carPosition.z);
      camera.fov += (58 - camera.fov) * Math.min(1, dt * 6);
      camera.updateProjectionMatrix();
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
    }

    // Point sizes are in pixels: convert from metres at the current fov.
    const fov = (camera.fov * Math.PI) / 180;
    const pixelsPerMeter = renderer.domElement.height / (2 * Math.tan(fov / 2));
    smokeFx.update(dt, pixelsPerMeter);
    sparkFx.update(dt, pixelsPerMeter);

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

    if (mode !== 'menu') {
      const next = race ? checkpoints[race.next] : null;
      const yaw = Math.atan2(-carForward.x, -carForward.z);
      hud.drawMinimap(carPosition.x, carPosition.z, yaw, next);
    }
  }

  function render(): void {
    renderer.info.reset();
    renderer.render(scene, camera);
  }

  function frame(now: number): void {
    requestAnimationFrame(frame);
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

    governor.update(dt);
    const controls = input.update(dt);

    if (input.consume('pause')) {
      if (audioPanel.isOpen) closeSound();
      else if (garage.isOpen) garage.close();
      else togglePause();
    }
    if (input.consume('mute')) audio.setMuted(!audio.isMuted);
    if (input.consume('tcs') && mode !== 'menu' && !ridingBike) setTcs(!tcsEnabled);
    if (input.consume('wet') && mode !== 'menu') {
      setWetRoad(!isWetRoad());
      applyWetLook(isWetRoad());
      hud.flash(isWetRoad() ? 'Route mouillée' : 'Route sèche', { duration: 900 });
    }
    if (input.consume('camera') && mode !== 'menu') {
      hud.flash(cameraModeLabel(chase.nextMode()), { duration: 900 });
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
    render();
  }

  requestAnimationFrame((now) => {
    lastFrame = now;
    requestAnimationFrame(frame);
  });

  window.__sp95 = {
    ready: true,
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
    get debug() {
      return {
        fps,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        driftPending: drift.pending,
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
    get spec() {
      return { name: spec.name, mass: spec.mass, peakTorque: spec.peakTorque, maxSteer: spec.maxSteer };
    },
    get garageOpen() {
      return garage.isOpen;
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
    startFree: () => startMode('free'),
    startRace: () => startMode('race'),
    startCol: () => startMode('free', 'col'),
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
}

declare global {
  interface Window {
    __sp95?: {
      ready: boolean;
      readonly mode: GameMode;
      readonly paused: boolean;
      readonly speedKmh: number;
      readonly gear: number;
      readonly rpm: number;
      readonly driftTotal: number;
      readonly racePhase: string | null;
      readonly raceLap: number;
      readonly position: { x: number; y: number; z: number };
      readonly debug: { fps: number; drawCalls: number; triangles: number; driftPending: number };
      readonly setup: Setup;
      readonly surface: string;
      readonly gearFloat: number;
      readonly audioEvents: number;
      readonly audioSamples: number;
      readonly drivetrain: { gear: number; rpm: number; limiter: boolean; shifting: boolean };
      readonly spec: { name: string; mass: number; peakTorque: number; maxSteer: number };
      readonly garageOpen: boolean;
      readonly soundPanelOpen: boolean;
      readonly soundMix: Record<string, number>;
      readonly tcs: boolean;
      readonly streetKit: StreetKitSummary;
      readonly vegetation: VegetationSummary;
      readonly roadEnds: number;
      readonly neighbourhoods: { houses: number; shops: number };
      readonly smoke: number;
      readonly redline: number;
      readonly vehicleKind: 'car' | 'bike';
      readonly bikeSetup: Record<string, number>;
      readonly bikeSpec: { peakTorque: number; mass: number; redline: number; looseGrip: number };
      readonly cameraMode: string;
      readonly bikePitch: number;
      readonly pushingBack: boolean;
      readonly stuntTotal: number;
      readonly stuntPending: number;
      readonly sparks: number;
      readonly bikeState: {
        leanDeg: number;
        pitchDeg: number;
        wheelie: boolean;
        bavette: boolean;
        steerDeg: number;
        rearSuspension: number;
        frontSuspension: number;
        slopePitchDeg: number;
        slopeRollDeg: number;
        wheels: number;
      } | null;
      readonly car: string;
      readonly cars: string[];
      readonly carModel: boolean;
      readonly wheelMounts: { x: number; z: number }[];
      readonly wheelSpin: number[];
      readonly wheels: { name: string; contact: boolean; slip: number; load: number; omega: number }[];
      setCar: (id: string) => Promise<void>;
      setTcs: (enabled: boolean) => void;
      startBike: () => void;
      stopBike: () => void;
      popWheelie: () => boolean;
      startFree: () => void;
      startRace: () => void;
      startCol: () => void;
      startRally: () => void;
      startSummit: () => void;
      teleport: (x: number, z: number, heading: number) => void;
      setCamera: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => void;
      clearCamera: () => void;
    };
  }
}

boot().catch((error) => {
  console.error(error);
  loadingText.textContent = `Impossible de démarrer le jeu : ${(error as Error).message}`;
  loadingFill.style.background = '#d8342c';
});

