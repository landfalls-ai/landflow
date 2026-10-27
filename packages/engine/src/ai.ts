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

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
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
