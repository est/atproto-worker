#!/bin/sh
# Build the owner console into public/app/.
# Source of truth: app/index.html, app/style.css, app/main.js
set -eu

cd "$(dirname "$0")/.."

mkdir -p public/app
node_modules/.bin/esbuild app/main.js \
  --bundle \
  --format=esm \
  --platform=browser \
  --outfile=public/app/app.js
cp app/index.html public/app/index.html
cp app/style.css public/app/style.css
