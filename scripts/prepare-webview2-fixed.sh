#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist/windows"
RUNTIME_ROOT="$DIST_DIR/FixedRuntime"
CACHE_DIR="$ROOT_DIR/.cache/webview2"

WEBVIEW2_CAB="${WEBVIEW2_CAB:-}"
WEBVIEW2_URL="${WEBVIEW2_FIXED_URL:-}"
NUGET_VERSION="${WEBVIEW2_NUGET_VERSION:-}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/prepare-webview2-fixed.sh --cab /path/to/Microsoft.WebView2.FixedVersionRuntime.*.x64.cab
  scripts/prepare-webview2-fixed.sh --nuget [--version 145.0.x.y]

Or set env var:
  WEBVIEW2_FIXED_URL=<cab download url> scripts/prepare-webview2-fixed.sh
  WEBVIEW2_NUGET_VERSION=<version> scripts/prepare-webview2-fixed.sh --nuget

Notes:
  - This script extracts the fixed runtime into dist/windows/FixedRuntime/
  - It generates dist/windows/run-with-webview2.cmd to launch the app with WEBVIEW2_BROWSER_EXECUTABLE_FOLDER set.
USAGE
}

MODE="nuget"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift 1
      ;;
    --cab)
      WEBVIEW2_CAB="$2"
      shift 2
      ;;
    --nuget)
      MODE="nuget"
      shift 1
      ;;
    --version)
      NUGET_VERSION="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

mkdir -p "$DIST_DIR" "$RUNTIME_ROOT" "$CACHE_DIR"

extract_runtime() {
  local src_dir="$1"
  local runtime_dir
  runtime_dir="$(find "$src_dir" -type f -name "msedgewebview2.exe" -print -quit | xargs -I{} dirname {})"
  if [[ -z "$runtime_dir" ]]; then
    echo "Unable to locate msedgewebview2.exe in extracted files." >&2
    exit 1
  fi

  local runtime_dir_name
  runtime_dir_name="$(basename "$runtime_dir")"
  local final_dir="$RUNTIME_ROOT/$runtime_dir_name"
  rm -rf "$final_dir"
  mkdir -p "$final_dir"
  cp -R "$runtime_dir/" "$final_dir/"
  echo "$runtime_dir_name"
}

RUNTIME_DIR_NAME=""

if [[ "$MODE" == "nuget" && -z "$WEBVIEW2_CAB" && -z "$WEBVIEW2_URL" ]]; then
  if [[ -z "$NUGET_VERSION" ]]; then
    echo "Resolving latest WebView2.Runtime.X64 version from NuGet..."
    NUGET_INDEX="$(curl -fsSL --retry 3 --retry-delay 1 -A "tsh-build-script" https://api.nuget.org/v3-flatcontainer/webview2.runtime.x64/index.json || true)"
    if [[ -z "$NUGET_INDEX" ]]; then
      echo "Failed to fetch NuGet version index. Try passing --version or setting WEBVIEW2_NUGET_VERSION." >&2
      exit 1
    fi
    NUGET_VERSION="$(python3 - <<'PY'
import json, sys
data = json.load(sys.stdin)
versions = data.get("versions", [])
print(versions[-1] if versions else "")
PY
<<< "$NUGET_INDEX")"
  fi

  if [[ -z "$NUGET_VERSION" ]]; then
    echo "Unable to determine latest NuGet version." >&2
    exit 1
  fi

  echo "Downloading WebView2.Runtime.X64 $NUGET_VERSION (NuGet fixed runtime)..."
  NUPKG_PATH="$CACHE_DIR/WebView2.Runtime.X64.$NUGET_VERSION.nupkg"
  if [[ ! -f "$NUPKG_PATH" ]]; then
    curl -L "https://www.nuget.org/api/v2/package/WebView2.Runtime.X64/$NUGET_VERSION" -o "$NUPKG_PATH"
  fi

  TMP_DIR="$(mktemp -d "$CACHE_DIR/nuget.XXXXXX")"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$NUPKG_PATH" -d "$TMP_DIR"
  elif command -v 7z >/dev/null 2>&1; then
    7z x -o"$TMP_DIR" "$NUPKG_PATH" >/dev/null
  else
    echo "Missing unzip or 7z. Install one of them and retry." >&2
    exit 1
  fi

  RUNTIME_DIR_NAME="$(extract_runtime "$TMP_DIR")"
else
  if [[ -z "$WEBVIEW2_CAB" && -z "$WEBVIEW2_URL" ]]; then
    usage
    exit 1
  fi

  if [[ -z "$WEBVIEW2_CAB" ]]; then
    CAB_NAME="$(basename "$WEBVIEW2_URL")"
    WEBVIEW2_CAB="$CACHE_DIR/$CAB_NAME"
    if [[ ! -f "$WEBVIEW2_CAB" ]]; then
      echo "Downloading fixed runtime cab..."
      curl -L "$WEBVIEW2_URL" -o "$WEBVIEW2_CAB"
    fi
  fi

  if [[ ! -f "$WEBVIEW2_CAB" ]]; then
    echo "Cab file not found: $WEBVIEW2_CAB" >&2
    exit 1
  fi

  CAB_BASENAME="$(basename "$WEBVIEW2_CAB")"
  RUNTIME_DIR_NAME="${CAB_BASENAME%.cab}"
  EXTRACT_DIR="$CACHE_DIR/$RUNTIME_DIR_NAME"
  rm -rf "$EXTRACT_DIR"
  mkdir -p "$EXTRACT_DIR"

  if command -v cabextract >/dev/null 2>&1; then
    cabextract -d "$EXTRACT_DIR" "$WEBVIEW2_CAB"
  elif command -v 7z >/dev/null 2>&1; then
    7z x -o"$EXTRACT_DIR" "$WEBVIEW2_CAB"
  else
    echo "Missing cabextract or 7z. Install one of them and retry." >&2
    exit 1
  fi

  RUNTIME_DIR_NAME="$(extract_runtime "$EXTRACT_DIR")"
fi

LAUNCHER="$DIST_DIR/run-with-webview2.cmd"
cat > "$LAUNCHER" <<EOF2
@echo off
setlocal
set "APP_DIR=%~dp0"
set "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER=%APP_DIR%FixedRuntime\\$RUNTIME_DIR_NAME"
start "" "%APP_DIR%tauri-ssh-client.exe"
EOF2

echo "Fixed runtime extracted to: $RUNTIME_ROOT/$RUNTIME_DIR_NAME"
if [[ -f "$DIST_DIR/tauri-ssh-client.exe" ]]; then
  echo "Launcher created: $LAUNCHER"
else
  echo "Note: tauri-ssh-client.exe not found in $DIST_DIR yet. Build first, then re-run to refresh launcher." >&2
fi
