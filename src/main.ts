import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import './styles.css';
import { Vehicle, type VehicleInput, type VehicleSpec } from './physics/vehicle.ts';
import {
  COL_START,
  RACE_START,
  RALLY_START,
  SPAWN,
  SUMMIT_START,
  buildRaceCheckpoints,
  surfaceAt,
} from './world/layout.ts';
import { buildGradedRoads, buildRaceGates, buildRoads, buildTerrain } from './world/terrain.ts';
import { buildCity, syncProps } from './world/city.ts';
import { createEnvironmentMaterials } from './render/materials.ts';
import { createSky } from './render/sky.ts';
import { createCar, updateCarVisual } from './render/car.ts';
import { QualityGovernor } from './render/quality.ts';
import { ChaseCamera } from './core/camera.ts';
import { InputManager } from './core/input.ts';
import { Hud, type GameMode } from './game/hud.ts';
import { DriftScore } from './game/drift.ts';
import { Race } from './game/race.ts';
import { CarAudio } from './game/audio.ts';
import { Garage } from './game/garage.ts';
import { loadSetup, resolveSpec, saveSetup, type Setup } from './game/tuning.ts';

const FIXED = 1 / 120;

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

  await setLoading(0.68, 'Construction de la ville…');
  const props = buildCity(scene, world, materials);

  await setLoading(0.76, 'Installation du circuit…');
  const checkpoints = buildRaceCheckpoints(12);
  buildRaceGates(scene, materials, checkpoints);

  await setLoading(0.84, 'Montage de la voiture…');
  let setup: Setup = loadSetup();
  let spec: VehicleSpec = resolveSpec(setup);
  // Drop the car in at its ride height: spawning higher makes it land on the
  // bump stops and bounce before the player can drive. Taller tires lift it.
  const rideHeightFor = (s: VehicleSpec) => s.rideHeight + s.wheelRadius - 0.12 + 0.04;
  const spawnY = terrain.sample(SPAWN.x, SPAWN.z) + rideHeightFor(spec);
  let vehicle = new Vehicle(
    world,
    { x: SPAWN.x, y: spawnY, z: SPAWN.z, heading: SPAWN.heading, surfaceAt },
    spec,
  );
  const car = createCar();
  car.setWheelRadius(spec.wheelRadius);
  car.group.position.set(SPAWN.x, spawnY, SPAWN.z);
  scene.add(car.group);

  const input = new InputManager(canvas);
  const hud = new Hud();
  const audio = new CarAudio();
  const drift = new DriftScore();
  const governor = new QualityGovernor(renderer, renderer.getPixelRatio());

  let mode: GameMode = 'menu';
  let freeSpawn: FreeSpawn = 'city';
  let paused = false;
  let accumulator = 0;
  let race: Race | null = null;
  let menuTime = 0;
  let lastSpeed = 0;
  let lastCrashTime = -10;
  let gravelTimer = 0;
  /** Inspection camera, set from the debug hook: no effect unless used. */
  let freeCamera: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  let lastFrame = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;
  let fps = 0;

  const carPosition = new THREE.Vector3(SPAWN.x, spawnY, SPAWN.z);
  const carForward = forwardFromHeading(SPAWN.heading);
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
    vehicle.respawn(x, ground + rideHeightFor(spec), z, heading);
    // Let the springs settle so the car sits on its wheels immediately.
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
  }

  function spawnFree(): void {
    setCarPose(SPAWN.x, SPAWN.z, SPAWN.heading);
    drift.reset();
    lastSpeed = 0;
  }

  function startMode(next: GameMode, spawn: FreeSpawn = 'city'): void {
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

  /** Rebuilds the car with the garage setup, keeping where it stands. */
  function applySetup(next: Setup): void {
    setup = { ...next };
    saveSetup(setup);
    spec = resolveSpec(setup);
    const position = vehicle.position;
    const heading = Math.atan2(-carForward.x, -carForward.z);
    world.removeRigidBody(vehicle.body);
    vehicle = new Vehicle(
      world,
      { x: position.x, y: position.y + 0.35, z: position.z, heading, surfaceAt },
      spec,
    );
    car.setWheelRadius(spec.wheelRadius);
    configureAudio();
    setCarPose(position.x, position.z, heading);
  }

  function configureAudio(): void {
    audio.configure({
      redline: spec.redlineRpm,
      turbo: setup.engine > 0,
      exhaustLevel: setup.exhaust,
      engineLevel: setup.engine,
    });
  }

  const garage = new Garage(setup, applySetup);

  function openGarage(): void {
    if (mode !== 'menu' && !paused) togglePause();
    garage.open(setup);
  }

  document.getElementById('btn-free')?.addEventListener('click', () => startMode('free'));
  document.getElementById('btn-race')?.addEventListener('click', () => startMode('race'));
  document.getElementById('btn-garage')?.addEventListener('click', openGarage);
  document.getElementById('btn-pause-garage')?.addEventListener('click', openGarage);
  document.getElementById('btn-col')?.addEventListener('click', () => startMode('free', 'col'));
  document.getElementById('btn-pause-col')?.addEventListener('click', () => startMode('free', 'col'));
  document.getElementById('btn-rally')?.addEventListener('click', () => startMode('free', 'rally'));
  document.getElementById('btn-pause-rally')?.addEventListener('click', () => startMode('free', 'rally'));
  document.getElementById('btn-sommet')?.addEventListener('click', () => startMode('free', 'summit'));
  document.getElementById('btn-pause-sommet')?.addEventListener('click', () => startMode('free', 'summit'));
  document.getElementById('btn-resume')?.addEventListener('click', () => togglePause());
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

    const telemetry = vehicle.telemetryState;
    const speed = telemetry.speed;
    const crash = lastSpeed - speed > 4.2 && lastSpeed > 9 && performance.now() / 1000 - lastCrashTime > 0.4;
    if (crash) {
      lastCrashTime = performance.now() / 1000;
      audio.impact(Math.min(1, (lastSpeed - speed) / 14));
    }
    lastSpeed = speed;

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

  function updateVisuals(dt: number): void {
    const telemetry = vehicle.telemetryState;
    const state = vehicle.state;
    carPosition.set(state.position.x, state.position.y, state.position.z);
    carForward.set(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(state.rotation.x, state.rotation.y, state.rotation.z, state.rotation.w),
    );

    updateCarVisual(
      car,
      state.position,
      state.rotation,
      telemetry.wheels,
      telemetry.brake > 0.1 && telemetry.speed > 0.5,
      telemetry.gear === -1,
    );

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
      );
    }

    hud.updateSpeed(telemetry.speedKmh, telemetry.gear, telemetry.rpm / 7300);
    hud.updateDrift(drift.pending, drift.total, drift.multiplier, drift.active);

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
      if (garage.isOpen) garage.close();
      else togglePause();
    }
    if (input.consume('mute')) audio.setMuted(!audio.isMuted);
    if (mode !== 'menu' && !paused && input.consume('reset')) {
      respawn();
    }

    if (mode !== 'menu' && !paused) {
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
    get surface() {
      return vehicle.telemetryState.surface.kind;
    },
    get gearFloat() {
      return vehicle.telemetryState.gear;
    },
    get audioEvents() {
      return audio.events;
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
      readonly drivetrain: { gear: number; rpm: number; limiter: boolean; shifting: boolean };
      readonly spec: { name: string; mass: number; peakTorque: number; maxSteer: number };
      readonly garageOpen: boolean;
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

