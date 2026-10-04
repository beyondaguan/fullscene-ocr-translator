@echo off
REM ============================================================
REM  unregister_nm_host.cmd  — 全场景OCR翻译 NM 桥卸载（薄包装）
REM
REM  实际逻辑见 unregister_nm_host.mjs（生成卸载 .reg）。
REM  本文件仅为方便双击/命令行调用。
REM
REM  用法： unregister_nm_host.cmd
REM ============================================================

setlocal
set "SCRIPT_DIR=%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 并加入 PATH。
  exit /b 1
)

node "%SCRIPT_DIR%unregister_nm_host.mjs"
exit /b %errorlevel%