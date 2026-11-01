'use client';
/**
 * An agent's avatar (docs/agents.md#avatars): its icon on a tile, an illustrated face, initials or an image, on a tile tinted
 * with (or filled with) the agent's colour. FaceArt draws a face from its parts (lib/shared/faces.ts).
 */
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import type { AgentAvatar as AgentAvatarConfig } from '@/lib/shared/agents';
import { CHROME_SKIN, type AgentFace } from '@/lib/shared/faces';
import { NodeIcon } from '../ui/icon';

const INK = '#1d2026';
const MOUTH = '#7a2f35';

/** #rrggbb scaled toward black (amount > 0) or white (amount < 0). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) => Math.round(amount >= 0 ? c * (1 - amount) : c + (255 - c) * -amount);
  const [r, g, b] = [channel((n >> 16) & 255), channel((n >> 8) & 255), channel(n & 255)];
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

const light = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 170;
};

function HairBack({ face }: { face: AgentFace }) {
  const fill = face.hairColor;
  switch (face.hair) {
    case 'long':
      return <path d="M29.5 46 C28.5 27 38 19.5 50 19.5 C62 19.5 71.5 27 70.5 46 L71.5 72 Q64 76.5 59 71 L59 58 L41 58 L41 71 Q36 76.5 28.5 72 Z" fill={fill} />;
    case 'bob':
      return <path d="M29.5 47 C28.5 27 38.5 20 50 20 C61.5 20 71.5 27 70.5 47 L70.5 60 Q60 63.5 50 61 Q40 63.5 29.5 60 Z" fill={fill} />;
    case 'curly':
      return (
        <g fill={fill}>
          {[
            [33, 36, 8],
            [39, 27, 9],
            [50, 23, 10],
            [61, 27, 9],
            [67, 36, 8],
            [31, 46, 6],
            [69, 46, 6],
          ].map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
          ))}
        </g>
      );
    case 'bun':
      return <circle cx="50" cy="17.5" r="7.5" fill={fill} />;
    default:
      return null;
  }
}

function HairFront({ face }: { face: AgentFace }) {
  const fill = face.hairColor;
  switch (face.hair) {
    case 'short':
    case 'bun':
      return <path d="M31.5 46 C30 31 38 22.5 50 22.5 C62 22.5 70 31 68.5 46 C67 39 64 34.5 58 33 C52 36.5 41 37 35 35.5 C33 38 32 42 31.5 46 Z" fill={fill} />;
    case 'side':
      return <path d="M31.5 47 C29.5 30 38 21.5 51 21.5 C63 21.5 70.5 30 68.5 47 C67.5 40 66 36 62 33.5 C55 33 46 35.5 40 40 C37 37 35 35.5 33.5 36 C32.5 39.5 31.8 43 31.5 47 Z" fill={fill} />;
    case 'buzz':
      return <path d="M32.5 42 C32 30 40 24.5 50 24.5 C60 24.5 68 30 67.5 42 C65 35.5 59 32 50 32 C41 32 35 35.5 32.5 42 Z" fill={fill} opacity={0.85} />;
    case 'long':
      return <path d="M32 44 C31.5 29 39.5 22 50 22 C60.5 22 68.5 29 68 44 C64 36 58 31.5 49 32.5 C42 33.5 36 37.5 32 44 Z" fill={fill} />;
    case 'bob':
      return <path d="M32 42 C31.5 28 39.5 22 50 22 C60.5 22 68.5 28 68 42 C67 37 66 35 65 34 Q50 37.5 35 34 C34 35 33 37 32 42 Z" fill={fill} />;
    case 'curly':
      return (
        <g fill={fill}>
          {[
            [38, 31],
            [46, 28.5],
            [54, 28.5],
            [62, 31],
          ].map(([cx, cy]) => (
            <circle key={cx} cx={cx} cy={cy} r="5.5" />
          ))}
        </g>
      );
    case 'spiky':
      return (
        <path
          d="M31.5 45 C31 36 33 30 36 27 L35 20 L41 24.5 L43 16.5 L48 23 L51 15 L54.5 22.5 L59 16.5 L60 24.5 L66 21 L64.5 28 C67.5 32 69 38 68.5 45 C66 38 61 34 50 34 C39 34 34 38 31.5 45 Z"
          fill={fill}
        />
      );
    case 'bald':
      return face.skin === CHROME_SKIN ? null : <ellipse cx="43" cy="31" rx="4" ry="2" fill="#fff" opacity={0.25} />;
  }
}

function Eye({ kind, x }: { kind: AgentFace['eyes']; x: number }) {
  const stroke = { stroke: INK, strokeWidth: 1.7, strokeLinecap: 'round' as const, fill: 'none' };
  switch (kind) {
    case 'dots':
      return <circle cx={x} cy="47" r="2.1" fill={INK} />;
    case 'happy':
      return <path d={`M${x - 2.4} 48 Q${x} 45.2 ${x + 2.4} 48`} {...stroke} />;
    case 'calm':
      return <path d={`M${x - 2.4} 47 Q${x} 49.2 ${x + 2.4} 47`} {...stroke} />;
    case 'wide':
      return (
        <g>
          <circle cx={x} cy="47" r="3.4" fill="#fff" />
          <circle cx={x} cy="47.3" r="1.8" fill={INK} />
          <circle cx={x + 0.7} cy="46.5" r="0.6" fill="#fff" />
        </g>
      );
    default:
      return (
        <g>
          <ellipse cx={x} cy="47" rx="2.4" ry="2.9" fill={INK} />
          <circle cx={x + 0.8} cy="46" r="0.8" fill="#fff" />
        </g>
      );
  }
}

function Brows({ face }: { face: AgentFace }) {
  const color = face.hair === 'bald' || light(face.hairColor) ? shade(face.skin, 0.45) : shade(face.hairColor, 0.1);
  const props = { stroke: color, strokeWidth: 1.6, strokeLinecap: 'round' as const, fill: 'none' };
  switch (face.brows) {
    case 'soft':
      return <path d="M40 41.5 Q43 39.8 46 41 M54 41 Q57 39.8 60 41.5" {...props} />;
    case 'flat':
      return <path d="M40 41 L46 41 M54 41 L60 41" {...props} />;
    case 'raised':
      return <path d="M40 40 Q43 37.5 46 39.5 M54 39.5 Q57 37.5 60 40" {...props} />;
    case 'focused':
      return <path d="M40 39.8 L46 41.6 M54 41.6 L60 39.8" {...props} />;
    case 'none':
      return null;
  }
}

function Mouth({ kind }: { kind: AgentFace['mouth'] }) {
  const stroke = { stroke: INK, strokeWidth: 1.7, strokeLinecap: 'round' as const, fill: 'none' };
  switch (kind) {
    case 'grin':
      return (
        <g>
          <path d="M44.5 56 Q50 63 55.5 56 Z" fill={MOUTH} />
          <path d="M45.4 56.4 Q50 57.8 54.6 56.4 L54.1 57.5 Q50 58.9 45.9 57.5 Z" fill="#fff" />
        </g>
      );
    case 'neutral':
      return <path d="M46.5 57.5 L53.5 57.5" {...stroke} />;
    case 'open':
      return <ellipse cx="50" cy="57.8" rx="2.6" ry="2.2" fill={MOUTH} />;
    case 'smirk':
      return <path d="M46 57.5 Q51 59.5 54.5 55.8" {...stroke} />;
    default:
      return <path d="M45.5 56.5 Q50 60.5 54.5 56.5" {...stroke} />;
  }
}

function Beard({ face }: { face: AgentFace }) {
  const fill = face.hairColor;
  const moustache = <path d="M44 54.6 Q47 52.6 50 54 Q53 52.6 56 54.6 Q53 56.4 50 55.4 Q47 56.4 44 54.6 Z" fill={fill} />;
  switch (face.beard) {
    case 'stubble':
      return <path d="M33 50 C34 61 41 66.5 50 66.5 C59 66.5 66 61 67 50 C64 57 58 60 50 60 C42 60 36 57 33 50 Z" fill={fill} opacity={0.28} />;
    case 'moustache':
      return moustache;
    case 'full':
      return (
        <g>
          <path d="M32.5 47 C32.5 62 40 68.5 50 68.5 C60 68.5 67.5 62 67.5 47 C66 54 62 56.5 58 55.5 Q50 53 42 55.5 C38 56.5 34 54 32.5 47 Z" fill={fill} />
          {moustache}
        </g>
      );
    case 'none':
      return null;
  }
}

function Glasses({ kind }: { kind: AgentFace['glasses'] }) {
  const frame = { stroke: INK, strokeWidth: 1.4, fill: '#fff', fillOpacity: 0.12 };
  const rest = <path d="M47.8 46.5 Q50 45.3 52.2 46.5 M38.2 46 L32.5 45 M61.8 46 L67.5 45" stroke={INK} strokeWidth={1.4} fill="none" strokeLinecap="round" />;
  switch (kind) {
    case 'round':
      return (
        <g>
          <circle cx="43" cy="47" r="4.8" {...frame} />
          <circle cx="57" cy="47" r="4.8" {...frame} />
          {rest}
        </g>
      );
    case 'square':
      return (
        <g>
          <rect x="37.6" y="43" width="10.8" height="8" rx="2.2" {...frame} />
          <rect x="51.6" y="43" width="10.8" height="8" rx="2.2" {...frame} />
          {rest}
        </g>
      );
    case 'none':
      return null;
  }
}

function Extra({ face, accent }: { face: AgentFace; accent: string }) {
  switch (face.extra) {
    case 'headset':
      return (
        <g>
          <path d="M30 46 C29 28 38 19 50 19 C62 19 71 28 70 46" stroke="#2a2f36" strokeWidth={2.6} fill="none" />
          <rect x="27" y="41" width="6" height="11" rx="3" fill="#2a2f36" />
          <rect x="67" y="41" width="6" height="11" rx="3" fill="#2a2f36" />
          <path d="M30 51 Q31 60 42 60.5" stroke="#2a2f36" strokeWidth={1.8} fill="none" strokeLinecap="round" />
          <circle cx="43" cy="60.5" r="1.8" fill="#2a2f36" />
        </g>
      );
    case 'earrings':
      return (
        <g fill="#f2c94c">
          <circle cx="32.2" cy="52.6" r="1.6" />
          <circle cx="67.8" cy="52.6" r="1.6" />
        </g>
      );
    case 'antenna':
      return (
        <g>
          <path d="M50 25.5 L50 14.5" stroke="#8a96a6" strokeWidth={1.8} strokeLinecap="round" />
          <circle cx="50" cy="12.5" r="2.6" fill={accent} stroke="#fff" strokeWidth={0.8} />
        </g>
      );
    case 'none':
      return null;
  }
}

/** The face itself, drawn on a 100×100 grid and framed to its middle 80: shoulders in `shirt`, then the head and its parts. */
export function FaceArt({ face, shirt, accent, className, style }: { face: AgentFace; shirt: string; accent?: string; className?: string; style?: CSSProperties }) {
  const skinShade = shade(face.skin, 0.14);
  const robot = face.skin === CHROME_SKIN;
  return (
    <svg viewBox="10 8 80 80" className={className} style={style} aria-hidden="true">
      <path d="M12 104 C12 84 28 74 50 74 C72 74 88 84 88 104 Z" fill={shirt} />
      <rect x="43" y="56" width="14" height="19" rx="5" fill={skinShade} />
      <path d="M42 74 Q50 82 58 74 Z" fill={skinShade} />
      <HairBack face={face} />
      <ellipse cx="32" cy="47" rx="3.6" ry="4.6" fill={face.skin} />
      <ellipse cx="68" cy="47" rx="3.6" ry="4.6" fill={face.skin} />
      <ellipse cx="50" cy="45" rx="18" ry="20" fill={face.skin} />
      {robot && <path d="M33 45 L67 45" stroke={skinShade} strokeWidth={0.8} opacity={0.6} />}
      {!robot && (
        <g fill="#ff6b6b" opacity={0.16}>
          <circle cx="38.5" cy="53" r="2.8" />
          <circle cx="61.5" cy="53" r="2.8" />
        </g>
      )}
      <Beard face={face} />
      <HairFront face={face} />
      <Brows face={face} />
      <Eye kind={face.eyes === 'wink' ? 'round' : face.eyes} x={43} />
      <Eye kind={face.eyes === 'wink' ? 'happy' : face.eyes} x={57} />
      <path d="M50 48 Q48.6 52.4 50.6 53" stroke={skinShade} strokeWidth={1.4} strokeLinecap="round" fill="none" />
      <Mouth kind={face.mouth} />
      <Glasses kind={face.glasses} />
      <Extra face={face} accent={accent ?? shirt} />
    </svg>
  );
}

