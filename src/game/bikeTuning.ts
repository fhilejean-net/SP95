import type { BikeSpec } from '../physics/bike.ts';

/**
 * The bike workshop.
 *
 * Same idea as the car garage: a setup is a pick per category, and
 * `resolveBikeSpec` folds the picks into the `BikeSpec` the physics reads. The
 * catalogs are written as ratios of the stock supermotard, so a part does the
 * same thing to the bike it was described for.
 */

export type BikeSetupKey = 'engine' | 'gearing' | 'tires' | 'suspension';

export type BikeSetup = Record<BikeSetupKey, number>;

export interface BikeUpgradeOption {
  label: string;
  detail: string;
}

export interface BikeSetupCategory {
  key: BikeSetupKey;
  label: string;
  hint: string;
  options: BikeUpgradeOption[];
}

export const BIKE_CATEGORIES: BikeSetupCategory[] = [
  {
    key: 'engine',
    label: 'Moteur',
    hint: 'Un gros monocylindre : la cartographie change tout.',
    options: [
      { label: 'Série', detail: '68 Nm · rupteur 8 500' },
      { label: 'Ligne + cartographie', detail: '+8 % de couple · rupteur +200' },
      { label: 'Kit 720 cm³', detail: '+20 % · rupteur +400 · plus lourd' },
    ],
  },
  {
    key: 'gearing',
    label: 'Transmission',
    hint: 'Court pour lever, long pour rouler.',
    options: [
      { label: 'Série', detail: '14/41 · wheelie facile' },
      { label: 'Démultiplication courte', detail: '14/45 · lève plus tôt, moins vite' },
      { label: 'Démultiplication longue', detail: '15/41 · plus vite, plus de couple au levier' },
    ],
  },
  {
    key: 'tires',
    label: 'Pneus',
    hint: 'Le grip décide de ce que la moto peut faire.',
    options: [
      { label: 'Cross route', detail: 'Bon sur bitume, correct sur terre' },
      { label: 'Crampons tendres', detail: 'Grip maximal sur herbe et chemins' },
      { label: 'Slick supermotard', detail: 'Grip énorme sur bitume, nul ailleurs' },
    ],
  },
  {
    key: 'suspension',
    label: 'Suspensions',
    hint: 'Débattement et dureté : le wheelie et les bosses.',
    options: [
      { label: 'Série', detail: '20 cm de débattement' },
      { label: 'Ferme', detail: 'Moins de plongée, atterrissages secs' },
      { label: 'Souple', detail: 'Grand débattement, plus de tangage' },
    ],
  },
];

export interface BikeSetupPreset {
  label: string;
  setup: BikeSetup;
}

export const BIKE_PRESETS: BikeSetupPreset[] = [
  { label: 'Série', setup: { engine: 0, gearing: 0, tires: 0, suspension: 0 } },
  { label: 'Stunt', setup: { engine: 1, gearing: 1, tires: 0, suspension: 1 } },
  { label: 'Enduro', setup: { engine: 0, gearing: 1, tires: 1, suspension: 2 } },
  { label: 'Piste', setup: { engine: 2, gearing: 2, tires: 2, suspension: 1 } },
];

export const BIKE_DEFAULT_SETUP: BikeSetup = { engine: 0, gearing: 0, tires: 0, suspension: 0 };

/**
 * Nom du preset qui correspond exactement au réglage courant, ou « Réglage
 * perso » dès qu'un seul choix s'en écarte : le HUD doit dire ce qui est monté,
 * pas le dernier bouton cliqué.
 */
export function bikePresetLabel(setup: BikeSetup): string {
  const match = BIKE_PRESETS.find((preset) =>
    (Object.keys(preset.setup) as (keyof BikeSetup)[]).every(
      (key) => preset.setup[key] === setup[key],
    ),
  );
  return match?.label ?? 'Réglage perso';
}

const ENGINE = [
  { torque: 68, redline: 8500, upshift: 8000, mass: 0 },
  { torque: 73, redline: 8700, upshift: 8150, mass: 0 },
  { torque: 82, redline: 8900, upshift: 8200, mass: 6 },
];

