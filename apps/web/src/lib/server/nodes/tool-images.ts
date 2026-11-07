/**
 * Images a tool returns (a screenshot, a chart): kept by reference, shown to the model only when it can see.
 *
 * A tool result carries `images` as references to stored files (`ToolResult.images[].ref`). Memory, the journal, the
 * stream and the saved run state hold those references, never the bytes. Just before a model call the agent node
 * builds the wire messages with `hydrateToolImages`: the newest N images are read back from the store and attached,
 * older ones are dropped (their text stays, with a note), and a model that can't see images gets the text and a note
 * saying so instead of an error.
 */
import type { IExecuteContext } from '@landflow/sdk';
import type { BinaryRef } from '@landflow/protocol';
import type { AgentMessage, ToolImage, ToolResult } from '@landflow/engine';

/** How many of the newest tool images go to the model by default. */
export const DEFAULT_KEPT_TOOL_IMAGES = 2;

/** The most a provider gets of one image by default: longest side in px and bytes (Anthropic rejects over 5 MB or about 2,576 px). */
export const DEFAULT_IMAGE_MAX_EDGE = 1568;
export const DEFAULT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

export interface ImageLimits {
  maxEdge?: number;
  maxBytes?: number;
}

export type ToolImageMode = 'auto' | 'send' | 'text';

/** Ollama model names known to see images; an unknown local name needs the node's "Send" setting. */
const OLLAMA_VISION = /llava|vision|gemma-?3|qwen\d*(\.\d+)?[-_]?vl|qwen3\.[5-9]|minicpm-v|moondream|llama-?4|mistral-small3|pixtral|bakllava/i;
/** OpenAI-compatible model names known not to. */
const OPENAI_TEXT_ONLY = /gpt-3\.5|o1-mini|o3-mini|^text-|embed|deepseek-(chat|reasoner|coder)|coder|whisper|tts/i;

/** Whether a model is known to see images: Claude does, Ollama by name, OpenAI-compatible unless its name says otherwise. */
export function modelSeesImages(model: { provider: string; model: string }): boolean {
  if (model.provider === 'anthropic') return true;
  if (model.provider === 'ollama') return OLLAMA_VISION.test(model.model);
  return !OPENAI_TEXT_ONLY.test(model.model);
}

