/**
 * Agent faces (docs/agents.md#faces): an illustrated face put together from a few named parts and colours, so a face is a
 * small JSON object in the agent's config. components/agents/avatar.tsx draws it. randomFace() makes one from a seed (the
 * same face for the same seed). No runtime imports: the server uses it for templates.
 */
import { MAX_AVATAR_IMAGE, type AgentAvatar } from './agents';

/** Skin tones; the last one is chrome, for agents that would rather look like a robot. */
export const FACE_SKINS = ['#f9dcc8', '#f2c4a3', '#e2a77f', '#c98b5f', '#a3693f', '#7c4b2b', '#5b3620', '#c9d3df'] as const;
export const CHROME_SKIN = '#c9d3df';
export const FACE_HAIR_COLORS = ['#1f1a17', '#3d2a1f', '#6b4a2f', '#9a4a24', '#d8b26e', '#ece3d2', '#9aa0a6', '#2bb3a3', '#e46aa7', '#5b6cf0', '#8b5cf6'] as const;

export const FACE_HAIR = ['short', 'side', 'buzz', 'long', 'bob', 'curly', 'bun', 'spiky', 'bald'] as const;
export const FACE_EYES = ['dots', 'round', 'happy', 'calm', 'wink', 'wide'] as const;
export const FACE_BROWS = ['soft', 'flat', 'raised', 'focused', 'none'] as const;
export const FACE_MOUTHS = ['smile', 'grin', 'neutral', 'open', 'smirk'] as const;
export const FACE_BEARDS = ['none', 'stubble', 'moustache', 'full'] as const;
export const FACE_GLASSES = ['none', 'round', 'square'] as const;
export const FACE_EXTRAS = ['none', 'headset', 'earrings', 'antenna'] as const;

export type FaceHair = (typeof FACE_HAIR)[number];
export type FaceEyes = (typeof FACE_EYES)[number];
export type FaceBrows = (typeof FACE_BROWS)[number];
export type FaceMouth = (typeof FACE_MOUTHS)[number];
export type FaceBeard = (typeof FACE_BEARDS)[number];
export type FaceGlasses = (typeof FACE_GLASSES)[number];
export type FaceExtra = (typeof FACE_EXTRAS)[number];

export interface AgentFace {
  skin: string;
  hair: FaceHair;
  hairColor: string;
  eyes: FaceEyes;
  brows: FaceBrows;
  mouth: FaceMouth;
  beard: FaceBeard;
  glasses: FaceGlasses;
  extra: FaceExtra;
}

/** The parts the avatar picker edits, in its order, with a label per choice. */
export const FACE_PARTS = [
  { key: 'hair', label: 'Hair', options: FACE_HAIR, labels: { short: 'Short', side: 'Side part', buzz: 'Buzz', long: 'Long', bob: 'Bob', curly: 'Curly', bun: 'Bun', spiky: 'Spiky', bald: 'None' } },
  { key: 'eyes', label: 'Eyes', options: FACE_EYES, labels: { dots: 'Dots', round: 'Round', happy: 'Happy', calm: 'Calm', wink: 'Wink', wide: 'Wide' } },
  { key: 'brows', label: 'Brows', options: FACE_BROWS, labels: { soft: 'Soft', flat: 'Flat', raised: 'Raised', focused: 'Focused', none: 'None' } },
  { key: 'mouth', label: 'Mouth', options: FACE_MOUTHS, labels: { smile: 'Smile', grin: 'Grin', neutral: 'Neutral', open: 'Open', smirk: 'Smirk' } },
  { key: 'beard', label: 'Beard', options: FACE_BEARDS, labels: { none: 'None', stubble: 'Stubble', moustache: 'Moustache', full: 'Full' } },
  { key: 'glasses', label: 'Glasses', options: FACE_GLASSES, labels: { none: 'None', round: 'Round', square: 'Square' } },
  { key: 'extra', label: 'Extra', options: FACE_EXTRAS, labels: { none: 'None', headset: 'Headset', earrings: 'Earrings', antenna: 'Antenna' } },
] as const;

