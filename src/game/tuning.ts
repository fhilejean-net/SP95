import { STOCK_SPEC, type VehicleSpec } from '../physics/vehicle.ts';
import { SPORT_DRIVETRAIN, torqueAtRpm } from '../physics/drivetrain.ts';

/**
 * The garage. A setup is just a pick per category; `resolveSpec` folds the picks
 * into the single `VehicleSpec` the physics reads. Keeping the catalog as data
 * means the UI, the saved setup and the tests all agree on what a part does.
 */

export type SetupKey =
  | 'engine'
  | 'exhaust'
  | 'weight'
  | 'suspension'
  | 'tires'
  | 'steering'
  | 'brakes'
  | 'aero';

export type Setup = Record<SetupKey, number>;

export interface UpgradeOption {
  label: string;
  /** One line shown under the name in the garage. */
  detail: string;
}

export interface SetupCategory {
  key: SetupKey;
  label: string;
  hint: string;
  options: UpgradeOption[];
}

export const CATEGORIES: SetupCategory[] = [
  {
    key: 'engine',
    label: 'Moteur',
    hint: 'Cartographie et pression de suralimentation.',
    options: [
      { label: 'Série', detail: "Réglage d'usine" },
      { label: 'Reprogrammation Stage 1', detail: '+12 % de couple · rupteur +150' },
      { label: 'Stage 2 · admission + échangeur', detail: '+24 % · rupteur +400' },
      { label: 'Stage 3 · turbo hybride', detail: '+40 % · rupteur +700' },
    ],
  },
  {
    key: 'exhaust',
    label: 'Échappement',
    hint: 'Une ligne qui respire libère de la puissance et du poids.',
    options: [
      { label: "Ligne d'origine", detail: 'Silencieuse, bridée' },
      { label: 'Cat-back inox', detail: '+3 % de couple · −8 kg · monte plus haut' },
      { label: 'Ligne complète + collecteur', detail: '+7 % · −16 kg' },
    ],
  },
  {
    key: 'weight',
    label: 'Poids',
    hint: "Moins de masse, c'est plus d'agilité et un meilleur freinage.",
    options: [
      { label: 'Série', detail: 'Sièges et insonorisation' },
      { label: 'Allègement', detail: '−55 kg · baquets, capot carbone' },
      { label: 'Dépouillement', detail: '−120 kg · arceau, panneaux, polycarbonate' },
    ],
  },
  {
    key: 'suspension',
    label: 'Suspensions',
    hint: 'Ressorts, amortisseurs et barres anti-roulis.',
    options: [
      { label: 'Série', detail: 'Confort · débattement 14 cm' },
      { label: 'Sport', detail: 'Plus ferme, caisse abaissée' },
      { label: 'Piste', detail: 'Très rigide, roulis quasi nul' },
      { label: 'Rallye', detail: 'Grand débattement, absorbe les bosses' },
      { label: 'Drift', detail: 'Arrière raffermi, caisse basse' },
    ],
  },
  {
    key: 'tires',
    label: 'Pneus',
    hint: "Le seul contact avec la route.",
    options: [
      { label: 'Route sport', detail: 'Bon grip, réactions franches' },
      { label: 'Semi-slick', detail: 'Grip maximal sur le sec' },
      { label: 'Drift', detail: 'Glisse progressivement, angles tenus plus longtemps' },
      { label: 'Tout-terrain', detail: 'Flancs hauts, meilleur sur les chemins' },
      // La gomme tendre des tours chrono : c'est la seule monte qui tient un
      // tour lancé sans glisser. Sur mouillé elle ne tient plus rien du tout.
      { label: 'Slick de course', detail: 'Gomme tendre · le grip maxi, né sur le sec' },
    ],
  },
  {
    key: 'steering',
    label: 'Direction',
    hint: "L'angle de braquage décide de ce que tu peux rattraper.",
    options: [
      { label: 'Série', detail: '41° de braquage' },
      { label: 'Kit grand angle', detail: '66° de braquage · crémaillère rapide' },
    ],
  },
  {
    key: 'brakes',
    label: 'Freins',
    hint: 'Disques, plaquettes et étriers : la distance qui sépare de la barrière.',
    options: [
      { label: 'Série', detail: 'Étriers flottants, plaquettes routières' },
      { label: 'Plaquettes performance', detail: '+18 % de couple de freinage, moins de fade' },
      { label: 'Étriers 6 pistons', detail: '+38 % · disques rainurés, durites aviation' },
      { label: 'Kit piste', detail: '+55 % · carbone-céramique, attaque très franche' },
    ],
  },
  {
    key: 'aero',
    label: 'Appui',
    hint: "L'aéro plaque la voiture : plus d'appui, plus de vitesse de passage.",
    options: [
      { label: 'Série', detail: 'Carrosserie de route' },
      { label: 'Aileron arrière', detail: '+35 % d’appui · un peu plus de traînée' },
      { label: 'Kit piste complet', detail: '+80 % d’appui · splitter, diffuseur, aileron' },
    ],
  },
];

