/**
 * Les profils de rendu proposés dans le panneau Graphismes.
 *
 * Chaque profil couleur tient dans **une seule** passe plein écran : pas de
 * bloom, pas de flou de profondeur, pas de seconde scène. « Nature » n'ajoute
 * aucun passage. Le but est de pouvoir embellir l'image sans transformer un
 * téléphone en radiateur.
 */

export type ShaderPresetId = 'nature' | 'cinema' | 'vif';

export interface ShaderGrade {
  contrast: number;
  saturation: number;
  /** Équilibre chaud, en espace d'affichage (0 = neutre). */
  warmth: number;
  vignette: number;
  grain: number;
}

export interface ShaderPreset {
  id: ShaderPresetId;
  label: string;
  detail: string;
  /** Coût affiché au joueur : le nombre de passes est le vrai budget. */
  cost: string;
  grade: ShaderGrade | null;
}

export const SHADER_PRESETS: readonly ShaderPreset[] = [
  {
    id: 'nature',
    label: 'Nature',
    detail: 'Le rendu d’origine, sans post-traitement.',
    cost: '0 passe',
    grade: null,
  },
  {
    id: 'cinema',
    label: 'Cinéma',
    detail: 'Chaleur, contraste et vignette, avec un grain fin.',
    cost: '1 passe · léger',
    grade: {
      contrast: 1.07,
      saturation: 1.08,
      warmth: 0.018,
      vignette: 0.24,
      grain: 0.012,
    },
  },
  {
    id: 'vif',
    label: 'Vif',
    detail: 'Couleurs franches et contraste net, sans grain.',
    cost: '1 passe · léger',
    grade: {
      contrast: 1.11,
      saturation: 1.18,
      warmth: 0.004,
      vignette: 0.1,
      grain: 0,
    },
  },
];

export const SHADER_STORAGE_KEY = 'sp95.shader';
export const DEFAULT_SHADER: ShaderPresetId = 'nature';

export function parseShaderPreset(value: unknown): ShaderPresetId | null {
  if (typeof value !== 'string') return null;
  const found = SHADER_PRESETS.find((preset) => preset.id === value);
  return found ? found.id : null;
}

export function findShaderPreset(id: ShaderPresetId): ShaderPreset {
  return SHADER_PRESETS.find((preset) => preset.id === id) ?? SHADER_PRESETS[0];
}

/** `?shader=cinema` sert aux captures et au contrôle, sans toucher au stockage. */
export function shaderFromSearch(search: string): ShaderPresetId | null {
  return parseShaderPreset(new URLSearchParams(search).get('shader'));
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadShaderPreset(
  storage: ReadableStorage | null = defaultStorage(),
  search = typeof window === 'undefined' ? '' : window.location.search,
): ShaderPresetId {
  const requested = shaderFromSearch(search);
  if (requested) return requested;
  if (!storage) return DEFAULT_SHADER;
  try {
    return parseShaderPreset(storage.getItem(SHADER_STORAGE_KEY)) ?? DEFAULT_SHADER;
  } catch {
    return DEFAULT_SHADER;
  }
}

export function saveShaderPreset(
  id: ShaderPresetId,
  storage: WritableStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SHADER_STORAGE_KEY, id);
  } catch {
    // Stockage plein ou navigation privée : le choix vaut pour la session.
  }
}
