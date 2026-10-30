#!/usr/bin/env bash
# Prépare un Chromium utilisable pour photographier le jeu, **sans root**.
#
# `npx playwright install --with-deps` échoue dans ce conteneur (`sudo` refuse
# de s'élever : « no new privileges »). On télécharge donc les paquets avec un
# apt dont l'état vit dans le dépôt, et on les extrait dans `.sysroot/` :
# Chromium les trouve par `LD_LIBRARY_PATH`, sans toucher au système.
#
#   bash scripts/chrome-libs.sh
#   source .sysroot/env.sh
#   npm run shot -- --cars supra,crz,kart --view three-quarter
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEBS="$ROOT/.sysroot/debs"
STATE="$ROOT/.apt"

mkdir -p "$DEBS" "$STATE/state/lists/partial" "$STATE/cache/archives/partial" "$STATE/etc"
printf 'deb http://archive.ubuntu.com/ubuntu noble main universe\ndeb http://archive.ubuntu.com/ubuntu noble-updates main universe\n' \
  > "$STATE/etc/sources.list"

APT=(
  -o "Dir::Etc::sourcelist=$STATE/etc/sources.list"
  -o "Dir::Etc::sourceparts=-"
  -o "Dir::State=$STATE/state"
  -o "Dir::Cache=$STATE/cache"
  -o "APT::Get::List-Cleanup=0"
)

apt-get "${APT[@]}" update
cd "$DEBS"
apt-get "${APT[@]}" download \
  libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 \
  libcairo2 libcups2t64 libpango-1.0-0 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libasound2t64 libxi6 libxrender1 libxext6 \
  libgl1 libglx0 libegl1

cd "$ROOT"
for deb in "$DEBS"/*.deb; do dpkg-deb -x "$deb" "$ROOT/.sysroot/root"; done

printf 'export LD_LIBRARY_PATH=%s\n' \
  "$ROOT/.sysroot/root/usr/lib/x86_64-linux-gnu:$ROOT/.sysroot/root/lib/x86_64-linux-gnu" \
  > "$ROOT/.sysroot/env.sh"

npx playwright install chromium
echo
echo "Chromium prêt. Puis :"
echo "  source .sysroot/env.sh"
echo "  npm run shot -- --cars supra,crz,kart --view three-quarter"
echo "Le serveur de dev doit tourner sur http://127.0.0.1:3000/."
