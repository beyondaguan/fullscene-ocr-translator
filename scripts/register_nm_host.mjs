#!/usr/bin/env node
/**
 * register_nm_host.mjs  —  全场景OCR翻译 Native Messaging Host 注册（增强版）
 *
 * 用法：
 *   node scripts/register_nm_host.mjs [fs-host.exe 绝对路径] [扩展ID1 扩展ID2 ...]
 *
 * 特性：
 *   - 支持一个或多个扩展 ID（allowed_origins 数组），便于覆盖 源目录/dist 不同加载方式。
 *   - 未传扩展 ID 时自动计算本机候选 ID（基于仓库路径的 Chromium GenerateIdForPath 算法）。
 *   - 产出 %LOCALAPPDATA%\FullSceneOCR\nm_host_manifest.json + install_nm_host.reg + uninstall_nm_host.reg。
 *
 * 之后：
 *   1. 双击 install_nm_host.reg 导入注册表（HKCU，无需管理员）。
 *   2. 重启 Edge/Chrome，扩展即可通过 chrome.runtime.connectNative 通信。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ---- 参数解析 ----
let hostExe = process.argv[2];
const extIds = process.argv.slice(3).filter(Boolean);

if (!hostExe) {
  const candidate = path.join(repoRoot, 'target', 'release', 'fs-host.exe');
  if (existsSync(candidate)) {
    hostExe = candidate;
  } else {
    console.error('[错误] 未指定 fs-host.exe 路径，且默认路径不存在:');
    console.error('  ' + candidate);
    console.error('用法: node scripts/register_nm_host.mjs [fs-host.exe 绝对路径] [扩展ID1 扩展ID2 ...]');
    process.exit(1);
  }
}

hostExe = path.resolve(hostExe);
if (!existsSync(hostExe)) {
  console.error(`[错误] fs-host.exe 不存在: ${hostExe}`);
  console.error('请先构建: cargo build -p fs-host --release');
  process.exit(1);
}

// ---- 自动计算候选扩展 ID（未提供时） ----
function extIdForPath(p) {
  const digest = createHash('sha256').update(p, 'utf8').digest();
  return [...digest.subarray(0, 16)].map((b) => String.fromCharCode(97 + (b & 0x0f))).join('');
}

const pathVariants = [
  path.join(repoRoot, 'extension').replace(/\\/g, '/'),
  path.join(repoRoot, 'extension').replace(/\\/g, '/').toLowerCase(),
  path.join(repoRoot, 'extension', 'dist').replace(/\\/g, '/'),
  path.join(repoRoot, 'extension', 'dist').replace(/\\/g, '/').toLowerCase(),
];
const autoIds = [...new Set(pathVariants.map(extIdForPath))];
const ids = extIds.length ? extIds : autoIds;

// ---- 生成 manifest JSON ----
const manifestDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'FullSceneOCR')
  : path.join(repoRoot, '.nm-host');
if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true });

const manifestPath = path.join(manifestDir, 'nm_host_manifest.json');
const hostExeJson = hostExe.replace(/\\/g, '\\\\');
const allowedOrigins = ids.map((id) => `chrome-extension://${id}/`);

const manifest = {
  name: 'com.fullscene.ocr_translator',
  description: '全场景OCR翻译 Native Messaging Host',
  path: hostExeJson,
  type: 'stdio',
  allowed_origins: allowedOrigins,
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`[OK] 已生成 manifest: ${manifestPath}`);
console.log(`     path = ${hostExe}`);
console.log(`     allowed_origins = ${JSON.stringify(allowedOrigins)}`);

// ---- 生成 .reg ----
const manifestPathReg = manifestPath.replace(/\\/g, '\\\\');
const regHeader = 'Windows Registry Editor Version 5.00\r\n\r\n';
const regBodies = [
  { label: 'Chrome', key: 'HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.fullscene.ocr_translator' },
  { label: 'Edge', key: 'HKEY_CURRENT_USER\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.fullscene.ocr_translator' },
  { label: 'Chromium', key: 'HKEY_CURRENT_USER\\Software\\Chromium\\NativeMessagingHosts\\com.fullscene.ocr_translator' },
];

let installReg = regHeader;
let uninstallReg = regHeader;
for (const { key } of regBodies) {
  const keyEsc = key.replace(/\\/g, '\\\\');
  installReg += `[${key}]\r\n@="${manifestPathReg}"\r\n\r\n`;
  uninstallReg += `[-${key}]\r\n`;
}

const installRegPath = path.join(manifestDir, 'install_nm_host.reg');
const uninstallRegPath = path.join(manifestDir, 'uninstall_nm_host.reg');
writeFileSync(installRegPath, installReg, 'utf8');
writeFileSync(uninstallRegPath, uninstallReg, 'utf8');

console.log(`[OK] 已生成注册表导入文件: ${installRegPath}`);
console.log(`[OK] 已生成卸载文件:       ${uninstallRegPath}`);
console.log('');
console.log('下一步:');
console.log(`  1. 双击 ${installRegPath} 导入注册表（HKCU，无需管理员权限）。`);
console.log('  2. 重启 Edge/Chrome（完全退出后重开）。');
console.log('  3. 扩展即可通过 chrome.runtime.connectNative 通信。');
console.log('  4. 卸载：双击 ' + uninstallRegPath + ' 或运行 unregister_nm_host.mjs。');