export interface SetupPreset {
  label: string;
  setup: Setup;
}

/** One-click starting points; every part stays editable afterwards. */
export const PRESETS: SetupPreset[] = [
  {
    label: 'Série',
    setup: {
      engine: 0,
      exhaust: 0,
      weight: 0,
      suspension: 0,
      tires: 0,
      steering: 0,
      brakes: 0,
      aero: 0,
    },
  },
  {
    label: 'Drift',
    setup: {
      engine: 1,
      exhaust: 1,
      weight: 1,
      suspension: 4,
      tires: 2,
      steering: 1,
      brakes: 1,
      aero: 0,
    },
  },
  {
    label: 'Piste',
    setup: {
      engine: 3,
      exhaust: 2,
      weight: 2,
      suspension: 2,
      // Le mode piste monte des slicks de course, pas des semi-slicks : c'est
      // la gomme des tours chrono, et le joueur la demande explicitement au
      // menu de conduite rapide.
      tires: 4,
      steering: 0,
      brakes: 2,
      aero: 2,
    },
  },
  // Tours chrono : slicks, caisse allégée, tout pour la seconde au tour.
  {
    label: 'Chrono',
    setup: {
      engine: 2,
      exhaust: 2,
      weight: 2,
      suspension: 2,
      tires: 4,
      steering: 0,
      brakes: 3,
      aero: 2,
    },
  },
  {
    label: 'Tout-terrain',
    setup: {
      engine: 2,
      exhaust: 1,
      weight: 0,
      suspension: 3,
      tires: 3,
      steering: 1,
      brakes: 1,
      aero: 0,
    },
  },
];

export const DEFAULT_SETUP: Setup = {
  engine: 0,
  exhaust: 0,
  weight: 0,
  suspension: 0,
  tires: 0,
  steering: 0,
  brakes: 0,
  aero: 0,
};

const ENGINE = [
  { torque: 420, peakRpm: 3900, redline: 7300, upshift: 6800 },
  { torque: 470, peakRpm: 4000, redline: 7450, upshift: 6950 },
  { torque: 520, peakRpm: 4300, redline: 7700, upshift: 7200 },
  { torque: 590, peakRpm: 4600, redline: 8000, upshift: 7500 },
];

const EXHAUST = [
  { torque: 0, mass: 0, upshift: 0 },
  { torque: 12, mass: 8, upshift: 80 },
  { torque: 26, mass: 16, upshift: 170 },
];

const MASS = [0, 55, 120];

