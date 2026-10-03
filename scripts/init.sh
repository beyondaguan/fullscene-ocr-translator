#!/usr/bin/env bash
# 项目初始化：环境检查 + 依赖安装 + Rust 工具链 + Git hooks
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "==> 检查环境依赖..."
command -v cargo >/dev/null 2>&1 || { echo "❌ 需要安装 Rust"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ 需要安装 Node.js >=20"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "❌ 需要安装 pnpm"; exit 1; }

echo "==> 安装前端依赖..."
pnpm install

echo "==> 检查 Rust 工具链..."
rustup show
rustup component add clippy rustfmt 2>/dev/null || true

echo "==> 初始化 Git hooks..."
if [ -d .git ]; then
  echo 'pnpm lint-staged' > .git/hooks/pre-commit
  chmod +x .git/hooks/pre-commit
fi

echo "==> 创建本地配置副本..."
cp crates/gui/tauri.conf.json crates/gui/tauri.conf.local.json 2>/dev/null || true

echo "✅ 初始化完成"
echo ""
echo "下一步："
echo "  pnpm dev        # 启动开发模式（前端 + Rust 后端热重载）"
echo "  pnpm build      # 全量构建"
echo "  pnpm test       # 运行测试"