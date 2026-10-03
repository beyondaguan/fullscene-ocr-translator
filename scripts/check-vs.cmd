@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" -arch=x64 >nul 2>&1
cd /d D:\g\fullscene-ocr-translator
cargo check --workspace
