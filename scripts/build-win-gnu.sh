#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_TRIPLE="x86_64-pc-windows-gnu"
BUILD_DIR="$ROOT_DIR/src-tauri/target/$TARGET_TRIPLE/release"
OUT_DIR="$ROOT_DIR/dist/windows"

pnpm tauri build --target "$TARGET_TRIPLE"

mkdir -p "$OUT_DIR"
cp -f "$BUILD_DIR/tauri-ssh-client.exe" "$OUT_DIR/tauri-ssh-client.exe"
cp -f "$BUILD_DIR/WebView2Loader.dll" "$OUT_DIR/WebView2Loader.dll"

printf "Windows artifacts copied to %s\n" "$OUT_DIR"
