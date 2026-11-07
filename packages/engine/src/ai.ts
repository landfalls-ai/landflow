/**
 * Capability contracts that sub-nodes supply to root nodes over `ai_*` ports.
 * Provider-neutral on purpose: an Anthropic, Ollama or remote model sub-node
 * all implement LanguageModel; any node can become an AgentTool.
 */
import type { BinaryRef, JsonObject, NodeItem } from '@landflow/protocol';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * An image a tool returned. Stored by reference: `ref` points at the stored file (memory, the journal and saved run
 * state keep only that). `data` (base64, no `data:` prefix) is present only in flight: a tool that has just made the
 * bytes, or the copy the agent node loads from `ref` for the one model call that sends it.
 */
export interface ToolImage {
  mimeType: string;
  ref?: BinaryRef;
  data?: string;
  fileName?: string;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
  /** Images the tool returned, shown to the model next to `content` (see `splitToolOutput`). */
  images?: ToolImage[];
}

/**
 * What a tool may return to hand the model images: the text for the model and the journal, and the images (by `ref`
 * or inline `data`). `value` is the plain result the tool would have returned without images, for consumers that
 * cannot show images. A tool that returns anything else behaves as before.
 */
export interface ToolOutputWithImages {
  text: string;
  images: ToolImage[];
  value?: unknown;
}

export function isToolOutputWithImages(output: unknown): output is ToolOutputWithImages {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const { text, images } = output as { text?: unknown; images?: unknown };
  return (
    typeof text === 'string' &&
    Array.isArray(images) &&
    images.length > 0 &&
    images.every((image) => image && typeof image === 'object' && typeof (image as ToolImage).mimeType === 'string' && ((image as ToolImage).data !== undefined || (image as ToolImage).ref !== undefined))
  );
}

/** A tool's return value as the model's text and its images (none for a plain value). */
export function splitToolOutput(output: unknown): { text: string; images: ToolImage[] } {
  if (isToolOutputWithImages(output)) return { text: output.text, images: output.images };
  return { text: typeof output === 'string' ? output : (JSON.stringify(output) ?? ''), images: [] };
}

/**
 * A file sent to the model with a user message (an image or a PDF from an item's binary data, a chat upload). Each
 * adapter maps it to its provider's blocks: Anthropic image/document blocks, OpenAI `image_url`/`file` parts, Ollama
 * `images`. `data` is base64 without a `data:` prefix.
 */
export interface ModelAttachment {
  /** `audio` goes to OpenAI-compatible models as `input_audio` parts (wav, mp3), `video` as `video_url` parts where a server takes them. */
  kind: 'image' | 'document' | 'audio' | 'video';
  mimeType: string;
  data: string;
  fileName?: string;
  /** The stored file it was read from, when it came from an item's binary data (memory keeps it to re-attach the file later). */
  ref?: BinaryRef;
}

/** A file a user turn carried, kept by memory instead of its bytes: the reference to read it again. */
export interface RememberedFile {
  ref: BinaryRef;
  fileName?: string;
}

export type AgentMessage =
  | {
      role: 'user';
      content: string;
      attachments?: ModelAttachment[];
      /** What memory keeps of the turn's files (their references, not their bytes), so later turns can attach them again. */
      files?: RememberedFile[];
    }
  | {
      role: 'assistant';
      text: string;
      toolCalls: ToolCall[];
      /** Provider-native content (e.g. Anthropic blocks incl. thinking), replayed verbatim to the same provider. */
      raw?: { provider: string; content: unknown };
    }
  | { role: 'tool'; results: ToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface ModelTurn {
  text: string;
  raw?: { provider: string; content: unknown };
  toolCalls: ToolCall[];
  stopReason: string;
  /**
   * `inputTokens` counts the whole prompt; `cacheReadTokens` (Anthropic cache reads, OpenAI cached input) and
   * `cacheWriteTokens` (Anthropic cache writes) are the parts of it served from or written to the provider's cache.
   */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

export interface LanguageModel {
  readonly provider: string;
  readonly model: string;
  generate(input: {
    system?: string;
    messages: AgentMessage[];
    tools: ToolSpec[];
    signal?: AbortSignal;
    /** Ask for a JSON reply where the provider supports it (OpenAI `response_format`, Ollama `format`). */
    responseFormat?: 'text' | 'json';
    /**
     * Stream the reply: the adapter asks its provider for a stream and calls this with each text delta as it
     * arrives. The returned turn is the same as without it (full text, tool calls, usage).
     */
    onToken?: (delta: string) => void;
  }): Promise<ModelTurn>;
}

export interface AgentTool extends ToolSpec {
  /** Node id that implements the tool (for UI highlighting). */
  nodeId?: string;
  invoke(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface AgentMemory {
  load(sessionId: string): Promise<AgentMessage[]>;
  save(sessionId: string, messages: AgentMessage[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Retrieval (RAG): what the ai_embedding, ai_document, ai_textSplitter,
// ai_retriever and ai_reranker sub-nodes supply
// ---------------------------------------------------------------------------

/** A piece of text with metadata (LangChain's Document): what loaders produce, splitters cut and vector stores keep. */
export interface AiDocument {
  pageContent: string;
  metadata: JsonObject;
  /** Set by vector stores. */
  id?: string;
  /** Set by retrieval: similarity, fused or reranked score; higher is better. */
  score?: number;
}

/** An embeddings model (`ai_embedding`). */
export interface Embeddings {
  readonly provider: string;
  readonly model: string;
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
}

/** Cuts text into chunks (`ai_textSplitter`). */
export interface TextSplitter {
  splitText(text: string): Promise<string[]>;
}

/** Turns the root node's input items into documents (`ai_document`), split by its text splitter. */
export interface DocumentLoader {
  load(items: NodeItem[]): Promise<AiDocument[]>;
}

export interface RetrieveOptions {
  /** How many documents to return (the retriever's own setting when absent). */
  topK?: number;
  signal?: AbortSignal;
}

/** Finds the documents relevant to a query (`ai_retriever`): a vector store in retrieve mode. */
export interface Retriever {
  retrieve(query: string, options?: RetrieveOptions): Promise<AiDocument[]>;
}

/** Re-orders retrieved documents by relevance to the query (`ai_reranker`) and keeps the best `topK`. */
export interface Reranker {
  rerank(query: string, documents: AiDocument[], options?: RetrieveOptions): Promise<AiDocument[]>;
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for every major provider. */
export function toToolName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || 'tool';
}
