import RAPIER from '@dimforge/rapier3d-compat';
import type { GuardrailPlacement } from '../world/terrain.ts';

/**
 * Contact glissière. Le ruban de collision a presque aucun frottement, mais
 * Rapier résout quand même le choc comme un mur : à 120 km/h, une attaque de
 * trois quarts arrêtait la caisse ou la faisait grimper sur le haut du rail.
 *
 * Ici on ne supprime que la composante de vitesse qui entre dans le rail ; la
 * composante tangentielle reste intacte, avec une infime impulsion de rappel
 * vers la route. Le vy positif est plafonné : un contact latéral ne doit pas
 * transformer la glissière en tremplin.
 */

export interface RailVelocity {
  x: number;
  y: number;
  z: number;
}

/** Vitesse après un contact contre un rail de normale (nx, nz) vers le ravin. */
export function railSlideVelocity(v: RailVelocity, nx: number, nz: number): RailVelocity {
  const inward = v.x * nx + v.z * nz;
  // Déjà en train de s'éloigner : on ne touche à rien.
  if (inward <= 0) return v;
  const restitution = 0.04;
  return {
    x: v.x - nx * inward * (1 + restitution),
    y: Math.min(v.y, 0.75),
    z: v.z - nz * inward * (1 + restitution),
  };
}

/** Tronçon le plus proche du point, en X/Z. */
function nearestPlacement(
  placements: GuardrailPlacement[],
  x: number,
  z: number,
): GuardrailPlacement | null {
  let best: GuardrailPlacement | null = null;
  let bestDistance = Infinity;
  for (const place of placements) {
    const d = (place.x - x) ** 2 + (place.z - z) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = place;
    }
  }
  return best;
}

/**
 * Projette la vitesse du véhicule le long du rail s'il le touche vraiment.
 * Retourne vrai quand un contact a été trouvé et corrigé.
 */
export function slideAlongGuardrail(
  world: RAPIER.World,
  bodyCollider: RAPIER.Collider | null,
  railCollider: RAPIER.Collider | null,
  body: RAPIER.RigidBody,
  placements: GuardrailPlacement[],
): boolean {
  if (!bodyCollider || !railCollider || placements.length === 0) return false;

  let touching = false;
  world.contactPair(bodyCollider, railCollider, () => {
    touching = true;
  });
  if (!touching) return false;

  const translation = body.translation();
  const place = nearestPlacement(placements, translation.x, translation.z);
  if (!place) return false;

  // Le lacet du tronçon suit son axe local +X. La normale côté ravin est
  // up × tangente, soit (sin yaw, cos yaw) en X/Z.
  const nx = Math.sin(place.yaw);
  const nz = Math.cos(place.yaw);
  const velocity = body.linvel();
  const slid = railSlideVelocity({ x: velocity.x, y: velocity.y, z: velocity.z }, nx, nz);
  if (slid === velocity) return false;
  body.setLinvel(slid, true);
  return true;
}