const SUSPENSION = [
  { springK: 34000, springC: 3800, arbFront: 14000, arbRear: 9000, rideHeight: 0.363, travel: 0.14 },
  { springK: 46000, springC: 4600, arbFront: 20000, arbRear: 13000, rideHeight: 0.335, travel: 0.13 },
  { springK: 62000, springC: 6000, arbFront: 28000, arbRear: 19000, rideHeight: 0.315, travel: 0.11 },
  { springK: 26000, springC: 2900, arbFront: 8000, arbRear: 6000, rideHeight: 0.395, travel: 0.24 },
  { springK: 44000, springC: 4300, arbFront: 19000, arbRear: 22000, rideHeight: 0.33, travel: 0.15 },
];

const TIRES = [
  { muFront: 1.24, muRear: 1.2, peakSlipAngle: 0.135, radius: 0.34, looseGrip: 1 },
  { muFront: 1.5, muRear: 1.45, peakSlipAngle: 0.12, radius: 0.335, looseGrip: 0.92 },
  { muFront: 1.3, muRear: 1.05, peakSlipAngle: 0.19, radius: 0.335, looseGrip: 1 },
  // Tall sidewalls, open tread: the only set that actually gains grip on dirt.
  { muFront: 1.18, muRear: 1.14, peakSlipAngle: 0.2, radius: 0.38, looseGrip: 1.45 },
  // Slick de course : beaucoup de mu, une pente de glisse très raide (prévenu
  // tard, décroché vite) et rien à espérer hors de l'asphalte.
  { muFront: 1.72, muRear: 1.66, peakSlipAngle: 0.1, radius: 0.33, looseGrip: 0.55 },
];

const STEERING = [
  { maxSteer: 0.72, steerRate: 3.0 },
  { maxSteer: 1.15, steerRate: 4.2 },
];

/** Multiples du couple de freinage d'origine. */
const BRAKES = [1, 1.18, 1.38, 1.55];

/** Appui et traînée, en multiples de la carrosserie de route. */
const AERO = [
  { mu: 1.0, downforce: 1.0, drag: 1.0 },
  { mu: 1.04, downforce: 1.35, drag: 1.02 },
  { mu: 1.08, downforce: 1.8, drag: 1.05 },
];

function pick<T>(list: T[], index: number): T {
  return list[Math.max(0, Math.min(list.length - 1, index | 0))] ?? list[0];
}

export function resolveSpec(setup: Setup, base: VehicleSpec = STOCK_SPEC): VehicleSpec {
  const engine = pick(ENGINE, setup.engine);
  const exhaust = pick(EXHAUST, setup.exhaust);
  const suspension = pick(SUSPENSION, setup.suspension);
  const tires = pick(TIRES, setup.tires);
  const steering = pick(STEERING, setup.steering);
  const brakeScale = pick(BRAKES, setup.brakes ?? 0);
  const aero = pick(AERO, setup.aero ?? 0);
  const mass = base.mass - pick(MASS, setup.weight);

  // Every part is a proportion of the car it is bolted to, so the same Stage 3
  // on a V12 and on a four-cylinder raises each engine by the same 40 %. The
  // catalogs above are therefore written as offsets from the stock car.
  const stock = SUSPENSION[0];
  const grip = TIRES[0];
  const lock = STEERING[0];
  const torqueScale = base.peakTorque / STOCK_SPEC.peakTorque;

  return {
    ...base,
    name: `${base.name} · ${ENGINE_OPTIONS[setup.engine]?.label ?? 'Série'}`,
    mass,
    peakTorque: base.peakTorque * (engine.torque / STOCK_SPEC.peakTorque) + exhaust.torque * torqueScale,
    peakTorqueRpm: base.peakTorqueRpm + (engine.peakRpm - STOCK_SPEC.peakTorqueRpm),
    redlineRpm: base.redlineRpm + (engine.redline - STOCK_SPEC.redlineRpm),
    upshiftRpm: base.upshiftRpm + (engine.upshift - STOCK_SPEC.upshiftRpm) + exhaust.upshift,
    springK: base.springK * (suspension.springK / stock.springK),
    springC: base.springC * (suspension.springC / stock.springC),
    arbFront: base.arbFront * (suspension.arbFront / stock.arbFront),
    arbRear: base.arbRear * (suspension.arbRear / stock.arbRear),
    rideHeight: base.rideHeight + (suspension.rideHeight - stock.rideHeight),
    wheelTravel: base.wheelTravel * (suspension.travel / stock.travel),
    wheelRadius: base.wheelRadius * (tires.radius / grip.radius),
    muFront: base.muFront * (tires.muFront / grip.muFront) * aero.mu,
    muRear: base.muRear * (tires.muRear / grip.muRear) * aero.mu,
    downforceArea: base.downforceArea * aero.downforce,
    dragArea: base.dragArea * aero.drag,
    peakSlipAngle: base.peakSlipAngle * (tires.peakSlipAngle / grip.peakSlipAngle),
    looseGrip: tires.looseGrip,
    maxSteer: base.maxSteer * (steering.maxSteer / lock.maxSteer),
    steerRate: base.steerRate * (steering.steerRate / lock.steerRate),
    brakeTorque: base.brakeTorque * (mass / base.mass) * brakeScale,
  };
}

