/**
 * Files as model inputs: the "Include Binary as Input" option of the AI Agent, the chains and the OpenAI
 * node. Images and PDFs (and plain-text files) of the input item become attachments of the user message;
 * each model adapter (./models) maps them onto its provider: Anthropic image / document blocks, OpenAI
 * `image_url` / `file` parts, Ollama's `images` (PDFs are read as text there, Ollama has no documents).
 */
import { NodeOperationError, type IExecuteContext, type PropertyDescriptor } from '@landflow/sdk';
import type { ModelAttachment } from '@landflow/engine';

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Larger files are refused before they reach a provider (Anthropic: 5 MB per image, 32 MB per request). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const isText = (mimeType: string) => mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml';

/** The node options that turn it on (in each root node's Options collection). */
export const BINARY_INPUT_OPTIONS: PropertyDescriptor[] = [
  {
    name: 'passthroughBinaryImages',
    displayName: 'Include Binary as Input',
    type: 'boolean',
    default: false,
    description: 'Send the input item’s images and PDFs to the model along with the prompt (vision and document models)',
  },
  {
    name: 'binaryPropertyNames',
    displayName: 'Binary Fields',
    type: 'string',
    default: '',
    placeholder: 'e.g. data, receipt',
    description: 'Which binary fields to send, comma-separated. Empty: every image, PDF and text file of the item.',
    displayOptions: { show: { passthroughBinaryImages: [true] } },
  },
];

/** What kind of attachment a MIME type makes; undefined when models can't take it. */
export function attachmentKind(mimeType: string): ModelAttachment['kind'] | undefined {
  const type = mimeType.toLowerCase().split(';')[0].trim();
  if (IMAGE_TYPES.has(type)) return 'image';
  if (type === 'application/pdf' || isText(type)) return 'document';
  return undefined;
}

/**
 * The attachments of input item `itemIndex`: every image / PDF / text file, or the named fields
 * (a named field that is missing or of another type is an error; unnamed ones are skipped).
 */
export async function binaryAttachments(ctx: IExecuteContext, itemIndex: number, names = ''): Promise<ModelAttachment[]> {
  const item = ctx.getInputData()[itemIndex];
  const binary = item?.binary ?? {};
  const wanted = names
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const keys = wanted.length ? wanted : Object.keys(binary);
  const attachments: ModelAttachment[] = [];
  for (const key of keys) {
    const ref = binary[key];
    if (!ref) {
      if (wanted.length) throw new NodeOperationError(`The item has no binary field “${key}”`, { itemIndex, description: `It has: ${Object.keys(binary).join(', ') || 'no binary data'}.` });
      continue;
    }
    const mimeType = (ref.mimeType || 'application/octet-stream').toLowerCase().split(';')[0].trim();
    const kind = attachmentKind(mimeType);
    if (!kind) {
      if (wanted.length) throw new NodeOperationError(`“${key}” is ${mimeType}, which models can’t read`, { itemIndex, description: 'Send PNG, JPEG, GIF or WebP images, PDFs or text files.' });
      continue;
    }
    if (ref.fileSize > MAX_ATTACHMENT_BYTES) {
      throw new NodeOperationError(`“${ref.fileName ?? key}” is too large for a model input`, { itemIndex, description: `${Math.round(ref.fileSize / 1024 / 1024)} MB; the limit is 20 MB.` });
    }
    const bytes = await ctx.helpers.getBinaryDataBuffer(itemIndex, key);
    attachments.push({ kind, mimeType, data: bytes.toString('base64'), ...(ref.fileName && { fileName: ref.fileName }) });
  }
  return attachments;
}

/** Attachments as the root node's option asks (none when the option is off). */
export async function optionalAttachments(ctx: IExecuteContext, itemIndex: number, options: { passthroughBinaryImages?: unknown; binaryPropertyNames?: unknown }): Promise<ModelAttachment[] | undefined> {
  if (!options.passthroughBinaryImages) return undefined;
  const attachments = await binaryAttachments(ctx, itemIndex, typeof options.binaryPropertyNames === 'string' ? options.binaryPropertyNames : '');
  return attachments.length ? attachments : undefined;
}

/** Plain text of a text attachment. */
export const attachmentText = (attachment: ModelAttachment) => Buffer.from(attachment.data, 'base64').toString('utf8');

/** A PDF's text (unpdf, loaded on first use), for providers without document input. */
export async function pdfAttachmentText(attachment: ModelAttachment): Promise<string> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  try {
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(attachment.data, 'base64')));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n\n') : text;
  } catch (error) {
    throw new NodeOperationError(`Can’t read the PDF ${attachment.fileName ?? ''}`.trim(), { description: (error as Error).message });
  }
}

/** For memory and run data: attachments without their bytes. */
export function withoutAttachmentData<T extends { role: string }>(message: T): T {
  const attachments = (message as { attachments?: ModelAttachment[] }).attachments;
  if (!attachments?.length) return message;
  const { attachments: _drop, ...rest } = message as T & { attachments?: ModelAttachment[] };
  const names = attachments.map((a) => a.fileName ?? a.mimeType).join(', ');
  const content = (rest as { content?: string }).content ?? '';
  return { ...rest, content: `${content}\n[attached: ${names}]`.trim() } as unknown as T;
}
