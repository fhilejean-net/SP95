/**
 * Les deux cartes du jeu. La ville tient dans un seul monde depuis le début ;
 * le circuit de Suzuka a le sien, plus petit et centré sur sa dalle, parce que
 * sa piste occupe tout l'espace et que rien de la ville n'y a sa place.
 *
 * La carte se choisit dans l'URL : `?map=suzuka`. Tout le reste retombe sur la
 * ville, y compris une valeur inconnue.
 */

export type MapId = 'ville' | 'suzuka';

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
};

export const DEFAULT_MAP: MapId = 'ville';

/** Carte demandée dans une query string ; la ville pour tout le reste. */
export function mapFromSearch(search: string): MapId {
  const asked = new URLSearchParams(search).get('map');
  return asked === 'suzuka' ? 'suzuka' : DEFAULT_MAP;
}

/** URL de `href` (absolue) pointant sur la carte demandée. */
export function mapUrl(id: MapId, href: string): string {
  const url = new URL(href);
  if (id === DEFAULT_MAP) url.searchParams.delete('map');
  else url.searchParams.set('map', id);
  return url.toString();
}

/** Carte de la session : l'URL, lue une fois au chargement. */
export const MAP_ID: MapId = mapFromSearch(
  typeof window === 'undefined' ? '' : window.location.search,
);