/** Anything an avatar can be drawn from: an agent, its config, its summary or a template's config. */
export interface AvatarSource {
  name?: string;
  icon?: string;
  color?: string;
  avatar?: AgentAvatarConfig;
}

/**
 * The agent's avatar on its tile. `size` in px; the corners follow the app icons (28%), or a circle with `round`. Faces and
 * images fill the tile; an icon or initials sit in the middle.
 */
export function AgentAvatar({ agent, size = 40, round, className }: { agent: AvatarSource; size?: number; round?: boolean; className?: string }) {
  const color = agent.color || '#a855f7';
  const avatar = agent.avatar;
  const solid = Boolean(avatar?.solid);
  const tile: CSSProperties = {
    width: size,
    height: size,
    background: solid ? color : `color-mix(in oklab, ${color} 14%, var(--sf))`,
  };
  const shape = cn('relative grid shrink-0 place-items-center overflow-hidden border border-hair', round ? 'rounded-full' : 'rounded-[28%]', className);
  if (avatar?.kind === 'image' && avatar.image)
    return (
      <span className={shape} style={tile}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={avatar.image} alt="" className="size-full object-cover" draggable={false} />
      </span>
    );
  if (avatar?.kind === 'face' && avatar.face)
    return (
      <span className={shape} style={tile}>
        <FaceArt face={avatar.face} shirt={solid ? shade(color.length === 7 ? color : '#a855f7', 0.3) : color} accent={color} className="size-full" />
      </span>
    );
  if (avatar?.kind === 'initials' && avatar.initials)
    return (
      <span className={shape} style={tile}>
        <span className="font-semibold leading-none tracking-[-0.02em]" style={{ fontSize: Math.round(size * 0.38), color: solid ? '#fff' : color }}>
          {avatar.initials}
        </span>
      </span>
    );
  return (
    <span className={shape} style={tile}>
      <NodeIcon icon={agent.icon || 'bot'} size={Math.round(size * 0.5)} style={{ color: solid ? '#fff' : color }} strokeWidth={1.8} />
    </span>
  );
}
