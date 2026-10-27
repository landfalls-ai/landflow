/**
 * Files as model inputs: the "Include Binary as Input" option of the AI Agent, the chains and the OpenAI
 * node. Images and PDFs (and plain-text files) of the input item become attachments of the user message;
 * each model adapter (./models) maps them onto its provider: Anthropic image / document blocks, OpenAI
 * `image_url` / `file` parts, Ollama's `images` (PDFs are read as text there, Ollama has no documents).
 *
 * Audio goes to OpenAI-compatible models that take it as `input_audio` parts (wav and mp3); for any other model
 * (or format) the node can transcribe it first through an OpenAI-compatible `/audio/transcriptions` endpoint.
 * Video goes where a provider accepts it (`video_url` parts of OpenAI-compatible servers such as Gemini's or
 * vLLM's); anything else is an error naming the model, as there is no ffmpeg here to cut it into frames.
 *
 * Memory keeps a reference to each file of a turn (`files`), and the node can attach those files again on later
 * turns, up to a size cap (`rememberedAttachments`).
 */
import { NodeOperationError, type IExecuteContext, type PropertyDescriptor } from '@landflow/sdk';
import type { AgentMessage, ModelAttachment, RememberedFile } from '@landflow/engine';

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
    description: 'Which binary fields to send, comma-separated. Empty: every image, PDF, text, audio and video file of the item.',
    displayOptions: { show: { passthroughBinaryImages: [true] } },
  },
  {
    name: 'audioHandling',
    displayName: 'Audio',
    type: 'options',
    default: 'auto',
    description: 'What to do with audio files',
    displayOptions: { show: { passthroughBinaryImages: [true] } },
    options: [
      { name: 'Automatic', value: 'auto', description: 'Send wav and mp3 to models that take audio (names with audio, omni, voxtral or gemini); transcribe the rest when an endpoint is set' },
      { name: 'Send to the Model', value: 'send', description: 'Always send it as input_audio (OpenAI-compatible models; wav and mp3 only)' },
      { name: 'Transcribe First', value: 'transcribe', description: 'Turn it into text through the transcription endpoint below' },
    ],
  },
  {
    name: 'transcriptionUrl',
    displayName: 'Transcription Endpoint',
    type: 'string',
    default: '',
    placeholder: 'https://api.openai.com/v1',
    description: 'An OpenAI-compatible API root; /audio/transcriptions is added. Empty: the node’s OpenAI credential’s base URL (its key is sent there)',
    displayOptions: { show: { passthroughBinaryImages: [true] } },
  },
  {
    name: 'transcriptionModel',
    displayName: 'Transcription Model',
    type: 'string',
    default: 'whisper-1',
    displayOptions: { show: { passthroughBinaryImages: [true] } },
  },
  {
    name: 'videoHandling',
    displayName: 'Video',
    type: 'options',
    default: 'auto',
    description: 'Video goes to OpenAI-compatible servers that accept it as a video_url part; there is no frame extraction',
    displayOptions: { show: { passthroughBinaryImages: [true] } },
    options: [
      { name: 'Automatic', value: 'auto', description: 'Send it to models known to take video (names with gemini, qwen-vl, qwen-omni, video or internvl); an error for the rest' },
      { name: 'Send to the Model', value: 'send', description: 'Always send it (OpenAI-compatible models)' },
    ],
  },
];

/** The AI Agent's extra options: attach the files of earlier turns (kept by its memory) again. */
export const MEMORY_FILE_OPTIONS: PropertyDescriptor[] = [
  {
    name: 'rememberedAttachments',
    displayName: 'Re-attach Files from Memory',
    type: 'boolean',
    default: false,
    description: 'Attach the files of earlier turns again (read from the stored data of the run that received them; files whose run was deleted are skipped)',
    displayOptions: { show: { passthroughBinaryImages: [true] } },
  },
  {
    name: 'rememberedAttachmentsMaxMb',
    displayName: 'Memory Files Size Cap (MB)',
    type: 'number',
    default: 10,
    typeOptions: { minValue: 1, maxValue: 100 },
    description: 'The newest files are attached first, until this many MB are reached',
    displayOptions: { show: { passthroughBinaryImages: [true], rememberedAttachments: [true] } },
  },
];

