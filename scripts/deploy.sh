#!/usr/bin/env bash
# Publish app/ to the gh-pages branch (GitHub Pages), stamping the service
# worker version so installed apps pick up the update.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
rm -rf dist && mkdir -p dist
cp -R app/. dist/
sed -i "s/__BUILD__/${VERSION}/" dist/sw.js
touch dist/.nojekyll
cd dist
git init -q -b gh-pages
git add -A
git -c user.name="${GIT_AUTHOR_NAME:-Entiendo deploy}" -c user.email="${GIT_AUTHOR_EMAIL:-deploy@users.noreply.github.com}" commit -q -m "Deploy ${VERSION}"
git push -q --force "$(git -C .. remote get-url origin)" gh-pages
echo "Deployed ${VERSION}"
