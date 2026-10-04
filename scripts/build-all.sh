#!/usr/bin/env bash
# 全量构建：shared-ui → 浏览器扩展 → 主程序
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "==> 构建 shared-ui..."
pnpm --filter shared-ui build

echo "==> 构建浏览器扩展..."
pnpm --filter extension build

# ort 2.0.0-rc.13 开 load-dynamic 后不再分发 DLL，而 feature 会经 ort → oar-ocr 传导到
# OCR 推理路径，故运行目录必须有 onnxruntime.dll，否则截图 OCR 运行时静默失败。
echo "==> 准备 onnxruntime.dll（load-dynamic 运行期依赖）..."
PY="$(command -v python3 || command -v python || true)"
if [ -n "$PY" ]; then
  "$PY" scripts/fetch_onnxruntime.py
else
  echo "⚠️  未找到 python，跳过 onnxruntime.dll 检查；运行前请手动执行 scripts/fetch_onnxruntime.py"
fi

echo "==> 构建主程序..."
pnpm --filter gui build

echo "✅ 全量构建完成"
echo "产物位置："
echo "  主程序：crates/gui/target/release/bundle/"
echo "  浏览器扩展：extension/dist/"