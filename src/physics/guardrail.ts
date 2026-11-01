import RAPIER from '@dimforge/rapier3d-compat';
import type { GuardrailPlacement } from '../world/terrain.ts';

/**
 * Contact glissière. Le ruban de collision a presque aucun frottement, mais
 * Rapier résout quand même le choc comme un mur : à 120 km/h, une attaque de
 * trois quarts arrêtait la caisse ou la faisait grimper sur le haut du rail.
 *
 * Ici on supprime la composante de vitesse qui entre dans le rail, sans
 * rebond, et on laisse la composante tangentielle glisser. Le lacet est
 * légèrement amorti pendant le contact : sans cela, la caisse gardait son
 * angle d'attaque et continuait à tourner le long du rail. Le vy positif est
 * plafonné : un contact latéral ne doit pas transformer la glissière en
 * tremplin.
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
  const restitution = 0;
  return {
    x: v.x - nx * inward * (1 + restitution),
    y: Math.min(v.y, 0.35),
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
  // Un rail réel ne fait pas pivoter la voiture comme une toupie : il la
  // redresse dans l'axe du ruban. On amortit surtout le lacet, en gardant un
  // peu de roulis pour ne pas figer la caisse contre la glissière.
  const angular = body.angvel();
  body.setAngvel(
    { x: angular.x * 0.95, y: angular.y * 0.82, z: angular.z * 0.95 },
    true,
  );
  return true;
}
