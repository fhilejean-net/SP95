/**
 * Les deux cartes du jeu. La ville tient dans un seul monde depuis le début ;
 * le circuit de Suzuka a le sien, plus petit et centré sur sa dalle, parce que
 * sa piste occupe tout l'espace et que rien de la ville n'y a sa place.
 *
 * La carte se choisit dans l'URL : `?map=suzuka`. Tout le reste retombe sur la
 * ville, y compris une valeur inconnue.
 */

export type MapId = 'ville' | 'suzuka' | 'sp95' | 'col';

export interface MapInfo {
  id: MapId;
  /** Nom affiché au joueur. */
  name: string;
  blurb: string;
}

export const MAPS: Record<MapId, MapInfo> = {
  ville: {
    id: 'ville',
    name: 'Ville & campagne',
    blurb: 'La carte d’origine : ville quadrillée, ceinture routière, col et rallye.',
  },
  suzuka: {
    id: 'suzuka',
    name: 'Circuit de Suzuka',
    blurb: 'Le tracé 2001 seul, sur son plateau de campagne.',
  },
  sp95: {
    id: 'sp95',
    name: 'Circuit SP95',
    blurb: 'La piste dessinée par le jeu : plate de bout en bout, murs solides.',
  },
  col: {
    id: 'col',
    name: 'Col de nuit',
    blurb: 'Le Mollendruz de nuit : route forestière, corniche et parking au col.',
  },
};

export const DEFAULT_MAP: MapId = 'ville';

/**
 * Destination de chaque bouton du menu d'accueil. Les boutons y puisent leur
 * carte et leur session, au lieu de recopier l'information : deux entrées qui
 * visent la même session sont un défaut à corriger, pas une variante.
 */
export const MENU_ROUTES = {
  'btn-free': { map: 'ville', start: 'free' },
  'btn-race': { map: 'ville', start: 'race' },
  'btn-circuit': { map: 'suzuka', start: 'free' },
  'btn-flat': { map: 'sp95', start: 'free' },
  'btn-colmap': { map: 'col', start: 'free' },
  'btn-rally': { map: 'ville', start: 'free', spawn: 'rally' },
  'btn-sommet': { map: 'ville', start: 'free', spawn: 'summit' },
  'btn-moto': { map: 'ville', start: 'moto' },
  'btn-cars': { map: 'sp95', open: 'showroom' },
  'btn-garage': { map: 'sp95', open: 'garage' },
  'btn-sound': { map: 'sp95', open: 'sound' },
} as const satisfies Record<string, { map: MapId } & Record<string, string>>;

/** Carte demandée dans une query string ; la ville pour tout le reste. */
export function mapFromSearch(search: string): MapId {
  const asked = new URLSearchParams(search).get('map');
  return asked === 'suzuka' || asked === 'sp95' || asked === 'col' ? asked : DEFAULT_MAP;
}

/**
 * URL de `href` (absolue) pointant sur la carte demandée, avec les paramètres
 * de lancement fournis. Une bascule de carte invalide la session de la
 * précédente : `start`, `spawn` et `open` sont effacés avant d'être reposés,
 * sinon on demanderait une course à une carte qui n'en a pas.
 */
export function mapUrl(id: MapId, href: string, launch: Record<string, string> = {}): string {
  const url = new URL(href);
  if (id === DEFAULT_MAP) url.searchParams.delete('map');
  else url.searchParams.set('map', id);
  for (const key of ['start', 'spawn', 'open']) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(launch)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * L'écran d'accueil est l'URL nue. Une carte demandée, ou une session à
 * lancer (`start`, `spawn`, `open`), construisent le monde : sinon
 * `?start=free` sans `map` renvoyait sur le menu au lieu de démarrer la ville.
 */
export function isMenuOnly(search: string): boolean {
  const query = new URLSearchParams(search);
  return !query.has('map') && !query.has('start') && !query.has('spawn') && !query.has('open');
}

/** Carte de la session : l'URL, lue une fois au chargement. */
export const MAP_ID: MapId = mapFromSearch(
  typeof window === 'undefined' ? '' : window.location.search,
);
