#!/usr/bin/env bash
# 全量构建：shared-ui → 浏览器扩展 → 软件主体
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "==> 构建 shared-ui..."
pnpm --filter shared-ui build

echo "==> 构建浏览器扩展..."
pnpm --filter extension build

echo "==> 构建软件主体..."
pnpm --filter gui build

echo "✅ 全量构建完成"
echo "产物位置："
echo "  软件主体：crates/gui/target/release/bundle/"
echo "  浏览器扩展：extension/dist/"