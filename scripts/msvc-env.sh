#!/usr/bin/env bash
# fullscene-ocr-translator 构建环境（Git-bash 用）：
# VS 2026 MSVC 14.51 + WinSDK 10.0.26100 的 PATH/LIB/INCLUDE。
# 背景：Git-bash 的 coreutils link.exe 会遮蔽 MSVC link.exe；且裸 shell 无 LIB/INCLUDE，
# rustls/ring 等 build script 链接会失败（LNK1181 kernel32.lib / GNU link extra operand）。
# 用法：source scripts/msvc-env.sh && cargo check --workspace
export MSVC_ROOT="/c/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231"
export SDK_ROOT="/c/Program Files (x86)/Windows Kits/10"
export PATH="$MSVC_ROOT/bin/Hostx64/x64:$PATH"
export LIB="C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Tools\\MSVC\\14.51.36231\\lib\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0\\um\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0\\ucrt\\x64"
export INCLUDE="C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Tools\\MSVC\\14.51.36231\\include;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\ucrt;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\um;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\shared;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\winrt;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\cppwinrt"

# ---- ct2rs（CTranslate2）构建前置检查 ----
# ct2rs 的 build script 要现场编译 CTranslate2 C++ 源码，依赖 CMake ≥ 3.16。
# 缺 CMake 时 cargo check 会在 build script 阶段失败（错误信息不含「装 CMake」），
# 所以在这里提前暴露，避免把 10~30 分钟浪费在必失败的构建上。
if ! command -v cmake >/dev/null 2>&1; then
  echo "ERROR: 未找到 cmake。ct2rs 编译 CTranslate2 需要 CMake >= 3.16，请先安装（如 'winget install Kitware.CMake'）并重开终端。" >&2
  return 1 2>/dev/null || exit 1
fi
CMAKE_MAJOR=$(cmake --version | head -1 | sed -E 's/.*cmake version ([0-9]+)\..*/\1/')
CMAKE_MINOR=$(cmake --version | head -1 | sed -E 's/.*cmake version [0-9]+\.([0-9]+).*/\1/')
if [ "${CMAKE_MAJOR:-0}" -lt 3 ] || { [ "${CMAKE_MAJOR:-0}" -eq 3 ] && [ "${CMAKE_MINOR:-0}" -lt 16 ]; }; then
  echo "ERROR: 检测到 cmake $(cmake --version | head -1 | sed 's/.*cmake version //;s/ .*//')，低于 3.16。ct2rs 编译 CTranslate2 需要 CMake >= 3.16。" >&2
  return 1 2>/dev/null || exit 1
fi
echo "OK: cmake $(cmake --version | head -1 | sed 's/.*cmake version //;s/ .*//')（>= 3.16，满足 ct2rs 构建要求）"
