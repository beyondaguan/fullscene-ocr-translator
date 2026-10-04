#!/usr/bin/env node
/**
 * unregister_nm_host.mjs
 *
 * 生成卸载 全场景OCR翻译 NM 桥注册的 .reg 文件。
 * 产出 %LOCALAPPDATA%\FullSceneOCR\uninstall_nm_host.reg
 *
 * 用法： node scripts/unregister_nm_host.mjs
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'FullSceneOCR')
  : path.join(path.resolve(__dirname, '..'), '.nm-host');
if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true });

const regHeader = 'Windows Registry Editor Version 5.00\r\n\r\n';
const keys = [
  'HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.fullscene.ocr_translator',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.fullscene.ocr_translator',
  'HKEY_CURRENT_USER\\Software\\Chromium\\NativeMessagingHosts\\com.fullscene.ocr_translator',
];

let reg = regHeader;
for (const key of keys) {
  reg += `[-${key}]\r\n`;
}

const regPath = path.join(manifestDir, 'uninstall_nm_host.reg');
writeFileSync(regPath, reg, 'utf8');
console.log(`[OK] 已生成卸载文件: ${regPath}`);
console.log('双击该文件即可删除三项注册表键。');