/** What the media options need besides the files. */
export interface MediaOptions {
  audioHandling?: unknown;
  transcriptionUrl?: unknown;
  transcriptionModel?: unknown;
  videoHandling?: unknown;
}

/** What kind of attachment a MIME type makes; undefined when models can't take it. */
export function attachmentKind(mimeType: string): ModelAttachment['kind'] | undefined {
  const type = mimeType.toLowerCase().split(';')[0].trim();
  if (IMAGE_TYPES.has(type)) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
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
      if (wanted.length) throw new NodeOperationError(`“${key}” is ${mimeType}, which models can’t read`, { itemIndex, description: 'Send PNG, JPEG, GIF or WebP images, PDFs, text, audio or video files.' });
      continue;
    }
    if (ref.fileSize > MAX_ATTACHMENT_BYTES) {
      throw new NodeOperationError(`“${ref.fileName ?? key}” is too large for a model input`, { itemIndex, description: `${Math.round(ref.fileSize / 1024 / 1024)} MB; the limit is 20 MB.` });
    }
    const bytes = await ctx.helpers.getBinaryDataBuffer(itemIndex, key);
    attachments.push({ kind, mimeType, data: bytes.toString('base64'), ...(ref.fileName && { fileName: ref.fileName }), ...(ref.id && { ref }) });
  }
  return attachments;
}

/**
 * Attachments as the root node's option asks (none when the option is off). With `model`, audio and video are
 * adapted to it: sent, transcribed, or refused with an error naming the model.
 */
export async function optionalAttachments(
  ctx: IExecuteContext,
  itemIndex: number,
  options: { passthroughBinaryImages?: unknown; binaryPropertyNames?: unknown } & MediaOptions,
  model?: { provider: string; model: string },
): Promise<ModelAttachment[] | undefined> {
  if (!options.passthroughBinaryImages) return undefined;
  const attachments = await binaryAttachments(ctx, itemIndex, typeof options.binaryPropertyNames === 'string' ? options.binaryPropertyNames : '');
  const adapted = model ? await adaptMedia(ctx, attachments, model, options, itemIndex) : attachments;
  return adapted.length ? adapted : undefined;
}

// ---------------------------------------------------------------------------
// Audio and video
// ---------------------------------------------------------------------------

/** MIME types an OpenAI-compatible `input_audio` part takes, with its `format`. */
export const AUDIO_FORMATS: Record<string, 'wav' | 'mp3'> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
};

const AUDIO_MODELS = /audio|omni|voxtral|gemini|gemma-3n|ultravox|step-audio/i;
const VIDEO_MODELS = /gemini|qwen[\w.-]*(vl|omni)|video|internvl|llava-next-video|minicpm-v/i;

/** The `input_audio` format of an audio attachment, when OpenAI-compatible APIs take it. */
export const audioFormat = (attachment: Pick<ModelAttachment, 'mimeType'>) => AUDIO_FORMATS[attachment.mimeType.toLowerCase().split(';')[0].trim()];

/** Whether the model is known to take audio / video as input (OpenAI-compatible providers only). */
export const acceptsAudio = (model: { provider: string; model: string }) => model.provider === 'openai' && AUDIO_MODELS.test(model.model);
export const acceptsVideo = (model: { provider: string; model: string }) => model.provider === 'openai' && VIDEO_MODELS.test(model.model);

/** The text of an audio file from an OpenAI-compatible `/audio/transcriptions` endpoint. */
export async function transcribeAudio(
  ctx: IExecuteContext,
  attachment: ModelAttachment,
  endpoint: { baseUrl: string; apiKey?: string; model: string },
  itemIndex: number,
): Promise<string> {
  const form = new FormData();
  const name = attachment.fileName ?? `audio.${attachment.mimeType.split('/')[1]?.split(';')[0] || 'bin'}`;
  form.append('file', new Blob([Buffer.from(attachment.data, 'base64')], { type: attachment.mimeType }), name);
  form.append('model', endpoint.model);
  form.append('response_format', 'json');
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  let response: Response;
  try {
    response = await ctx.http(url, { method: 'POST', body: form, headers: { ...(endpoint.apiKey && { authorization: `Bearer ${endpoint.apiKey}` }) }, ...(ctx.signal && { signal: ctx.signal }) });
  } catch (error) {
    throw new NodeOperationError(`Can’t reach the transcription endpoint ${url}`, { itemIndex, description: (error as Error).message });
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new NodeOperationError(`Transcribing ${name} failed (${response.status})`, { itemIndex, description: `${url}${detail ? `: ${detail}` : ''}` });
  }
  const body = (await response.json().catch(() => ({}))) as { text?: unknown };
  if (typeof body.text !== 'string') throw new NodeOperationError(`The transcription endpoint returned no text for ${name}`, { itemIndex, description: url });
  return body.text;
}

