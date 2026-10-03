#!/usr/bin/env bash
# 发布流程：校验 → 构建 → 签名 → 生成更新清单
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

VERSION="${1:?用法: ./release.sh <version>}"
echo "==> 发布版本 $VERSION"

# 1. 校验版本号一致性
grep -q "\"version\": \"$VERSION\"" package.json || { echo "❌ package.json 版本不匹配"; exit 1; }
grep -q "\"version\": \"$VERSION\"" crates/gui/tauri.conf.json || { echo "❌ tauri.conf.json 版本不匹配"; exit 1; }

# 2. 全量构建
./scripts/build-all.sh

# 3. Windows 签名（CI 环境中由 release.yml 处理）
# 4. macOS 签名 + 公证（CI）
# 5. 生成 dist-manifest.json
if command -v cargo >/dev/null 2>&1; then
  cargo dist manifest --tag "v$VERSION" --output dist-manifest.json 2>/dev/null || echo "⚠️ cargo-dist 未安装，跳过 dist-manifest 生成"
fi

echo "✅ 发布产物已生成，交由 CI 完成签名与上传"