const GEARING = [
  { ratios: [2.7, 2.1, 1.75, 1.5, 1.3, 1.15], final: 4.1 },
  { ratios: [2.95, 2.25, 1.85, 1.58, 1.36, 1.2], final: 4.5 },
  { ratios: [2.5, 1.98, 1.66, 1.42, 1.24, 1.1], final: 3.8 },
];

const TIRES = [
  { muFront: 1.34, muRear: 1.3, loose: 1.35, peak: 0.15 },
  // Knobblies: the only set that really bites in the grass.
  { muFront: 1.24, muRear: 1.2, loose: 1.85, peak: 0.18 },
  // Slicks: enormous on tarmac, hopeless off it.
  { muFront: 1.5, muRear: 1.46, loose: 0.75, peak: 0.13 },
];

const SUSPENSION = [
  { springK: 24000, springC: 2600, travel: 0.2, gain: 0.95 },
  { springK: 32000, springC: 3300, travel: 0.16, gain: 1.05 },
  { springK: 19000, springC: 2100, travel: 0.25, gain: 0.9 },
];

function pick<T>(list: T[], index: number): T {
  return list[Math.max(0, Math.min(list.length - 1, index | 0))] ?? list[0];
}

export function resolveBikeSpec(setup: BikeSetup, base: BikeSpec): BikeSpec {
  const engine = pick(ENGINE, setup.engine);
  const gearing = pick(GEARING, setup.gearing);
  const tires = pick(TIRES, setup.tires);
  const suspension = pick(SUSPENSION, setup.suspension);
  const stockEngine = ENGINE[0];
  const stockTires = TIRES[0];
  const stockSuspension = SUSPENSION[0];

  return {
    ...base,
    mass: base.mass + engine.mass,
    peakTorque: base.peakTorque * (engine.torque / stockEngine.torque),
    redlineRpm: engine.redline,
    upshiftRpm: engine.upshift,
    ratios: [...gearing.ratios],
    finalDrive: gearing.final,
    muFront: base.muFront * (tires.muFront / stockTires.muFront),
    muRear: base.muRear * (tires.muRear / stockTires.muRear),
    looseGrip: tires.loose,
    peakSlipAngle: base.peakSlipAngle * (tires.peak / stockTires.peak),
    springK: base.springK * (suspension.springK / stockSuspension.springK),
    springC: base.springC * (suspension.springC / stockSuspension.springC),
    wheelTravel: suspension.travel,
    wheelieGain: base.wheelieGain * (suspension.gain / stockSuspension.gain),
    // More power lifts the front more easily: keep the wheelie tied to the
    // engine instead of letting a Stage engine be a cosmetic upgrade.
    brakeTorque: base.brakeTorque * ((base.mass + engine.mass) / base.mass),
  };
}

export interface BikeSetupSummary {
  label: string;
  powerHp: number;
  mass: number;
  ratio: number;
}

export function describeBikeSetup(setup: BikeSetup, base: BikeSpec): BikeSetupSummary {
  const spec = resolveBikeSpec(setup, base);
  const powerHp = Math.round(((spec.peakTorque * spec.peakTorqueRpm) / 9549) * 1.35962 * 2.6);
  return {
    label: spec.name,
    powerHp,
    mass: Math.round(spec.mass),
    ratio: Math.round((powerHp / spec.mass) * 1000),
  };
}

export function normalizeBikeSetup(raw: unknown): BikeSetup {
  const out: BikeSetup = { ...BIKE_DEFAULT_SETUP };
  if (raw && typeof raw === 'object') {
    for (const category of BIKE_CATEGORIES) {
      const value = (raw as Record<string, unknown>)[category.key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        out[category.key] = Math.max(0, Math.min(category.options.length - 1, Math.round(value)));
      }
    }
  }
  return out;
}

const STORAGE_KEY = 'sp95.bike.setup';

export function loadBikeSetup(): BikeSetup {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeBikeSetup(JSON.parse(raw)) : { ...BIKE_DEFAULT_SETUP };
  } catch {
    return { ...BIKE_DEFAULT_SETUP };
  }
}

export function saveBikeSetup(setup: BikeSetup): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(setup));
  } catch {
    // Private mode: the setup just does not persist.
  }
}