/**
 * Make audio and video attachments something `model` can take. Audio: sent as `input_audio` to models that accept it
 * (wav, mp3) when the option allows, else transcribed through the node's endpoint, else an error. Video: kept for
 * OpenAI-compatible models that accept it, else an error naming the model.
 */
export async function adaptMedia(
  ctx: IExecuteContext,
  attachments: ModelAttachment[],
  model: { provider: string; model: string },
  options: MediaOptions,
  itemIndex: number,
): Promise<ModelAttachment[]> {
  const label = `${model.provider}/${model.model}`;
  const audioMode = options.audioHandling === 'send' || options.audioHandling === 'transcribe' ? options.audioHandling : 'auto';
  const videoMode = options.videoHandling === 'send' ? 'send' : 'auto';
  const out: ModelAttachment[] = [];
  for (const file of attachments) {
    const name = file.fileName ?? file.mimeType;
    if (file.kind === 'video') {
      if (model.provider !== 'openai') {
        throw new NodeOperationError(`${label} can’t take video input (${name})`, { itemIndex, description: 'Video goes to OpenAI-compatible servers that accept video_url parts (Gemini’s compatibility API, vLLM with a video model). Landflow does not extract frames.' });
      }
      if (videoMode === 'auto' && !acceptsVideo(model)) {
        throw new NodeOperationError(`${label} isn’t known to take video input (${name})`, { itemIndex, description: 'Pick a video-capable model, or set “Video” to “Send to the Model” if your server accepts video_url parts for this one.' });
      }
      out.push(file);
      continue;
    }
    if (file.kind !== 'audio') {
      out.push(file);
      continue;
    }
    const canSend = model.provider === 'openai' && audioFormat(file) !== undefined;
    const send = audioMode === 'send' || (audioMode === 'auto' && acceptsAudio(model));
    if (send && canSend) {
      out.push(file);
      continue;
    }
    if (send && !canSend) {
      // "Send" was asked for but this model or format can't: transcribing is the way out when it's configured.
      if (!transcriptionTarget(ctx, options)) {
        throw new NodeOperationError(
          model.provider !== 'openai' ? `${label} can’t take audio input (${name})` : `${name} is ${file.mimeType}: audio input takes wav or mp3`,
          { itemIndex, description: 'Use a wav or mp3 file with an OpenAI-compatible audio model, or set a transcription endpoint on the node.' },
        );
      }
    }
    const target = transcriptionTarget(ctx, options);
    if (!target) {
      throw new NodeOperationError(`${label} can’t take audio input (${name}) and no transcription endpoint is set`, {
        itemIndex,
        description: 'Set “Transcription Endpoint” (an OpenAI-compatible /audio/transcriptions API) on the node, or use an audio-capable model.',
      });
    }
    const text = await transcribeAudio(ctx, file, target, itemIndex);
    out.push({
      kind: 'document',
      mimeType: 'text/plain',
      data: Buffer.from(text, 'utf8').toString('base64'),
      fileName: `${file.fileName ?? 'audio'} (transcript)`,
      ...(file.ref && { ref: file.ref }),
    });
  }
  return out;
}

