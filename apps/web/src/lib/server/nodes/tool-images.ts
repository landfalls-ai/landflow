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
import type { AgentMessage, ToolImage, ToolResult } from '@landflow/engine';

/** How many of the newest tool images go to the model by default. */
export const DEFAULT_KEPT_TOOL_IMAGES = 2;

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

/**
 * The messages for one model call: tool images beyond the newest `keep` are dropped, the kept ones are read from the
 * store and attached (`data`), and a model that can't see gets a note. The input messages are not changed, so what
 * memory saves stays free of bytes.
 */
export async function hydrateToolImages(
  ctx: Pick<IExecuteContext, 'helpers' | 'logger'>,
  messages: AgentMessage[],
  options: { model: { provider: string; model: string }; keep?: number; mode?: ToolImageMode },
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
            kept.unshift({ ...image, data: bytes });
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
