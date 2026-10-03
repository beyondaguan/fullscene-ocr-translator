/**
 * UI 冒烟测试：popup / sidebar / options 三个 React 界面可渲染且含关键元素。
 * 用 renderToString（不触发 useEffect），避免依赖 chrome API 与浏览器环境。
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { App as PopupApp } from '../src/popup/App';
import { App as SidebarApp } from '../src/sidebar/App';
import { App as OptionsApp } from '../src/options/App';

describe('界面冒烟', () => {
  it('popup 渲染出品牌头与三大操作', () => {
    const html = renderToString(createElement(PopupApp));
    expect(html).toContain('fs-app--popup');
    expect(html).toContain('翻译本页');
    expect(html).toContain('还原原文');
    expect(html).toContain('侧栏');
  });

  it('sidebar 渲染出三个 Tab', () => {
    const html = renderToString(createElement(SidebarApp));
    expect(html).toContain('翻译');
    expect(html).toContain('历史');
    expect(html).toContain('生词本');
    expect(html).toContain('fs-tabs');
  });

  it('options 渲染出导航与保存条', () => {
    const html = renderToString(createElement(OptionsApp));
    expect(html).toContain('翻译引擎');
    expect(html).toContain('划词翻译');
    expect(html).toContain('全文翻译');
    expect(html).toContain('隐私');
    expect(html).toContain('保存设置');
  });
});
