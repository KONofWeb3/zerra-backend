#!/usr/bin/env bash
# render-build.sh — npm install pulls in ffmpeg-static automatically, no apt-get needed
set -o errexit

echo "Installing npm dependencies (includes ffmpeg-static binary download)..."
npm install

echo "Building TypeScript..."
npm run build