import type { BikeSpec } from '../physics/bike.ts';

export interface BikeDef {
  id: 'supermotard';
  label: string;
  detail: string;
  spec: BikeSpec;
}

/**
 * A big single-cylinder supermotard: tall, light, short-geared, and built to
 * lift the front rather than to slide. The mass includes the rider, because on
 * a bike the rider is not a passenger: the centre of gravity moves with him.
 */
export const SUPERMOTARD: BikeDef = {
  id: 'supermotard',
  label: 'Supermotard 701',
  detail: 'Monocylindre 690 cm³ · 68 Nm · 210 kg',
  spec: {
    name: 'Supermotard 701',
    mass: 210,
    peakTorque: 68,
    peakTorqueRpm: 5200,
    redlineRpm: 8500,
    upshiftRpm: 8000,
    ratios: [2.7, 2.1, 1.75, 1.5, 1.3, 1.15],
    finalDrive: 4.1,
    wheelbase: 1.48,
    // The modelled CRF runs 21/18 inch wheels: the radius is the tire's, not
    // the rim's, and the visual is scaled by the wheelbase so the bike sits on
    // exactly these contact patches.
    wheelRadius: 0.335,
    wheelWidthFront: 0.12,
    wheelWidthRear: 0.16,
    muFront: 1.34,
    muRear: 1.3,
    peakSlipAngle: 0.15,
    // A cross bike is at home in the grass and on the trails: knobby tires
    // still give up grip compared with asphalt, but on a surface whose own
    // grip is 0.47 to 0.62 that multiplier has to be well over one, otherwise
    // the bike simply cannot put a wheel down off the road.
    looseGrip: 1.35,
    brakeTorque: 980,
    maxSteer: 0.62,
    steerRate: 3.4,
    dragArea: 0.56,
    downforceArea: 0.04,
    springK: 24000,
    springC: 2600,
    wheelTravel: 0.2,
    cgHeight: 0.72,
    // In a wheelie the rider's weight is behind the axle, which is what lifts
    // the balance point to ~53°: that is the angle he can actually hold.
    cgFromRear: 0.95,
    maxLean: 0.92,
    wheelieGain: 0.95,
  },
};