export const DEFAULT_FACE: AgentFace = {
  skin: FACE_SKINS[1],
  hair: 'short',
  hairColor: FACE_HAIR_COLORS[1],
  eyes: 'round',
  brows: 'soft',
  mouth: 'smile',
  beard: 'none',
  glasses: 'none',
  extra: 'none',
};

const HEX = /^#[0-9a-f]{6}$/i;
const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T => (options.includes(value as T) ? (value as T) : fallback);

/** A face from stored JSON: unknown parts fall back to the default ones, colours must be #rrggbb. */
export function cleanFace(input: unknown): AgentFace | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const f = input as Record<string, unknown>;
  return {
    skin: typeof f.skin === 'string' && HEX.test(f.skin) ? f.skin.toLowerCase() : DEFAULT_FACE.skin,
    hair: pick(FACE_HAIR, f.hair, DEFAULT_FACE.hair),
    hairColor: typeof f.hairColor === 'string' && HEX.test(f.hairColor) ? f.hairColor.toLowerCase() : DEFAULT_FACE.hairColor,
    eyes: pick(FACE_EYES, f.eyes, DEFAULT_FACE.eyes),
    brows: pick(FACE_BROWS, f.brows, DEFAULT_FACE.brows),
    mouth: pick(FACE_MOUTHS, f.mouth, DEFAULT_FACE.mouth),
    beard: pick(FACE_BEARDS, f.beard, DEFAULT_FACE.beard),
    glasses: pick(FACE_GLASSES, f.glasses, DEFAULT_FACE.glasses),
    extra: pick(FACE_EXTRAS, f.extra, DEFAULT_FACE.extra),
  };
}

/** A small seeded generator (FNV-1a into mulberry32), so a seed always gives the same face. */
function generator(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A face from a seed (an agent's id or name): the same seed gives the same face. One in twelve is a robot. */
export function randomFace(seed: string): AgentFace {
  const next = generator(seed || 'agent');
  const one = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];
  const chance = (p: number) => next() < p;
  if (chance(1 / 12)) {
    return { ...DEFAULT_FACE, skin: CHROME_SKIN, hair: 'bald', hairColor: '#8a96a6', eyes: one(['dots', 'round', 'wide'] as const), brows: 'none', mouth: one(['smile', 'neutral', 'open'] as const), extra: 'antenna' };
  }
  const hairColors = FACE_HAIR_COLORS.slice(0, 7);
  return {
    skin: one(FACE_SKINS.slice(0, 7)),
    hair: one(FACE_HAIR),
    // Mostly natural colours, now and then a bright one.
    hairColor: chance(0.15) ? one(FACE_HAIR_COLORS.slice(7)) : one(hairColors),
    eyes: one(FACE_EYES.filter((e) => e !== 'wink')),
    brows: one(FACE_BROWS.filter((b) => b !== 'none')),
    mouth: one(FACE_MOUTHS),
    beard: chance(0.25) ? one(FACE_BEARDS.slice(1)) : 'none',
    glasses: chance(0.3) ? one(FACE_GLASSES.slice(1)) : 'none',
    extra: chance(0.2) ? one(['headset', 'earrings'] as const) : 'none',
  };
}

/** An avatar as stored: only the part its kind uses; absent for the default (the icon on a tinted tile). */
export function cleanAvatar(input: AgentAvatar | undefined): AgentAvatar | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const solid = input.solid === true ? { solid: true } : {};
  switch (input.kind) {
    case 'face': {
      const face = cleanFace(input.face);
      return face ? { kind: 'face', face, ...solid } : undefined;
    }
    case 'initials': {
      const initials = Array.from((input.initials ?? '').replace(/\s+/g, '')).slice(0, 2).join('').toUpperCase();
      return initials ? { kind: 'initials', initials, ...solid } : undefined;
    }
    case 'image':
      return typeof input.image === 'string' && input.image.length <= MAX_AVATAR_IMAGE && IMAGE.test(input.image) ? { kind: 'image', image: input.image } : undefined;
    case 'icon':
      return input.solid === true ? { kind: 'icon', solid: true } : undefined;
    default:
      return undefined;
  }
}

const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
