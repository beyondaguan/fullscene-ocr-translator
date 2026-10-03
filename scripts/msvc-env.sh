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
