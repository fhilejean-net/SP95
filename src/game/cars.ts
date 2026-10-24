import { STOCK_SPEC, type VehicleSpec } from '../physics/vehicle.ts';

/**
 * The three cars in the garage. Every one carries its own physics spec: the
 * dimensions come from the model (wheel centres), so the wheels the renderer
 * draws sit exactly on the contact patches the tire model uses.
 */
export interface CarDef {
  id: CarId;
  label: string;
  /** One line under the name in the garage. */
  detail: string;
  /** Model path under public/, resolved against the deploy base. */
  model: string;
  /** Y rotation that brings the model's nose to -Z, the game's forward. */
  yaw: number;
  /** Wheel node names in the GLB, in FL, FR, RL, RR order. */
  wheels: [string, string, string, string];
  /** Glow quads to add at the rear, for a model without usable lamp geometry. */
  brakeGlow: boolean;
  spec: VehicleSpec;
}

export type CarId = 'aventador' | 'rx7' | 'i20n';

export const CARS: CarDef[] = [
  {
    id: 'aventador',
    label: 'Aventador LP700-4',
    detail: 'V12 6,5 L · 690 Nm · intégrale',
    model: 'models/cars/aventador.glb',
    yaw: Math.PI,
    wheels: [
      'Lamborghini_Aventador_Wheel_FL',
      'Lamborghini_Aventador_Wheel_FR',
      'Lamborghini_Aventador_Wheel_RL',
      'Lamborghini_Aventador_Wheel_RR',
    ],
    brakeGlow: true,
    spec: {
      ...STOCK_SPEC,
      name: 'Aventador',
      mass: 1575,
      peakTorque: 690,
      peakTorqueRpm: 5500,
      redlineRpm: 8250,
      upshiftRpm: 7900,
      finalDrive: 3.42,
      dragArea: 0.72,
      downforceArea: 1.45,
      muFront: 1.32,
      muRear: 1.3,
      peakSlipAngle: 0.14,
      springK: 43000,
      springC: 4400,
      arbFront: 24000,
      arbRear: 16000,
      rideHeight: 0.3,
      wheelRadius: 0.35,
      wheelTravel: 0.1,
      brakeTorque: 1800,
      maxSteer: 0.62,
      steerRate: 2.8,
      wheelbase: 2.749,
      track: 1.709,
      bodyHalf: { x: 1, y: 0.45, z: 2.2 },
    },
  },
  {
    id: 'rx7',
    label: 'RX-7 FD3S',
    detail: '13B birotor turbo · 300 Nm · propulsion',
    model: 'models/cars/rx7.glb',
    yaw: Math.PI,
    wheels: ['FL_WHEEL', 'FR_WHEEL', 'RL_WHEEL', 'RR_WHEEL'],
    brakeGlow: true,
    spec: {
      ...STOCK_SPEC,
      name: 'RX-7',
      mass: 1310,
      peakTorque: 300,
      peakTorqueRpm: 4800,
      redlineRpm: 8000,
      upshiftRpm: 7600,
      finalDrive: 4.1,
      dragArea: 0.63,
      downforceArea: 0.55,
      muFront: 1.26,
      muRear: 1.2,
      peakSlipAngle: 0.14,
      springK: 32000,
      springC: 3700,
      arbFront: 15000,
      arbRear: 10000,
      rideHeight: 0.33,
      wheelRadius: 0.316,
      wheelTravel: 0.13,
      brakeTorque: 1200,
      maxSteer: 0.72,
      steerRate: 3,
      wheelbase: 2.449,
      // Measured between the tyre centres in the model, not between the
      // node pivots: the RX-7's wheels are authored with an outboard pivot.
      track: 1.495,
      bodyHalf: { x: 0.9, y: 0.42, z: 2.05 },
    },
  },
  {
    id: 'i20n',
    label: 'i20 N Rally2',
    detail: '1,6 L turbo · 420 Nm · châssis rallye',
    model: 'models/cars/i20n.glb',
    yaw: 0,
    wheels: ['FL_WHEEL', 'FR_WHEEL', 'RL_WHEEL', 'RR_WHEEL'],
    brakeGlow: true,
    spec: {
      ...STOCK_SPEC,
      name: 'i20 N',
      mass: 1230,
      peakTorque: 420,
      peakTorqueRpm: 3200,
      redlineRpm: 7200,
      upshiftRpm: 6800,
      finalDrive: 4.35,
      dragArea: 0.82,
      downforceArea: 0.55,
      muFront: 1.14,
      muRear: 1.08,
      peakSlipAngle: 0.17,
      springK: 28000,
      springC: 3000,
      arbFront: 9000,
      arbRear: 7000,
      rideHeight: 0.375,
      wheelRadius: 0.33,
      wheelTravel: 0.21,
      brakeTorque: 1350,
      maxSteer: 0.78,
      steerRate: 3.2,
      wheelbase: 2.59,
      track: 1.735,
      bodyHalf: { x: 0.95, y: 0.5, z: 1.95 },
    },
  },
];

export const DEFAULT_CAR: CarId = 'aventador';

const STORAGE_KEY = 'sp95.car';

export function findCar(id: string | null): CarDef {
  return CARS.find((car) => car.id === id) ?? CARS.find((car) => car.id === DEFAULT_CAR) ?? CARS[0];
}

export function loadCarId(): CarId {
  try {
    return findCar(localStorage.getItem(STORAGE_KEY)).id;
  } catch {
    return DEFAULT_CAR;
  }
}

export function saveCarId(id: CarId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private mode: the choice just does not persist.
  }
}
