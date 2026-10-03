/**
 * Popup 入口：React 挂载。
 * 注意：popup 是独立 HTML 页面（非扩展根），由 vite 多入口构建。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../shared/ui.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}