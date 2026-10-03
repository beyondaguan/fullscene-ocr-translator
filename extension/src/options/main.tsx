/**
 * Options 入口：React 挂载（扩展设置页）。
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