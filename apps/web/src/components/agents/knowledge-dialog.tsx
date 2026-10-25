'use client';
/**
 * Build tab → Capabilities → Add knowledge base: a vector store collection the agent searches with a
 * tool. Documents get in through a workflow (a vector store node in “Insert Documents” mode with the
 * same store, collection and embeddings model); this dialog only points the agent at them.
 */
import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import type { KnowledgeBaseToolConfig } from '@/lib/shared/agents';
import { NodeCredentials } from '../credentials/node-credentials';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/inputs';
import { Dialog, Field, ToggleRow } from './dialog';
import { newId } from './util';

const STORES: Array<{ value: KnowledgeBaseToolConfig['store']; label: string; hint: string }> = [
  { value: 'sqlite', label: 'SQLite (Landflow’s data folder)', hint: 'Kept in vectors.sqlite next to Landflow’s other data' },
  { value: 'pgvector', label: 'Postgres PGVector', hint: 'A Postgres database with the vector extension' },
  { value: 'memory', label: 'In-memory', hint: 'Lost when the server restarts; for trying things out' },
];

export const STORE_LABEL: Record<KnowledgeBaseToolConfig['store'], string> = { sqlite: 'SQLite', pgvector: 'PGVector', memory: 'In-memory' };

export function KnowledgeTile({ size = 32 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-[10px] border border-hair bg-sf text-t2" style={{ width: size, height: size }}>
      <BookOpen className="size-3.5" />
    </span>
  );
}

export function KnowledgeDialog({ tool, onSave, onClose }: { tool?: KnowledgeBaseToolConfig; onSave: (tool: KnowledgeBaseToolConfig) => void; onClose: () => void }) {
  const [value, setValue] = useState<KnowledgeBaseToolConfig>(
    () =>
      tool ?? {
        id: newId('tool'),
        type: 'knowledge',
        name: 'search_knowledge_base',
        description: 'Search the knowledge base for passages that help answer a question. Use it before answering questions about the documents.',
        store: 'sqlite',
        collection: 'landflow',
        embeddings: { provider: 'ollama', model: 'nomic-embed-text' },
        topK: 4,
        searchMode: 'hybrid',
      },
  );
  const set = (patch: Partial<KnowledgeBaseToolConfig>) => setValue((v) => ({ ...v, ...patch }));
  const setEmbeddings = (patch: Partial<KnowledgeBaseToolConfig['embeddings']>) => setValue((v) => ({ ...v, embeddings: { ...v.embeddings, ...patch } }));
  const valid = Boolean(
    value.name.trim() &&
      value.collection.trim() &&
      value.embeddings.model.trim() &&
      (value.store !== 'pgvector' || value.credential) &&
      (value.embeddings.provider !== 'openai' || value.embeddings.credential),
  );

  return (
    <Dialog
      title={tool ? value.name || 'Knowledge base' : 'Add a knowledge base'}
      subtitle="A vector store collection the agent searches before it answers"
      icon={<KnowledgeTile />}
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!valid} onClick={() => onSave({ ...value, name: value.name.trim(), collection: value.collection.trim() })}>
            {tool ? 'Save knowledge base' : 'Add knowledge base'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded-[10px] border border-hair bg-wl px-3 py-2.5 text-[12px] leading-snug text-t2">
          Fill it with a workflow: a vector store node in <b>Insert Documents</b> mode with the same store and collection, a Default Data Loader and the same
          embeddings model as below.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field id="kb-name" label="Tool name" required hint="What the model calls">
            <Input id="kb-name" value={value.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field id="kb-collection" label="Collection" required>
            <Input id="kb-collection" value={value.collection} onChange={(e) => set({ collection: e.target.value })} />
          </Field>
        </div>
        <Field id="kb-description" label="When to search it" hint="Tells the model what the documents are about">
          <Input id="kb-description" value={value.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field id="kb-store" label="Vector store" hint={STORES.find((s) => s.value === value.store)?.hint}>
          <Select id="kb-store" value={value.store} onChange={(e) => set({ store: e.target.value as KnowledgeBaseToolConfig['store'] })}>
            {STORES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        {value.store === 'pgvector' && (
          <>
            <NodeCredentials
              nodeType="core.vectorStorePGVector"
              requirements={[{ name: 'postgres', required: true }]}
              value={value.credential ? { postgres: value.credential } : undefined}
              onChange={(refs) => set({ credential: refs?.postgres })}
            />
            <Field id="kb-table" label="Table">
              <Input id="kb-table" value={value.tableName ?? ''} placeholder="landflow_vectors" onChange={(e) => set({ tableName: e.target.value || undefined })} />
            </Field>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field id="kb-provider" label="Embeddings">
            <Select
              id="kb-provider"
              value={value.embeddings.provider}
              onChange={(e) => {
                const provider = e.target.value as KnowledgeBaseToolConfig['embeddings']['provider'];
                setEmbeddings({ provider, model: provider === 'openai' ? 'text-embedding-3-small' : 'nomic-embed-text' });
              }}
            >
              <option value="ollama">Ollama</option>
              <option value="openai">OpenAI-compatible</option>
            </Select>
          </Field>
          <Field id="kb-model" label="Embeddings model" required>
            <Input id="kb-model" value={value.embeddings.model} onChange={(e) => setEmbeddings({ model: e.target.value })} />
          </Field>
        </div>
        {value.embeddings.provider === 'ollama' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field id="kb-base-url" label="Ollama URL">
              <Input id="kb-base-url" value={value.embeddings.baseUrl ?? ''} placeholder="http://127.0.0.1:11434" onChange={(e) => setEmbeddings({ baseUrl: e.target.value || undefined })} />
            </Field>
            <Field id="kb-query-prefix" label="Query prefix" hint="nomic-embed-text: “search_query: ”">
              <Input id="kb-query-prefix" value={value.embeddings.queryPrefix ?? ''} onChange={(e) => setEmbeddings({ queryPrefix: e.target.value || undefined })} />
            </Field>
          </div>
        ) : (
          <NodeCredentials
            nodeType="core.embeddingsOpenAi"
            requirements={[{ name: 'openAiApi', required: true }]}
            value={value.embeddings.credential ? { openAiApi: value.embeddings.credential } : undefined}
            onChange={(refs) => setEmbeddings({ credential: refs?.openAiApi })}
          />
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field id="kb-topk" label="Passages per search">
            <Input id="kb-topk" type="number" min={1} max={50} value={value.topK ?? 4} onChange={(e) => set({ topK: Math.max(1, Math.min(50, Number(e.target.value) || 4)) })} />
          </Field>
          <Field id="kb-search" label="Search">
            <Select id="kb-search" value={value.searchMode ?? 'vector'} onChange={(e) => set({ searchMode: e.target.value as 'vector' | 'hybrid' })}>
              <option value="hybrid">Hybrid (meaning + keywords)</option>
              <option value="vector">By meaning (vectors)</option>
            </Select>
          </Field>
        </div>
        <ToggleRow
          title="Require approval"
          description="Pause before every search until someone approves it."
          checked={Boolean(value.requireApproval)}
          onChange={(requireApproval) => set({ requireApproval })}
        />
      </div>
    </Dialog>
  );
}
