'use client';

import type { CSSProperties } from 'react';

/**
 * Icon — stroked SVG set from the Warm Obsidian design brief. One weight
 * (1.75), one look. No emoji in chrome — emoji live only inside
 * user-generated content surfaces. Colour is currentColor by default so
 * icons inherit from their containing text colour.
 *
 * Keeping this inline rather than a lib so each icon is tree-shakeable
 * and we can add/remove without rebuilding an SVG sprite.
 */
export type IconName =
  | 'home'
  | 'moon'
  | 'sun'
  | 'phone'
  | 'bell'
  | 'chart'
  | 'dots'
  | 'plus'
  | 'send'
  | 'paperclip'
  | 'lock'
  | 'heart'
  | 'spark'
  | 'leaf'
  | 'orbit'
  | 'chevron'
  | 'x'
  | 'dice'
  | 'gift'
  | 'hourglass'
  | 'brain'
  | 'compass'
  | 'bookmark'
  | 'tag';

export function Icon({
  name,
  size = 16,
  color,
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  style?: CSSProperties;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { color, ...style },
    'aria-hidden': true,
  };
  switch (name) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M3 11 12 4l9 7v8a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
        </svg>
      );
    case 'moon':
      return (
        <svg {...common}>
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </svg>
      );
    case 'sun':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      );
    case 'phone':
      return (
        <svg {...common}>
          <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z" />
        </svg>
      );
    case 'bell':
      return (
        <svg {...common}>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0" />
        </svg>
      );
    case 'chart':
      return (
        <svg {...common}>
          <path d="M3 3v18h18M7 14l4-4 4 4 5-6" />
        </svg>
      );
    case 'dots':
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="1.2" />
          <circle cx="12" cy="12" r="1.2" />
          <circle cx="19" cy="12" r="1.2" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'send':
      return (
        <svg {...common}>
          <path d="m3 11 18-8-8 18-2-8z" />
        </svg>
      );
    case 'paperclip':
      return (
        <svg {...common}>
          <path d="M21 12.5 12.5 21a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 0 1 5 5L10.5 19a2 2 0 0 1-3-3L15 8.5" />
        </svg>
      );
    case 'lock':
      return (
        <svg {...common}>
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      );
    case 'heart':
      return (
        <svg {...common}>
          <path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7 7.2l8.7 8.7 8.7-8.7a5 5 0 0 0 .1-7.2z" />
        </svg>
      );
    case 'spark':
      return (
        <svg {...common}>
          <path d="M12 2v7M12 15v7M2 12h7M15 12h7M5 5l4.5 4.5M14.5 14.5 19 19M5 19l4.5-4.5M14.5 9.5 19 5" />
        </svg>
      );
    case 'leaf':
      return (
        <svg {...common}>
          <path d="M4 20c0-10 8-16 16-16 0 10-6 16-16 16zM4 20c2-4 5-7 10-9" />
        </svg>
      );
    case 'orbit':
      return (
        <svg {...common}>
          <ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-30 12 12)" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      );
    case 'chevron':
      return (
        <svg {...common}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      );
    case 'dice':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <circle cx="8" cy="8" r="1.2" fill="currentColor" />
          <circle cx="16" cy="16" r="1.2" fill="currentColor" />
          <circle cx="12" cy="12" r="1.2" fill="currentColor" />
        </svg>
      );
    case 'gift':
      return (
        <svg {...common}>
          <rect x="3" y="8" width="18" height="4" rx="1" />
          <path d="M12 8v13M5 12v9h14v-9M7.5 8a2.5 2.5 0 1 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 1 1 0 5" />
        </svg>
      );
    case 'hourglass':
      return (
        <svg {...common}>
          <path d="M6 2h12M6 22h12M6 2c0 6 6 6 6 10s-6 4-6 10M18 2c0 6-6 6-6 10s6 4 6 10" />
        </svg>
      );
    case 'brain':
      return (
        <svg {...common}>
          <path d="M9 3a3 3 0 0 0-3 3v1a3 3 0 0 0-2 3 3 3 0 0 0 1 4 3 3 0 0 0 4 3 3 3 0 0 0 3 2V3zM15 3a3 3 0 0 1 3 3v1a3 3 0 0 1 2 3 3 3 0 0 1-1 4 3 3 0 0 1-4 3 3 3 0 0 1-3 2V3z" />
        </svg>
      );
    case 'compass':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="m16 8-5 3-3 5 5-3 3-5z" />
        </svg>
      );
    case 'bookmark':
      return (
        <svg {...common}>
          <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'tag':
      return (
        <svg {...common}>
          <path d="M20 12V4h-8L2 14l8 8z" />
          <circle cx="14.5" cy="9.5" r="1" fill="currentColor" />
        </svg>
      );
    default:
      return null;
  }
}
