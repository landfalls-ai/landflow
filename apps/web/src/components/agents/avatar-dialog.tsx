'use client';
/**
 * The avatar picker (docs/agents.md#avatars): a face put together from parts (or shuffled), an icon, initials or an image,
 * on a tile tinted with or filled with the agent's colour. Opened from the agent's header and the New agent dialog; Done
 * hands back the avatar, icon and colour.
 */
import { useRef, useState } from 'react';
import { ImageUp, Shuffle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { MAX_AVATAR_IMAGE, type AgentAvatar as AgentAvatarConfig } from '@/lib/shared/agents';
import { FACE_HAIR_COLORS, FACE_PARTS, FACE_SKINS, randomFace, type AgentFace } from '@/lib/shared/faces';
import { Button } from '../ui/button';
import { NodeIcon } from '../ui/icon';
import { Input } from '../ui/inputs';
import { AgentAvatar } from './avatar';
import { Dialog } from './dialog';

export const AGENT_ICONS = [
  'bot',
  'sparkles',
  'brain',
  'headset',
  'mail',
  'message-circle',
  'calendar',
  'search',
  'file-text',
  'database',
  'shopping-cart',
  'code',
  'shield',
  'briefcase',
  'life-buoy',
  'megaphone',
  'newspaper',
  'rocket',
  'globe',
  'zap',
  'siren',
  'pen-line',
  'chart-line',
  'hand-heart',
];
export const AGENT_COLORS = ['#a855f7', '#6366f1', '#3b82f6', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#64748b'];

export interface AvatarChoice {
  avatar?: AgentAvatarConfig;
  icon: string;
  color: string;
}

type Mode = AgentAvatarConfig['kind'];
const MODES: Array<[Mode, string]> = [
  ['face', 'Face'],
  ['icon', 'Icon'],
  ['initials', 'Initials'],
  ['image', 'Image'],
];

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0])
    .join('')
    .toUpperCase() || 'A';

/** An image file scaled and cropped to a 256 px square, as a data: URL small enough to keep in the agent's config. */
async function squareImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That file isn’t an image the browser can read'));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.getContext('2d')!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    for (const quality of [0.9, 0.75, 0.6]) {
      const data = canvas.toDataURL('image/webp', quality);
      // Browsers without WebP encoding hand back PNG.
      if (data.length <= MAX_AVATAR_IMAGE) return data;
    }
    const jpeg = canvas.toDataURL('image/jpeg', 0.7);
    if (jpeg.length <= MAX_AVATAR_IMAGE) return jpeg;
    throw new Error('The image is still too large after scaling it down');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-[10px] border border-hair bg-wl p-0.5">
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={cn('h-7 rounded-[8px] px-3 text-[12px] transition-colors', value === key ? 'bg-sf font-semibold text-t1 shadow-sm' : 'text-t2 hover:text-t1')}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Swatches({ colors, value, onChange, label }: { colors: readonly string[]; value: string; onChange: (c: string) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={color}
          aria-pressed={value === color}
          onClick={() => onChange(color)}
          className={cn('size-6 rounded-full border-2 transition-transform hover:scale-110', value === color ? 'border-t1' : 'border-transparent')}
          style={{ background: color, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.12)' }}
        />
      ))}
    </div>
  );
}

