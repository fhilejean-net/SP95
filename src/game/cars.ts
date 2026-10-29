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
  /** One line of provenance, shown in the picker. */
  origin?: string;
  spec: VehicleSpec;
}

export type CarId =
  | 'aventador'
  | 'rx7'
  | 'i20n'
  | 'gt40'
  | '911'
  | 'trueno'
  | 'fk8'
  | 'yaris'
  | 'rs7'
  | 'apollo'
  | 'f1';

export const CARS: CarDef[] = [
  {
    id: 'aventador',
    label: 'Aventador LP700-4',
    detail: 'V12 6,5 L · 690 Nm · intégrale',
    model: 'models/vehicles/aventador.glb',
    yaw: Math.PI,
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
      // Haldex-style: mostly rear, but the front axle pulls too.
      driveFront: 0.4,
      tractionControl: 0.78,
    },
  },
  {
    id: 'rx7',
    label: 'RX-7 FD3S',
    detail: '13B birotor turbo · 300 Nm · propulsion',
    model: 'models/vehicles/rx7.glb',
    yaw: Math.PI,
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
      driveFront: 0,
      tractionControl: 0.45,
    },
  },
  {
    id: 'i20n',
    label: 'i20 N Rally2',
    detail: '1,6 L turbo · 420 Nm · châssis rallye',
    model: 'models/vehicles/i20n.glb',
    yaw: 0,
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
      // A Rally2 car is four-wheel drive: sending all that torque to the back
      // axle was what turned a launch into a burnout.
      driveFront: 0.5,
      tractionControl: 0.9,
    },
  },
  {
    id: 'gt40',
    label: 'Ford GT 2005',
    detail: 'V8 5,4 L · 680 Nm · propulsion',
    origin: 'vecarz.com',
    model: 'models/vehicles/GT40/ford_gt40_2005__www.vecarz.com.glb',
    yaw: Math.PI,
    spec: {
      ...STOCK_SPEC,
      name: 'Ford GT',
      mass: 1585,
      peakTorque: 680,
      peakTorqueRpm: 4500,
      redlineRpm: 6500,
      upshiftRpm: 6100,
      finalDrive: 3.36,
      dragArea: 0.71,
      downforceArea: 0.7,
      muFront: 1.3,
      muRear: 1.28,
      peakSlipAngle: 0.14,
      springK: 40000,
      springC: 4200,
      arbFront: 20000,
      arbRear: 13000,
      rideHeight: 0.32,
      wheelRadius: 0.34,
      wheelTravel: 0.12,
      brakeTorque: 1600,
      maxSteer: 0.62,
      steerRate: 2.9,
      wheelbase: 2.71,
      track: 1.62,
      bodyHalf: { x: 0.98, y: 0.45, z: 2.2 },
      driveFront: 0,
      tractionControl: 0.55,
    },
  },
  {
    id: '911',
    label: 'Porsche 911 930 Turbo',
    detail: 'Flat-6 3,0 L turbo · 400 Nm · propulsion',
    model: 'models/vehicles/911/free_1975_porsche_911_930_turbo.glb',
    yaw: Math.PI,
    spec: {
      ...STOCK_SPEC,
      name: '911 Turbo',
      mass: 1140,
      peakTorque: 400,
      peakTorqueRpm: 4000,
      redlineRpm: 6800,
      upshiftRpm: 6400,
      finalDrive: 3.9,
      dragArea: 0.62,
      downforceArea: 0.3,
      // Pneus arrière plus larges que les avant : c'est la voiture qui a rendu
      // célèbre le survirage de décélération.
      muFront: 1.22,
      muRear: 1.3,
      peakSlipAngle: 0.16,
      springK: 26000,
      springC: 2900,
      arbFront: 10000,
      arbRear: 9000,
      rideHeight: 0.3,
      wheelRadius: 0.32,
      wheelTravel: 0.12,
      brakeTorque: 1100,
      maxSteer: 0.8,
      steerRate: 3.1,
      wheelbase: 2.27,
      track: 1.45,
      bodyHalf: { x: 0.9, y: 0.42, z: 1.95 },
      driveFront: 0,
      // Aucune électronique en 1975 : il n'y a que le pied droit.
      tractionControl: 0.35,
    },
  },
  {
    id: 'trueno',
    label: 'Toyota AE86 Trueno',
    detail: '4A-GE 1,6 L · 190 Nm · propulsion',
    origin: 'Project D',
    model:
      'models/vehicles/trueno/1985_toyota_sprinter_trueno_ae86_project_d.glb',
    yaw: Math.PI,
    spec: {
      ...STOCK_SPEC,
      name: 'AE86',
      mass: 940,
      peakTorque: 190,
      peakTorqueRpm: 5800,
      redlineRpm: 7800,
      upshiftRpm: 7400,
      finalDrive: 4.3,
      dragArea: 0.68,
      downforceArea: 0.15,
      muFront: 1.2,
      muRear: 1.16,
      peakSlipAngle: 0.15,
      springK: 22000,
      springC: 2400,
      arbFront: 8000,
      arbRear: 6000,
      rideHeight: 0.3,
      wheelRadius: 0.3,
      wheelTravel: 0.15,
      brakeTorque: 900,
      maxSteer: 0.85,
      steerRate: 3.3,
      wheelbase: 2.4,
      track: 1.35,
      bodyHalf: { x: 0.82, y: 0.4, z: 1.95 },
      driveFront: 0,
      tractionControl: 0.15,
    },
  },
  {
    id: 'fk8',
    label: 'Civic Type R FK8',
    detail: '2,0 L VTEC turbo · 400 Nm · traction',
    model: 'models/vehicles/fk8/2018_honda_civic_type_r_varis_fk8_vaho-17.glb',
    yaw: Math.PI,
    spec: {
      ...STOCK_SPEC,
      name: 'Type R',
      mass: 1380,
      peakTorque: 400,
      peakTorqueRpm: 2500,
      redlineRpm: 7000,
      upshiftRpm: 6600,
      finalDrive: 3.84,
      dragArea: 0.78,
      downforceArea: 0.5,
      muFront: 1.34,
      muRear: 1.24,
      peakSlipAngle: 0.15,
      springK: 30000,
      springC: 3200,
      arbFront: 12000,
      arbRear: 8000,
      rideHeight: 0.33,
      wheelRadius: 0.33,
      wheelTravel: 0.13,
      brakeTorque: 1350,
      maxSteer: 0.72,
      steerRate: 3,
      wheelbase: 2.7,
      track: 1.6,
      bodyHalf: { x: 0.92, y: 0.46, z: 2.05 },
      // Une traction : tout le couple passe devant, d'où l'antipatinage haut.
      driveFront: 0.9,
      tractionControl: 0.7,
    },
  },
  {
    id: 'yaris',
    label: 'Toyota GR Yaris',
    detail: '1,6 L turbo · 370 Nm · GR-Four',
    model: 'models/vehicles/yaris/2021_toyota_gr_yaris.glb',
    yaw: Math.PI,
    spec: {
      ...STOCK_SPEC,
      name: 'GR Yaris',
      mass: 1285,
      peakTorque: 370,
      peakTorqueRpm: 3000,
      redlineRpm: 7200,
      upshiftRpm: 6800,
      finalDrive: 4,
      dragArea: 0.76,
      downforceArea: 0.4,
      muFront: 1.3,
      muRear: 1.28,
      peakSlipAngle: 0.15,
      springK: 30000,
      springC: 3200,
      arbFront: 12000,
      arbRear: 9000,
      rideHeight: 0.35,
      wheelRadius: 0.325,
      wheelTravel: 0.16,
      brakeTorque: 1300,
      maxSteer: 0.78,
      steerRate: 3.2,
      wheelbase: 2.56,
      track: 1.56,
      bodyHalf: { x: 0.9, y: 0.45, z: 1.9 },
      driveFront: 0.55,
      tractionControl: 0.7,
    },
  },
  {
    id: 'rs7',
    label: 'Audi RS7 ABT',
    detail: 'V8 4,0 L biturbo · 900 Nm · quattro',
    origin: 'ABT 2022',
    model: 'models/vehicles/RS7/2022_abt_audi_rs7-r.glb',
    yaw: Math.PI,
    spec: {
      ...STOCK_SPEC,
      name: 'RS7 ABT',
      mass: 2065,
      peakTorque: 900,
      peakTorqueRpm: 2500,
      redlineRpm: 6800,
      upshiftRpm: 6400,
      finalDrive: 3.2,
      dragArea: 0.78,
      downforceArea: 0.35,
      muFront: 1.28,
      muRear: 1.26,
      peakSlipAngle: 0.15,
      springK: 44000,
      springC: 4400,
      arbFront: 18000,
      arbRear: 12000,
      rideHeight: 0.34,
      wheelRadius: 0.35,
      wheelTravel: 0.12,
      brakeTorque: 2000,
      maxSteer: 0.66,
      steerRate: 2.8,
      wheelbase: 2.93,
      track: 1.66,
      bodyHalf: { x: 0.98, y: 0.5, z: 2.3 },
      driveFront: 0.45,
      tractionControl: 0.8,
    },
  },
  {
    id: 'apollo',
    label: 'Apollo Intensa Emozione',
    detail: 'V12 6,3 L · 760 Nm · propulsion',
    origin: 'Project Evo 2022',
    model: 'models/vehicles/apollo/2022_apollo_project_evo.glb',
    yaw: Math.PI,
    spec: {
      ...STOCK_SPEC,
      name: 'Apollo IE',
      mass: 1250,
      peakTorque: 760,
      peakTorqueRpm: 6000,
      redlineRpm: 8500,
      upshiftRpm: 8100,
      finalDrive: 3.6,
      dragArea: 0.72,
      downforceArea: 1.6,
      muFront: 1.4,
      muRear: 1.38,
      peakSlipAngle: 0.13,
      springK: 52000,
      springC: 5200,
      arbFront: 26000,
      arbRear: 18000,
      rideHeight: 0.28,
      wheelRadius: 0.34,
      wheelTravel: 0.1,
      brakeTorque: 1750,
      maxSteer: 0.6,
      steerRate: 2.7,
      wheelbase: 2.7,
      track: 1.68,
      bodyHalf: { x: 1, y: 0.42, z: 2.25 },
      driveFront: 0,
      tractionControl: 0.7,
    },
  },
  {
    id: 'f1',
    label: 'McLaren MCL35M',
    detail: 'V6 1,6 L hybride · 1 000 ch · 752 kg',
    origin: 'Formule 1 · 2021',
    // Version optimisée du GLB fourni : 23,4 Mo → 3,8 Mo (meshopt + WebP),
    // sans perte visible à l'écran. Le décodeur meshopt est branché dans
    // carModel.ts, sinon la géométrie n'arrive pas.
    model: 'models/vehicles/f1_mclaren_mcl35m_opt.glb',
    // Le nez du modèle pointe vers -Z, le sens de marche du jeu.
    yaw: 0,
    spec: {
      ...STOCK_SPEC,
      name: 'MCL35M',
      mass: 752,
      // Courbe de couple volontairement ramenée dans la plage que le modèle
      // d'embrayage du jeu sait lancer : à 9 500 tr/min le point de couple
      // restait au-dessus du régime de décollage et la boîte oscillait entre
      // marche arrière et première sans jamais transmettre aux roues.
      peakTorque: 700,
      peakTorqueRpm: 6000,
      redlineRpm: 9500,
      upshiftRpm: 9000,
      finalDrive: 3.5,
      dragArea: 1.08,
      // Un plancher et un aileron arrière de F1 : l'appui n'a rien à voir avec
      // une GT. C'est ce qui rend la voiture collée dans les courbes rapides.
      downforceArea: 4.4,
      muFront: 1.78,
      muRear: 1.86,
      peakSlipAngle: 0.12,
      // Suspension réglée dans la plage que la physique du jeu sait tenir :
      // une monoplace réelle est plus rigide, mais un ressort de 135 kN/m
      // bloquait la caisse sur ses butées et la voiture ne décollait pas.
      springK: 52000,
      springC: 5200,
      arbFront: 26000,
      arbRear: 18000,
      rideHeight: 0.28,
      wheelRadius: 0.36,
      wheelTravel: 0.1,
      brakeTorque: 1900,
      maxSteer: 0.55,
      steerRate: 3.4,
      wheelbase: 3.6,
      track: 1.6,
      bodyHalf: { x: 1.02, y: 0.42, z: 2.84 },
      driveFront: 0,
      tractionControl: 0.55,
    },
  },
  // Le Mazda 787B n'est pas au registre : son GLB est un seul maillage
  // « bodywithnowheels », treize primitives fusionnées sur toute la voiture,
  // sans le moindre moyeu à extraire. Sans roues, il n'y a ni échelle à
  // mesurer ni points de contact à poser : la voiture resterait plantée sur
  // des jantes fantômes. Il reviendra le jour où le modèle aura ses roues.
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
