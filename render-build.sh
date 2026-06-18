#!/usr/bin/env bash
# render-build.sh — Custom build script to install FFmpeg before building the app
set -o errexit

echo "Installing FFmpeg..."
apt-get update -y
apt-get install -y ffmpeg

echo "FFmpeg installed. Verifying:"
ffmpeg -version

echo "Installing npm dependencies..."
npm install

echo "Building TypeScript..."
npm run build