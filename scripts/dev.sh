#!/usr/bin/env bash
# 同时启动 shared-ui 监听构建 + Tauri dev
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# 终端 1：shared-ui dev server（必须起 1420 端口服务：
# tauri.conf.json 的 build.devUrl=http://localhost:1420，
# 用 build:watch 只产 dist 不起服务，Tauri dev 会连不上 → 白屏）
( pnpm --filter shared-ui dev ) &
UI_PID=$!

# 终端 2：Tauri dev（等待 UI 构建就绪）
sleep 3
( pnpm --filter gui dev ) &
TAURI_PID=$!

trap "kill $UI_PID $TAURI_PID 2>/dev/null" EXIT
wait