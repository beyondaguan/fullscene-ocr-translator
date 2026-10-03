#!/usr/bin/env python3
"""Compute Chrome/Edge unpacked-extension IDs (Chromium GenerateIdForPath).

ID = SHA256(path_utf8)[:16], each byte mapped to 'a' + (byte & 0x0F).
Chromium uses forward-slash absolute path (AsUTF8Unsafe).
"""
import hashlib


def ext_id(path: str) -> str:
    digest = hashlib.sha256(path.encode('utf-8')).digest()
    return "".join(chr(ord("a") + (b & 0x0F)) for b in digest[:16])


variants = [
    r"D:/g/fullscene-ocr-translator/extension",
    r"d:/g/fullscene-ocr-translator/extension",
    r"D:/g/fullscene-ocr-translator/extension/dist",
    r"d:/g/fullscene-ocr-translator/extension/dist",
    # backslash forms (in case Chromium keeps them)
    r"D:\g\fullscene-ocr-translator\extension",
    r"d:\g\fullscene-ocr-translator\extension",
    r"D:\g\fullscene-ocr-translator\extension\dist",
    r"d:\g\fullscene-ocr-translator\extension\dist",
]

seen = {}
for v in variants:
    i = ext_id(v)
    seen.setdefault(i, []).append(v)
    print(f"{i}  <-  {v}")

print("\n=== unique IDs ===")
for i, paths in seen.items():
    print(f"{i}: {paths}")