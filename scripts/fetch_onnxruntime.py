#!/usr/bin/env python3
"""为 fs-gui 准备 onnxruntime.dll（ort 2.0.0-rc.13 + load-dynamic 的运行期硬依赖）。

## 为什么需要这个脚本

`ort-sys 2.0.0-rc.13` 起**不再分发 DLL**（`build/main.rs` 原注释：
"we don't need to download anything because we don't provide DLLs anymore"）。
项目的 `ort` 依赖开了 `load-dynamic`（为解决 ct2rs/sentencepiece 与 ort 各自静态编译
protobuf 导致的 LNK2005/LNK1169 符号重复），该 feature 会打开 `ort-sys` 的
`disable-linking`，转为**运行时 dlopen `onnxruntime.dll`**。

注意 feature 是全局统一的：`load-dynamic` 经 `ort` → `oar-ocr` → `oar-ocr-core` 传导，
所以 **PP-OCRv6 的 OCR 推理也走动态加载**，缺 DLL 会让截图 OCR 在运行时失败
（表现为静默失败或 ONNX Runtime 初始化报错，不是链接期错误，很容易漏掉）。

`download-binaries` 只提供静态 `onnxruntime.lib`（341MB），**不提供 DLL**。

## 用法

```bash
python scripts/fetch_onnxruntime.py            # 缺失时才下载
python scripts/fetch_onnxruntime.py --force    # 强制重新下载
python scripts/fetch_onnxruntime.py --check    # 只检查，不下载
```

下载源按顺序尝试（国内镜像优先，实测 ghfast.top 可用），解压后写入 exe 同级目录。
ORT API version 要求 >= 17（对应 ONNX Runtime 1.18+），本脚本固定 1.23.0。
"""

from __future__ import annotations

import argparse
import os
import ssl
import sys
import urllib.request
import zipfile
from pathlib import Path

# ORT_API_VERSION = 17（ort-sys version.rs，无 api-18+ feature）→ 需要 ORT >= 1.18
ORT_VERSION = "1.23.0"
ARCHIVE = f"onnxruntime-win-x64-{ORT_VERSION}.zip"
MIRRORS = [
    f"https://ghfast.top/https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VERSION}/{ARCHIVE}",
    f"https://ghproxy.net/https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VERSION}/{ARCHIVE}",
    f"https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VERSION}/{ARCHIVE}",
]
# 只放这两个：providers_shared 是 EP 加载器；DirectML 本项目不用（oar-ocr 仅作为可选 EP）
WANTED = {"onnxruntime.dll", "onnxruntime_providers_shared.dll"}

# exe 同级目录（cargo 默认产物位置）
DEST = Path(__file__).resolve().parent.parent / "target" / "debug"
CACHE = Path(os.environ.get("TEMP", "/tmp")) / ARCHIVE


def have_dll() -> bool:
    return all((DEST / n).exists() for n in WANTED)


def download() -> Path:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    for url in MIRRORS:
        try:
            print(f"[fetch] 尝试 {url}", flush=True)
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=120, context=ctx) as r:
                total = 0
                with open(CACHE, "wb") as f:
                    while chunk := r.read(1 << 20):
                        f.write(chunk)
                        total += len(chunk)
            print(f"[fetch] 下载完成 {total / 1024 / 1024:.1f} MB -> {CACHE}", flush=True)
            return CACHE
        except Exception as e:  # noqa: BLE001 - 逐个镜像回退
            print(f"[fetch]   失败: {type(e).__name__}: {str(e)[:120]}", flush=True)
    raise SystemExit("[fetch] 全部镜像均失败，请手动下载并解压到 target/debug/")


def extract(zip_path: Path) -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            base = os.path.basename(name)
            if base.lower() in WANTED:
                out = DEST / base
                out.write_bytes(z.read(name))
                print(f"[fetch] 解压 {base} -> {out} ({out.stat().st_size / 1024 / 1024:.1f} MB)")


def check() -> int:
    if not have_dll():
        print(f"[fetch] 缺失: {[n for n in WANTED if not (DEST / n).exists()]} @ {DEST}")
        return 1
    for n in sorted(WANTED):
        print(f"[fetch] OK {n} ({(DEST / n).stat().st_size / 1024 / 1024:.1f} MB)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="即使已存在也重新下载")
    ap.add_argument("--check", action="store_true", help="只检查，不下载")
    args = ap.parse_args()

    if args.check:
        return check()
    if have_dll() and not args.force:
        print(f"[fetch] 已存在，跳过（--force 可强制重下）: {DEST}")
        return 0
    extract(download())
    return check()


if __name__ == "__main__":
    sys.exit(main())
