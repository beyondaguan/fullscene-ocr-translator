import React from 'react';

/**
 * 图标集：统一 24 网格、1.6 描边、currentColor 着色。
 * 全部为线性图标，不使用 emoji（跨平台字形不一致，且无法随主题着色）。
 */
export interface IconProps {
  size?: number;
}

function svgProps(size: number): React.SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  };
}

export function IconScreenshot({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1" />
    </svg>
  );
}

export function IconRegion({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)} strokeLinecap="butt">
      <rect x="3" y="5" width="18" height="14" rx="2" strokeDasharray="3 2.5" />
    </svg>
  );
}

export function IconImage({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.4" />
      <path d="M20.5 15.5 16 11l-6 6" />
    </svg>
  );
}

export function IconPaste({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M16 5h2a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2" />
    </svg>
  );
}

export function IconCopy({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a1 1 0 0 1 1-1h9" />
    </svg>
  );
}

export function IconSpeak({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M11 5 6.5 8.5h-3v7h3L11 19V5z" />
      <path d="M15 9.2a4.2 4.2 0 0 1 0 5.6" />
    </svg>
  );
}

export function IconSwap({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M5 8.5h11l-3-3M19 15.5H8l3 3" />
    </svg>
  );
}

export function IconHistory({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function IconSettings({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6.2 6.2l1.4 1.4M16.4 16.4l1.4 1.4M17.8 6.2l-1.4 1.4M7.6 16.4l-1.4 1.4" />
    </svg>
  );
}

export function IconChat({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
      <path d="M8 9h8M8 12.5h5" />
    </svg>
  );
}

export function IconClose({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function IconClear({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function IconRefresh({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v4h-4" />
    </svg>
  );
}

export function IconChevronDown({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M6 9.5 12 15l6-5.5" />
    </svg>
  );
}