function FaceEditor({ face, color, onChange }: { face: AgentFace; color: string; onChange: (face: AgentFace) => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-semibold text-t2">Skin</div>
        <Button size="sm" variant="ghost" onClick={() => onChange(randomFace(`${Date.now()}-${Math.random()}`))}>
          <Shuffle className="size-3.5" /> Shuffle
        </Button>
      </div>
      <Swatches colors={FACE_SKINS} value={face.skin} onChange={(skin) => onChange({ ...face, skin })} label="Skin" />
      <div className="text-[12px] font-semibold text-t2">Hair colour</div>
      <Swatches colors={FACE_HAIR_COLORS} value={face.hairColor} onChange={(hairColor) => onChange({ ...face, hairColor })} label="Hair colour" />
      {FACE_PARTS.map((part) => (
        <div key={part.key}>
          <div className="mb-1.5 text-[12px] font-semibold text-t2">{part.label}</div>
          <div role="group" aria-label={part.label} className="flex flex-wrap gap-1.5">
            {part.options.map((option) => {
              const on = face[part.key] === option;
              const preview = { ...face, [part.key]: option } as AgentFace;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={on}
                  title={(part.labels as Record<string, string>)[option]}
                  onClick={() => onChange(preview)}
                  className={cn('flex flex-col items-center gap-1 rounded-xl border p-1 transition-colors', on ? 'border-ac bg-acdim' : 'border-hair hover:border-bd')}
                >
                  <AgentAvatar agent={{ color, avatar: { kind: 'face', face: preview } }} size={40} />
                  <span className="text-[10px] text-t3">{(part.labels as Record<string, string>)[option]}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AvatarDialog({
  name,
  subtitle,
  seed,
  value,
  onClose,
  onDone,
}: {
  name: string;
  subtitle?: string;
  /** A face to start from when the agent has none yet: its id or name. */
  seed: string;
  value: AvatarChoice;
  onClose: () => void;
  onDone: (choice: AvatarChoice) => void;
}) {
  const [mode, setMode] = useState<Mode>(value.avatar?.kind ?? 'icon');
  const [face, setFace] = useState<AgentFace>(value.avatar?.face ?? randomFace(seed));
  const [icon, setIcon] = useState(value.icon || 'bot');
  const [color, setColor] = useState(value.color || '#a855f7');
  const [initials, setInitials] = useState(value.avatar?.initials ?? initialsOf(name));
  const [image, setImage] = useState(value.avatar?.image);
  const [solid, setSolid] = useState(Boolean(value.avatar?.solid));
  const fileInput = useRef<HTMLInputElement>(null);

  const avatar: AgentAvatarConfig | undefined =
    mode === 'face'
      ? { kind: 'face', face, ...(solid && { solid }) }
      : mode === 'initials'
        ? { kind: 'initials', initials: initials || initialsOf(name), ...(solid && { solid }) }
        : mode === 'image' && image
          ? { kind: 'image', image }
          : solid
            ? { kind: 'icon', solid }
            : undefined;

  const upload = async (file?: File) => {
    if (!file) return;
    try {
      setImage(await squareImage(file));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <Dialog
      title="Avatar"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={mode === 'image' && !image} onClick={() => onDone({ avatar, icon, color })}>
            Done
          </Button>
        </>
      }
    >
      <div className="-mx-5 -mt-4 mb-4 flex flex-col items-center gap-2 border-b border-hair bg-wl px-5 py-5">
        <AgentAvatar agent={{ name, icon, color, avatar: avatar ?? undefined }} size={96} />
        <div className="text-center">
          <div className="text-[14px] font-semibold text-t1">{name || 'Untitled agent'}</div>
          {subtitle && <div className="text-[12px] text-t3">{subtitle}</div>}
        </div>
      </div>

      <div className="space-y-4">
        <Segmented label="Avatar kind" value={mode} options={MODES} onChange={setMode} />

        {mode === 'face' && <FaceEditor face={face} color={color} onChange={setFace} />}

        {mode === 'icon' && (
          <div role="group" aria-label="Icon" className="grid grid-cols-8 gap-1.5">
            {AGENT_ICONS.map((name) => (
              <button
                key={name}
                type="button"
                aria-label={name}
                aria-pressed={icon === name}
                onClick={() => setIcon(name)}
                className={cn('grid h-10 place-items-center rounded-lg border transition-colors', icon === name ? 'border-ac bg-acdim' : 'border-hair hover:border-bd')}
              >
                <NodeIcon icon={name} size={17} style={{ color }} />
              </button>
            ))}
          </div>
        )}

        {mode === 'initials' && (
          <div>
            <label htmlFor="avatar-initials" className="mb-1.5 block text-[12px] font-semibold text-t2">
              Initials
            </label>
            <Input
              id="avatar-initials"
              value={initials}
              maxLength={2}
              onChange={(e) => setInitials(Array.from(e.target.value.replace(/\s+/g, '')).slice(0, 2).join('').toUpperCase())}
              className="w-[120px] font-semibold tracking-[0.04em]"
            />
            <p className="mt-1 text-[12px] text-t3">One or two letters.</p>
          </div>
        )}

        {mode === 'image' && (
          <div>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void upload(e.dataTransfer.files?.[0]);
              }}
              className="flex h-[136px] w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-bd bg-wl text-t1 transition-colors hover:border-ac"
            >
              <ImageUp className="size-5 text-t2" />
              <span className="text-[13px] font-medium">{image ? 'Replace the image' : 'Drop an image, or browse'}</span>
              <span className="text-[12px] text-t3">PNG, JPEG or WebP. It’s cropped to a square and scaled to 256 px.</span>
            </button>
          </div>
        )}

        <div className="space-y-2">
          <div className="text-[12px] font-semibold text-t2">Colour</div>
          <Swatches colors={AGENT_COLORS} value={color} onChange={setColor} label="Colour" />
        </div>
        {mode !== 'image' && (
          <div className="flex items-center justify-between gap-3">
            <div className="text-[12px] font-semibold text-t2">Tile</div>
            <Segmented
              label="Tile"
              value={solid ? 'solid' : 'soft'}
              options={[
                ['soft', 'Soft'],
                ['solid', 'Solid'],
              ]}
              onChange={(v) => setSolid(v === 'solid')}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
