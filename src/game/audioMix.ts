/**
 * The sound mix: one channel per voice family, persisted in the browser so the
 * player keeps their balance between sessions. Kept free of Web Audio so the
 * panel and the tests can use it without an audio context.
 */

export const SOUND_CHANNELS = [
  'master',
  'engine',
  'intake',
  'exhaust',
  'turbo',
  'tyres',
  'gravel',
  'wind',
  'effects',
] as const;

export type SoundChannel = (typeof SOUND_CHANNELS)[number];

export type SoundMix = Record<SoundChannel, number>;

export interface SoundChannelDef {
  key: SoundChannel;
  label: string;
  hint: string;
}

export const SOUND_CHANNEL_DEFS: SoundChannelDef[] = [
  { key: 'master', label: 'Général', hint: 'Volume de tout le jeu' },
  { key: 'engine', label: 'Moteur', hint: 'Le bloc et sa charge' },
  { key: 'intake', label: 'Admission', hint: "Le souffle à l'accélérateur" },
  { key: 'exhaust', label: 'Échappement', hint: 'Grave et rauque, plus fort en ligne libérée' },
  { key: 'turbo', label: 'Turbo', hint: 'Sifflement, dump valve et flutter' },
  { key: 'tyres', label: 'Pneus', hint: 'Crissement en glisse' },
  { key: 'gravel', label: 'Gravier', hint: 'Roulement sur terre et cailloux' },
  { key: 'wind', label: 'Vent', hint: 'Souffle à haute vitesse' },
  { key: 'effects', label: 'Effets', hint: 'Pops, passages de rapport, chocs' },
];

/**
 * Defaults are the rebalanced mix: the turbo whine, the tyre squeal and the
 * dump-valve were sitting on top of everything else, so they start lower than
 * the engine itself.
 */
export const DEFAULT_MIX: SoundMix = {
  master: 0.8,
  engine: 0.95,
  intake: 0.6,
  exhaust: 0.8,
  turbo: 0.4,
  tyres: 0.5,
  gravel: 0.55,
  wind: 0.45,
  effects: 0.75,
};

export const MIX_STORAGE_KEY = 'sp95.audioMix';

export function clampChannel(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
}

/** Builds a valid mix from any stored value: unknown keys are ignored. */
export function sanitizeMix(input: unknown): SoundMix {
  const mix: SoundMix = { ...DEFAULT_MIX };
  if (!input || typeof input !== 'object') return mix;
  const raw = input as Record<string, unknown>;
  for (const channel of SOUND_CHANNELS) {
    if (channel in raw) mix[channel] = clampChannel(raw[channel], DEFAULT_MIX[channel]);
  }
  return mix;
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

export function loadMix(storage: ReadableStorage | null = defaultStorage()): SoundMix {
  if (!storage) return { ...DEFAULT_MIX };
  try {
    const raw = storage.getItem(MIX_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MIX };
    return sanitizeMix(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_MIX };
  }
}

export function saveMix(mix: SoundMix, storage: WritableStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(MIX_STORAGE_KEY, JSON.stringify(mix));
  } catch {
    /* private mode / quota: the mix just is not remembered */
  }
}
