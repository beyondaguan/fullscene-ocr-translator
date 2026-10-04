@echo off
REM ============================================================
REM  register_nm_host.cmd  — 全场景OCR翻译 NM 桥注册（薄包装，连主程序用）
REM
REM  实际逻辑见 register_nm_host.mjs（生成 manifest + .reg 导入文件）。
REM  本文件仅为方便双击/命令行调用。
REM
REM  用法： register_nm_host.cmd [fs-host.exe 绝对路径] [扩展ID]
REM ============================================================

setlocal
set "SCRIPT_DIR=%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 并加入 PATH。
  exit /b 1
)

node "%SCRIPT_DIR%register_nm_host.mjs" %*
set "EXIT_CODE=%errorlevel%"

echo.
echo 提示: 若上面的扩展 ID 是占位符，请编辑
echo   %LOCALAPPDATA%\FullSceneOCR\nm_host_manifest.json
echo 后双击 %LOCALAPPDATA%\FullSceneOCR\install_nm_host.reg 导入注册表。

exit /b %EXIT_CODE%