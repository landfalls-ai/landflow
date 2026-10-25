'use client';
import type { CSSProperties } from 'react';
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic';
import { Box } from 'lucide-react';
import { cn } from '@/lib/utils';

const known = new Set<string>(iconNames);

interface NodeIconProps {
  icon?: string;
  className?: string;
  style?: CSSProperties;
  size?: number;
  strokeWidth?: number;
}

/** Renders a descriptor icon: "lucide:<name>", "emoji:<char>" or an image URL (plugins publish SVGs as data: URLs). */
export function NodeIcon({ icon, className, style, size = 18, strokeWidth = 1.8 }: NodeIconProps) {
  if (icon?.startsWith('emoji:')) {
    return (
      <span className={cn('leading-none', className)} style={{ ...style, fontSize: size }}>
        {icon.slice(6)}
      </span>
    );
  }
  if (icon && /^(https?:|data:)/.test(icon)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={icon} alt="" width={size} height={size} className={cn('object-contain', className)} style={{ width: size, height: size }} draggable={false} />;
  }
  const name = icon?.startsWith('lucide:') ? icon.slice(7) : icon;
  if (name && known.has(name)) {
    return <DynamicIcon name={name as IconName} size={size} strokeWidth={strokeWidth} className={className} style={style} fallback={() => <Box size={size} className={className} style={style} />} />;
  }
  return <Box size={size} strokeWidth={strokeWidth} className={className} style={style} />;
}

export const isImageIcon = (icon?: string) => Boolean(icon && /^(https?:|data:)/.test(icon));

/**
 * An "app" icon: a plugin-published image as is (it brings its own badge), or a
 * glyph on a tile tinted with `color`.
 */
export function AppIcon({ icon, color = 'var(--t2)', size = 36, round, className }: { icon?: string; color?: string; size?: number; round?: boolean; className?: string }) {
  if (isImageIcon(icon)) return <NodeIcon icon={icon} size={size} className={cn('shrink-0', className)} />;
  return (
    <span
      className={cn('grid shrink-0 place-items-center border border-hair', round ? 'rounded-full' : 'rounded-[28%]', className)}
      style={{ width: size, height: size, background: `color-mix(in oklab, ${color} 12%, var(--sf))` }}
    >
      <NodeIcon icon={icon} size={Math.round(size * 0.5)} style={{ color }} strokeWidth={1.8} />
    </span>
  );
}
