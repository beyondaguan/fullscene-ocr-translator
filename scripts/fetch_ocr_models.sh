#!/usr/bin/env bash
# 下载 PP-OCRv6 模型三件套（det / rec / dict）到 models/ppocrv6。
#
# 用法：
#   bash scripts/fetch_ocr_models.sh            # 默认 small（精度/体积均衡）
#   bash scripts/fetch_ocr_models.sh tiny       # 1.7M+4.3M，最快，字典仅 6904 字
#   bash scripts/fetch_ocr_models.sh medium     # 59M+73M，最高精度
#
# 为什么需要本脚本：官方 Release 在 GitHub，本机直连约 130KB/s（下 small 需 4 分钟）。
# 这里按「国内镜像优先、直连兜底」逐个尝试，任一源成功即停。
#
# 权威清单来源（勿凭记忆改文件名）：
#   ~/.cargo/registry/src/*/oar-ocr-0.9.2/docs/models.md
set -euo pipefail

VARIANT="${1:-small}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/models/ppocrv6"
TAG="v0.7.0"

# 文件名随变体变化：tiny 用独立小字典，small/medium 共用 18708 字字典。
case "$VARIANT" in
  tiny)   DET="pp-ocrv6_tiny_det.onnx";  REC="pp-ocrv6_tiny_rec.onnx";  DICT="ppocrv6_tiny_dict.txt" ;;
  small)  DET="pp-ocrv6_small_det.onnx"; REC="pp-ocrv6_small_rec.onnx"; DICT="ppocrv6_dict.txt" ;;
  medium) DET="pp-ocrv6_medium_det.onnx";REC="pp-ocrv6_medium_rec.onnx";DICT="ppocrv6_dict.txt" ;;
  *) echo "未知变体: $VARIANT（可选 tiny|small|medium）" >&2; exit 2 ;;
esac

# 候选源：%s 会被替换为「GitHub Release 完整 URL」。镜像站随时可能失效，失效就换下一个。
MIRRORS=(
  "https://ghfast.top/https://github.com"
  "https://gh-proxy.com/https://github.com"
  "https://ghproxy.net/https://github.com"
  "https://github.com"
)

mkdir -p "$OUT_DIR"

fetch_one() {
  local name="$1"
  local dest="$OUT_DIR/$name"
  if [[ -s "$dest" ]]; then
    echo "  已存在，跳过：$name"
    return 0
  fi
  local rel="GreatV/oar-ocr/releases/download/$TAG/$name"
  for m in "${MIRRORS[@]}"; do
    local url="${m}/${rel}"
    echo "  尝试：$url"
    if curl -fsSL --connect-timeout 12 --max-time 900 -o "$dest.part" "$url"; then
      if [[ -s "$dest.part" ]]; then
        mv "$dest.part" "$dest"
        echo "  ✅ 完成：$name（$(du -h "$dest" | cut -f1)）"
        return 0
      fi
    fi
    rm -f "$dest.part"
  done
  echo "  ❌ 全部源失败：$name" >&2
  return 1
}

echo "==> 下载 PP-OCRv6 $VARIANT → $OUT_DIR"
fetch_one "$DICT" || exit 1
fetch_one "$DET"  || exit 1
fetch_one "$REC"  || exit 1

# 完整性自检：ONNX 是 protobuf，首字节必为 0x08；字典行数应匹配官方。
echo "==> 校验"
for f in "$DET" "$REC"; do
  head -c 1 "$OUT_DIR/$f" | od -An -tx1 | grep -q '^\s*08$' \
    && echo "  OK  $f（ONNX 头正常）" \
    || { echo "  BAD $f（不是合法 ONNX，可能被镜像替换成 HTML）" >&2; exit 1; }
done
echo "  字典行数：$(wc -l < "$OUT_DIR/$DICT")"

# onnx 模型还必须能被运行时加载，这一步由真实推理测试把关：
#   source scripts/msvc-env.sh && cargo test -p fs-core -- --ignored --nocapture e2e_ppocrv6_recognizes_text

# 让 exe 同目录也能发现模型（load_models 优先取 exe 自身目录，避免 CWD 不同导致静默降级）。
for d in "$REPO_ROOT/target/debug" "$REPO_ROOT/target/release"; do
  [[ -d "$d" ]] || continue
  mkdir -p "$d/models"
  cp -f "$OUT_DIR"/* "$d/models/ppocrv6/" 2>/dev/null || { mkdir -p "$d/models/ppocrv6"; cp -f "$OUT_DIR"/* "$d/models/ppocrv6/"; }
  echo "  已同步到 $d/models/ppocrv6"
done

echo "==> 完成"
