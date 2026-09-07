/**
 * Inline SVG icons.
 *
 * The extension ships zero icon fonts and zero image assets for chrome: every
 * glyph is a stroked 24x24 path drawn in `currentColor`, so icons inherit the
 * colour of whatever button or badge they sit in and cost nothing at load time.
 */

import type { ReactNode } from 'react';

/** Shared props for every icon: a pixel size and an optional extra class. */
export interface IconProps {
  size?: number;
  className?: string;
}

interface FrameProps extends IconProps {
  children: ReactNode;
  /** filled shapes (record dot, warning triangle) opt out of stroking */
  fill?: boolean;
}

function Frame({ size = 14, className, fill = false, children }: FrameProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Filled dot — the "start recording" affordance. */
export function IconRecord(props: IconProps) {
  return (
    <Frame {...props} fill>
      <circle cx="12" cy="12" r="7" />
    </Frame>
  );
}

/** Filled square — "stop recording". */
export function IconStop(props: IconProps) {
  return (
    <Frame {...props} fill>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </Frame>
  );
}

/** Floppy disk — commit pending changes into a snapshot. */
export function IconSave(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </Frame>
  );
}

/** Bin — destructive delete. */
export function IconTrash(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </Frame>
  );
}

/** Crosshair — flash an outline around the element a change points at. */
export function IconTarget(props: IconProps) {
  return (
    <Frame {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Frame>
  );
}

/** Right chevron; rotate it with the `.chev.open` class to expand. */
export function IconChevron(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M9 5l7 7-7 7" />
    </Frame>
  );
}

/** Tray with a down arrow — export snapshots to a file. */
export function IconDownload(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M12 3v12" />
      <path d="M7 11l5 5 5-5" />
      <path d="M4 20h16" />
    </Frame>
  );
}

/** Tray with an up arrow — import snapshots from a file. */
export function IconUpload(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M12 21V9" />
      <path d="M7 13l5-5 5 5" />
      <path d="M4 4h16" />
    </Frame>
  );
}

/** Cog — the settings tab. */
export function IconGear(props: IconProps) {
  return (
    <Frame {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5l1.4 2.6 2.9-.4 .6 2.9 2.6 1.4-1.5 2.5 1.5 2.5-2.6 1.4-.6 2.9-2.9-.4L12 21.5l-1.4-2.6-2.9.4-.6-2.9-2.6-1.4L6 12.5 4.5 10l2.6-1.4.6-2.9 2.9.4Z" />
    </Frame>
  );
}

/** Tick — a confirmed / applied state. */
export function IconCheck(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M4 12.5l5.5 5.5L20 7" />
    </Frame>
  );
}

/** Triangle with a bang — errors, and the "probably app render" hint. */
export function IconWarning(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M12 3.5 21.5 20h-19L12 3.5Z" />
      <path d="M12 10v4" />
      <path d="M12 17.2v.1" />
    </Frame>
  );
}
