import * as THREE from 'three';

/**
 * Ancrage visuel du véhicule : une ombre de contact et un reflet d'asphalte,
 * deux décalques qui suivent la voiture au ras du sol.
 *
 * Pourquoi pas la carte d'ombres du soleil ? Elle tourne (compteur de passes
 * vérifié) mais ne dépose rien sur la piste sur ce rendu-ci, et une passe de
 * réflexion plein écran coûte une seconde scène par image — hors budget sur un
 * circuit de 180 000 triangles. Deux quads et quelques maillages copiés donnent
 * l'essentiel du message : le véhicule touche le sol et l'asphalte le renvoie.
 *
 * Tout se règle ici, en haut du module : opacités, écrasement du miroir, taille
 * de l'empreinte.
 */

/** Opacité du disque d'ombre au contact. */
const CONTACT_OPACITY = 0.66;
/** Marge du disque autour de l'empreinte réelle du véhicule. */
const CONTACT_PADDING = 1.3;
/** Hauteur des décalques au-dessus de la surface, contre le z-fighting. */
const DECAL_LIFT = 0.03;
/** Opacité du reflet. Au-delà de 0,3 l'asphalte a l'air d'un miroir. */
const REFLECTION_OPACITY = 0.24;
/** Écrasement vertical du miroir : vu de haut, un reflet est court. */
const REFLECTION_SQUASH = 0.42;
/** Teinte du reflet : plus sombre que la peinture, comme une flaque. */
const REFLECTION_TINT = 0x8d949c;
/** Nombre de maillages copiés dans le reflet (les plus lourds). */
const REFLECTION_MESH_LIMIT = 3;
/** Hauteur (m) à partir de laquelle le véhicule ne touche plus le sol. */
const AIRBORNE_START = 0.9;
/** Durée de l'effacement, en mètres de hauteur en plus. */
const AIRBORNE_FADE = 1.1;

export interface Grounding {
  /** Reconstruit le reflet sur le véhicule courant (modèle changé). */
  attach(source: THREE.Object3D): void;
  /** Suit le véhicule : position, cap, hauteur au-dessus du sol. */
  update(source: THREE.Object3D, groundY: number): void;
  setVisible(on: boolean): void;
  dispose(): void;
}

/** Disque noir qui s'éteint vers le bord : l'ombre de contact. */
function contactTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0.95)');
  gradient.addColorStop(0.42, 'rgba(0,0,0,0.6)');
  gradient.addColorStop(0.72, 'rgba(0,0,0,0.2)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** Cap du véhicule : l'axe local −Z, comme partout dans le jeu. */
function yawOf(quaternion: THREE.Quaternion): number {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  return Math.atan2(-forward.x, -forward.z);
}

function trianglesOf(mesh: THREE.Mesh): number {
  const index = mesh.geometry.getIndex();
  if (index) return index.count / 3;
  const position = mesh.geometry.getAttribute('position');
  return position ? position.count / 3 : 0;
}

export function createGrounding(scene: THREE.Scene): Grounding {
  const root = new THREE.Group();
  root.name = 'grounding';
  root.matrixAutoUpdate = true;
  scene.add(root);

  const texture = contactTexture();
  const contactMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    color: 0x000000,
    transparent: true,
    opacity: CONTACT_OPACITY,
    depthWrite: false,
  });
  // Un seul quad réutilisé : son échelle suit l'empreinte du véhicule.
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), contactMaterial);
  contact.rotation.x = -Math.PI / 2;
  contact.renderOrder = 2;
  root.add(contact);

  // Le miroir porte sa propre échelle verticale négative : le quad d'ombre, lui,
  // doit rester tourné vers le ciel, sinon il est éliminé dos à la caméra.
  const mirror = new THREE.Group();
  mirror.name = 'grounding-mirror';
  mirror.scale.set(1, -REFLECTION_SQUASH, 1);
  root.add(mirror);

  /** Maillages du reflet et leurs matériaux (les géométries sont partagées). */
  let reflection: THREE.Mesh[] = [];
  let reflectionMaterials: THREE.MeshBasicMaterial[] = [];
  /** Empreinte au sol du véhicule attaché : largeur (x), longueur (z). */
  let footprint = { width: 2, length: 4.4 };
  let visible = true;

  function clearReflection(): void {
    for (const mesh of reflection) mirror.remove(mesh);
    for (const material of reflectionMaterials) material.dispose();
    reflection = [];
    reflectionMaterials = [];
  }

  function attach(source: THREE.Object3D): void {
    clearReflection();
    source.updateWorldMatrix(true, true);
    const toLocal = new THREE.Matrix4().copy(source.matrixWorld).invert();

    const meshes: THREE.Mesh[] = [];
    source.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      // Le verre et les éléments transparents ne se réfléchissent pas ainsi :
      // leur reflet donnerait un voile sale sur l'asphalte.
      if (!material || material.transparent) return;
      if (trianglesOf(mesh) < 40) return;
      meshes.push(mesh);
    });
    meshes.sort((a, b) => trianglesOf(b) - trianglesOf(a));

    for (const mesh of meshes.slice(0, REFLECTION_MESH_LIMIT)) {
      const sourceMaterial = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
        | THREE.MeshStandardMaterial
        | undefined;
      const material = new THREE.MeshBasicMaterial({
        map: sourceMaterial?.map ?? null,
        color: REFLECTION_TINT,
        transparent: true,
        opacity: REFLECTION_OPACITY,
        depthWrite: false,
        fog: true,
      });
      const twin = new THREE.Mesh(mesh.geometry, material);
      // Le maillage est copié dans le repère du véhicule : le groupe racine le
      // place ensuite, et son échelle verticale négative fait le miroir.
      twin.matrix.multiplyMatrices(toLocal, mesh.matrixWorld);
      twin.matrixAutoUpdate = false;
      twin.renderOrder = 1;
      mirror.add(twin);
      reflection.push(twin);
      reflectionMaterials.push(material);
    }

    const bounds = new THREE.Box3().setFromObject(source);
    const size = bounds.getSize(new THREE.Vector3());
    if (size.x > 0.2 && size.z > 0.2) footprint = { width: size.x, length: size.z };

  }

  function update(source: THREE.Object3D, groundY: number): void {
    if (!visible) return;
    const position = source.position;
    const yaw = yawOf(source.quaternion);
    root.position.set(position.x, groundY + DECAL_LIFT, position.z);
    root.rotation.y = yaw;

    const height = Math.max(0, position.y - groundY);
    const touch = Math.min(1, Math.max(0, 1 - (height - AIRBORNE_START) / AIRBORNE_FADE));
    contactMaterial.opacity = CONTACT_OPACITY * touch;
    contact.scale.set(footprint.width * CONTACT_PADDING, footprint.length * CONTACT_PADDING, 1);
    contact.visible = touch > 0.02;
    for (const material of reflectionMaterials) material.opacity = REFLECTION_OPACITY * touch;
    for (const mesh of reflection) mesh.visible = touch > 0.02;
  }

  function setVisible(on: boolean): void {
    visible = on;
    root.visible = on;
  }

  function dispose(): void {
    clearReflection();
    root.remove(contact);
    contact.geometry.dispose();
    contactMaterial.dispose();
    texture.dispose();
    scene.remove(root);
  }

  return { attach, update, setVisible, dispose };
}