/** Where to transcribe: the node's endpoint, else its OpenAI credential's base URL (with its key). */
function transcriptionTarget(ctx: IExecuteContext, options: MediaOptions): { baseUrl: string; apiKey?: string; model: string } | undefined {
  const credential = ctx.getCredentials<{ apiKey?: string; baseUrl?: string }>('openAiApi', { optional: true });
  const baseUrl = (typeof options.transcriptionUrl === 'string' && options.transcriptionUrl.trim()) || credential?.baseUrl?.trim();
  if (!baseUrl) return undefined;
  const model = (typeof options.transcriptionModel === 'string' && options.transcriptionModel.trim()) || 'whisper-1';
  return { baseUrl, model, ...(credential?.apiKey && { apiKey: credential.apiKey }) };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

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

/**
 * For memory and run data: attachments without their bytes. The file names stay in the text, and each file that came
 * from stored binary data keeps its reference in `files`, so a later turn can attach it again.
 */
export function withoutAttachmentData<T extends { role: string }>(message: T): T {
  const attachments = (message as { attachments?: ModelAttachment[] }).attachments;
  if (!attachments?.length) return message;
  const { attachments: _drop, ...rest } = message as T & { attachments?: ModelAttachment[]; files?: RememberedFile[] };
  const names = attachments.map((a) => a.fileName ?? a.mimeType).join(', ');
  const content = (rest as { content?: string }).content ?? '';
  const files = new Map<string, RememberedFile>();
  for (const file of rest.files ?? []) if (file.ref.id) files.set(file.ref.id, file);
  for (const attachment of attachments) {
    if (attachment.ref?.id && !files.has(attachment.ref.id)) files.set(attachment.ref.id, { ref: attachment.ref, ...(attachment.fileName && { fileName: attachment.fileName }) });
  }
  const note = `[attached: ${names}]`;
  return { ...rest, content: content.includes(note) ? content : `${content}\n${note}`.trim(), ...(files.size && { files: [...files.values()] }) } as unknown as T;
}

/** The trailing `[attached: …]` note of a remembered turn (the real files replace it). */
const ATTACHED_NOTE = /\n?\[attached: [^\]]*\]$/;

/**
 * Memory turns with their files attached again: newest turns first, until `maxBytes` of files are reached.
 * Files whose stored data is gone (their run was deleted) or that the model can't take are skipped with a log line.
 * Returns the history to send to the model; what memory saves is built from the same messages by `withoutAttachmentData`.
 */
export async function reattachRemembered(
  ctx: IExecuteContext,
  history: AgentMessage[],
  options: { maxBytes: number; model?: { provider: string; model: string } } & MediaOptions,
  itemIndex: number,
): Promise<AgentMessage[]> {
  let budget = options.maxBytes;
  const rebuilt = new Map<number, ModelAttachment[]>();
  for (let index = history.length - 1; index >= 0 && budget > 0; index--) {
    const message = history[index];
    if (message.role !== 'user' || !message.files?.length) continue;
    const attachments: ModelAttachment[] = [];
    for (const file of message.files) {
      const mimeType = (file.ref.mimeType || 'application/octet-stream').toLowerCase().split(';')[0].trim();
      const kind = attachmentKind(mimeType);
      const name = file.fileName ?? file.ref.fileName ?? 'a file';
      if (!kind) continue;
      if (file.ref.fileSize > budget) {
        ctx.logger.warn(`Memory: ${name} (${Math.round(file.ref.fileSize / 1024)} KB) is over the size cap for remembered files; not attached again`);
        continue;
      }
      try {
        const bytes = await ctx.helpers.binaryToBuffer(file.ref);
        budget -= bytes.byteLength;
        attachments.push({ kind, mimeType, data: bytes.toString('base64'), ref: file.ref, ...(file.fileName && { fileName: file.fileName }) });
      } catch (error) {
        ctx.logger.warn(`Memory: can’t read ${name} again (${(error as Error).message}); the turn keeps its note only`);
      }
    }
    if (!attachments.length) continue;
    try {
      rebuilt.set(index, options.model ? await adaptMedia(ctx, attachments, options.model, options, itemIndex) : attachments);
    } catch (error) {
      ctx.logger.warn(`Memory: not attaching an earlier turn’s files again: ${(error as Error).message}`);
    }
  }
  return history.map((message, index) =>
    message.role === 'user' && rebuilt.has(index) ? { ...message, content: message.content.replace(ATTACHED_NOTE, ''), attachments: rebuilt.get(index) } : message,
  );
}
