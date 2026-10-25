import type { NodeDescriptor, NodeTypeInfo } from '@/lib/shared/types';

/**
 * Colour per node-creator category. The base theme stays monochrome; colour
 * comes from what nodes are: triggers orange, AI violet, flow blue, data green.
 */
export const CATEGORY_COLOR: Record<string, string> = {
  Triggers: 'var(--viz-2)',
  AI: 'var(--viz-7)',
  Models: 'var(--viz-7)',
  Memory: 'var(--viz-7)',
  Tools: 'var(--viz-7)',
  'Vector Stores': 'var(--viz-7)',
  Embeddings: 'var(--viz-7)',
  'Document Loaders': 'var(--viz-7)',
  'Text Splitters': 'var(--viz-7)',
  Rerankers: 'var(--viz-7)',
  Guardrails: 'var(--viz-3)',
  Flow: 'var(--viz-1)',
  Data: 'var(--viz-3)',
  Core: 'var(--viz-5)',
  Text: 'var(--viz-1)',
};

/** A node's accent: its own colour, else its plugin's, else its category's. */
export function nodeColor(info?: NodeTypeInfo): string {
  if (!info) return 'var(--t3)';
  return descriptorColor(info.descriptor, info.pluginColor);
}

/** Same, from a bare descriptor (plugin manifests). */
export function descriptorColor(descriptor: Pick<NodeDescriptor, 'color' | 'kind' | 'categories'>, pluginColor?: string): string {
  if (descriptor.color) return descriptor.color;
  if (pluginColor) return pluginColor;
  if (descriptor.kind === 'trigger') return CATEGORY_COLOR.Triggers;
  for (const category of descriptor.categories ?? []) if (CATEGORY_COLOR[category]) return CATEGORY_COLOR[category];
  return 'var(--t2)';
}

/** `color` mixed into the surface: soft fills that work in light and dark. */
export function tint(color: string, percent = 10, base = 'var(--sf)') {
  return `color-mix(in oklab, ${color} ${percent}%, ${base})`;
}