/** "image/png, 12 KB". */
export function imageSizeLabel(image: ToolImage): string {
  const bytes = image.ref?.fileSize ?? (image.data ? Math.floor((image.data.length * 3) / 4) : 0);
  const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${image.mimeType}, ${size}`;
}

/**
 * The tool's images as stored references: inline bytes (a tool that just made them) are written to the binary store
 * and dropped from the result, so nothing downstream carries base64.
 */
export async function storeToolImages(ctx: Pick<IExecuteContext, 'helpers'>, images: ToolImage[]): Promise<ToolImage[]> {
  const stored: ToolImage[] = [];
  for (const image of images) {
    const inline = image.data ?? (image.ref && !image.ref.id ? image.ref.data : undefined);
    if (inline !== undefined) {
      const name = image.fileName ?? image.ref?.fileName ?? `image.${image.mimeType.split('/')[1] ?? 'png'}`;
      const ref = await ctx.helpers.prepareBinaryData(Buffer.from(inline, 'base64'), name, image.mimeType);
      // A store that keeps small files inline in the ref would put the bytes back into memory: strip them.
      const { data: _data, ...rest } = ref;
      stored.push({ mimeType: image.mimeType, ref: rest, fileName: name });
    } else if (image.ref) {
      const { data: _data, ...rest } = image.ref;
      stored.push({ mimeType: image.mimeType, ref: rest, ...(image.fileName && { fileName: image.fileName }) });
    }
  }
  return stored;
}

type Sharp = typeof import('sharp').default;
let sharpLoad: Promise<Sharp | undefined> | undefined;
/** sharp (a native module): loaded once, and absent is fine: images are then only skipped when over the byte limit. */
function loadSharp(): Promise<Sharp | undefined> {
  sharpLoad ??= import('sharp').then((m) => (m.default ?? m) as unknown as Sharp, () => undefined);
  return sharpLoad;
}

/**
 * An image kept within the limits: PNG, JPEG, WebP and GIF are scaled down (longest side) and, if still too big,
 * PNG becomes JPEG. Without sharp, or for a type it can't handle, an image over the byte limit is `skipped` with the reason.
 */
export async function fitImage(base64: string, mimeType: string, limits: ImageLimits = {}): Promise<{ data: string; mimeType: string; resized?: string } | { skipped: string }> {
  const maxEdge = limits.maxEdge ?? DEFAULT_IMAGE_MAX_EDGE;
  const maxBytes = limits.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES;
  const bytes = Buffer.from(base64, 'base64');
  const sharp = await loadSharp();
  if (sharp) {
    try {
      const meta = await sharp(bytes).metadata();
      const edge = Math.max(meta.width ?? 0, meta.height ?? 0);
      if (edge <= maxEdge && bytes.length <= maxBytes) return { data: base64, mimeType };
      let type = mimeType;
      const scaled = () => sharp(bytes).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
      let out = type === 'image/jpeg' ? await scaled().jpeg({ quality: 85 }).toBuffer() : type === 'image/webp' ? await scaled().webp({ quality: 85 }).toBuffer() : await scaled().png().toBuffer();
      if (out.length > maxBytes && type !== 'image/jpeg') {
        type = 'image/jpeg';
        out = await scaled().flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
      }
      if (out.length <= maxBytes) {
        const after = await sharp(out).metadata();
        return { data: out.toString('base64'), mimeType: type, resized: `${meta.width}x${meta.height} ${Math.round(bytes.length / 1024)} KB to ${after.width}x${after.height} ${Math.round(out.length / 1024)} KB` };
      }
      return { skipped: `still ${(out.length / 1024 / 1024).toFixed(1)} MB after scaling to ${maxEdge} px` };
    } catch (error) {
      if (bytes.length <= maxBytes) return { data: base64, mimeType };
      return { skipped: `it can’t be scaled down (${(error as Error).message})` };
    }
  }
  return bytes.length <= maxBytes ? { data: base64, mimeType } : { skipped: `${(bytes.length / 1024 / 1024).toFixed(1)} MB is over the ${(maxBytes / 1024 / 1024).toFixed(0)} MB limit and the image library isn’t available to scale it` };
}

/** The image files of an item's binary data, as tool images by reference (what a node tool's screenshot is). */
export function binaryToolImages(binary: Record<string, BinaryRef> | undefined, max = 4): ToolImage[] {
  const types = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  return Object.values(binary ?? {})
    .map((ref) => ({ ref, type: (ref.mimeType ?? '').toLowerCase().split(';')[0].trim() }))
    .filter(({ ref, type }) => types.has(type) && (ref.id || ref.data))
    .slice(0, max)
    .map(({ ref, type }) => ({ mimeType: type, ref, ...(ref.fileName && { fileName: ref.fileName }) }));
}

/**
 * The messages for one model call: tool images beyond the newest `keep` are dropped, the kept ones are read from the
 * store and attached (`data`), and a model that can't see gets a note. The input messages are not changed, so what
 * memory saves stays free of bytes.
 */
export async function hydrateToolImages(
  ctx: Pick<IExecuteContext, 'helpers' | 'logger'>,
  messages: AgentMessage[],
  options: { model: { provider: string; model: string }; keep?: number; mode?: ToolImageMode; limits?: ImageLimits },
): Promise<AgentMessage[]> {
  if (!messages.some((m) => m.role === 'tool' && m.results.some((r) => r.images?.length))) return messages;
  const keep = Math.max(0, Math.floor(options.keep ?? DEFAULT_KEPT_TOOL_IMAGES));
  const sees = options.mode === 'send' ? true : options.mode === 'text' ? false : modelSeesImages(options.model);
  const label = `${options.model.provider}/${options.model.model}`;
  let budget = keep;
  const out = [...messages];
  // Newest first: the last N images are the ones kept.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'tool') continue;
    const results: ToolResult[] = [];
    // Within one turn, later results are newer.
    for (const result of [...message.results].reverse()) {
      const images = result.images ?? [];
      if (!images.length) {
        results.unshift(result);
        continue;
      }
      const kept: ToolImage[] = [];
      const notes: string[] = [];
      let unseen = 0;
      let omitted = 0;
      for (const image of [...images].reverse()) {
        if (!sees) unseen++;
        else if (budget <= 0) omitted++;
        else {
          try {
            const bytes = image.data ?? (image.ref ? (image.ref.id ? (await ctx.helpers.binaryToBuffer(image.ref)).toString('base64') : image.ref.data) : undefined);
            if (bytes === undefined) throw new Error('no data');
            const fitted = await fitImage(bytes, image.mimeType, options.limits);
            if ('skipped' in fitted) {
              ctx.logger.warn(`Tool image not sent: ${fitted.skipped}`);
              notes.push(`[an image this tool returned was not sent: ${fitted.skipped}]`);
              continue;
            }
            kept.unshift({ ...image, mimeType: fitted.mimeType, data: fitted.data });
            budget--;
          } catch (error) {
            ctx.logger.warn(`Tool image can’t be read again (${(error as Error).message}); the model gets the text only`);
            notes.push('[an image this tool returned could not be read again]');
          }
        }
      }
      if (unseen) notes.push(`[${unseen} image(s) returned by this tool were not sent: ${label} can’t see images. Use a vision model, or set “Send Tool Images” on the node if it can.]`);
      if (omitted) notes.push(`[${omitted} earlier image(s) omitted: only the last ${keep} tool image(s) are sent to the model.]`);
      const { images: _images, ...rest } = result;
      results.unshift({ ...rest, content: [result.content, ...notes].filter(Boolean).join('\n'), ...(kept.length && { images: kept }) });
    }
    out[index] = { role: 'tool', results };
  }
  return out;
}
