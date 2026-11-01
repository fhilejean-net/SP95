#!/usr/bin/env python3
"""Étape 1 : téléchargement en cache des données OSM autour du Mollendruz."""
from pathlib import Path
import json
import urllib.parse
import urllib.request

SEARCH_BBOX = (6.330, 46.600, 6.450, 46.670)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
RAW_FILE = Path("data/raw/osm_search.json")
TIMEOUT_SECONDS = 150
QUERY = '''[out:json][timeout:90];
( way["highway"](46.600,6.330,46.670,6.450);
  way["amenity"="parking"](46.600,6.330,46.670,6.450);
  node["amenity"="parking"](46.600,6.330,46.670,6.450);
  node["place"~"village|hamlet"](46.600,6.330,46.670,6.450);
  node["traffic_sign"~"city_limit"](46.600,6.330,46.670,6.450);
  way["landuse"="residential"](46.600,6.330,46.670,6.450); );
out geom tags;'''


def main():
    if not RAW_FILE.exists():
        RAW_FILE.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(
            OVERPASS_URL,
            data=urllib.parse.urlencode({"data": QUERY}).encode(),
            headers={"User-Agent": "SP95 Mollendruz research/1.0", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                body = response.read()
            result = json.loads(body)
            if "elements" not in result or result.get("remark"):
                raise ValueError(f"Réponse Overpass incomplète : {result.get('remark')}")
            RAW_FILE.write_bytes(body)
        except Exception as error:
            raise SystemExit(f"Échec de {OVERPASS_URL} : {error}") from error
    result = json.loads(RAW_FILE.read_text(encoding="utf-8"))
    print(f"OSM cache : {RAW_FILE}, {len(result['elements'])} éléments")


if __name__ == "__main__":
    main()