const ENGINE_OPTIONS = CATEGORIES[0].options;

/** Peak crank power in ch (metric horsepower), from the torque curve. */
export function estimatePowerHp(spec: VehicleSpec): number {
  const cfg = {
    ...SPORT_DRIVETRAIN,
    peakTorque: spec.peakTorque,
    peakTorqueRpm: spec.peakTorqueRpm,
  };
  let best = 0;
  for (let rpm = 900; rpm <= spec.redlineRpm; rpm += 50) {
    best = Math.max(best, (torqueAtRpm(rpm, cfg) * rpm) / 9549);
  }
  return Math.round(best * 1.35962);
}

export interface SetupSummary {
  label: string;
  powerHp: number;
  mass: number;
  /** Power-to-weight, ch per tonne. */
  ratio: number;
  grip: string;
  steering: string;
  /** Où le couple part : propulsion, traction ou intégrale. */
  drive: string;
  /** Barres 0 → 1 pour le showroom, tirées du mu et de l'appui. */
  gripBar: number;
  aeroBar: number;
}

export function describeSetup(setup: Setup, base: VehicleSpec = STOCK_SPEC): SetupSummary {
  const spec = resolveSpec(setup, base);
  const powerHp = estimatePowerHp(spec);
  return {
    label: spec.name,
    powerHp,
    mass: Math.round(spec.mass),
    ratio: Math.round((powerHp / spec.mass) * 1000),
    grip: CATEGORIES[4].options[setup.tires]?.label ?? 'Route sport',
    steering: CATEGORIES[5].options[setup.steering]?.label ?? 'Série',
    drive: driveLabel(spec),
    gripBar: Math.max(0, Math.min(1, spec.muFront / 1.9)),
    aeroBar: Math.max(0, Math.min(1, spec.downforceArea / 2.2)),
  };
}

/** Ce que la voiture fait de son couple, dit en deux mots. */
export function driveLabel(spec: VehicleSpec): string {
  if (spec.driveFront <= 0.15) return 'Propulsion';
  if (spec.driveFront >= 0.85) return 'Traction';
  return 'Intégrale';
}

export function normalizeSetup(raw: unknown): Setup {
  const out: Setup = { ...DEFAULT_SETUP };
  if (raw && typeof raw === 'object') {
    for (const category of CATEGORIES) {
      const value = (raw as Record<string, unknown>)[category.key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        out[category.key] = Math.max(0, Math.min(category.options.length - 1, Math.round(value)));
      }
    }
  }
  return out;
}

const STORAGE_KEY = 'sp95.setup';

export function loadSetup(): Setup {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeSetup(JSON.parse(raw)) : { ...DEFAULT_SETUP };
  } catch {
    return { ...DEFAULT_SETUP };
  }
}

export function saveSetup(setup: Setup): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(setup));
  } catch {
    // Private mode: the setup just does not persist.
  }
}
