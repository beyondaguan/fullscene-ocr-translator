/**
 * Blob 下载工具。用完立即 revoke ObjectURL，避免内存泄漏。
 */

/**
 * 触发浏览器下载；非 DOM 环境（Node/Service Worker 无 document）降级为警告并返回 false。
 */
export function download(blob: Blob, filename: string): boolean {
  const doc = (globalThis as unknown as { document?: Document }).document;
  const urlApi = globalThis.URL;
  if (!doc || typeof urlApi?.createObjectURL !== 'function') {
    console.warn(`[download] 当前环境不支持下载，已跳过：${filename}`);
    return false;
  }

  const url = urlApi.createObjectURL(blob);
  try {
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    urlApi.revokeObjectURL(url);
  }
}