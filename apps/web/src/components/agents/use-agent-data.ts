'use client';
/** Node types and agents the builder looks things up in, loaded once and shared. */
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '@/lib/client/api';
import type { AgentSummary } from '@/lib/shared/agents';
import type { NodeTypeInfo } from '@/lib/shared/types';

interface AgentDataState {
  nodeTypes?: Record<string, NodeTypeInfo>;
  agents?: AgentSummary[];
  loadNodeTypes(): Promise<void>;
  loadAgents(): Promise<void>;
}

export const useAgentData = create<AgentDataState>((set) => ({
  async loadNodeTypes() {
    try {
      const { nodeTypes } = await api<{ nodeTypes: NodeTypeInfo[] }>('/api/node-types');
      set({ nodeTypes: Object.fromEntries(nodeTypes.map((t) => [t.type, t])) });
    } catch {
      set((s) => ({ nodeTypes: s.nodeTypes ?? {} }));
    }
  },
  async loadAgents() {
    try {
      const { agents } = await api<{ agents: AgentSummary[] }>('/api/agents');
      set({ agents });
    } catch {
      set((s) => ({ agents: s.agents ?? [] }));
    }
  },
}));

export function useNodeTypes() {
  const nodeTypes = useAgentData((s) => s.nodeTypes);
  useEffect(() => {
    void useAgentData.getState().loadNodeTypes();
  }, []);
  return nodeTypes;
}

export function useAgentList() {
  const agents = useAgentData((s) => s.agents);
  useEffect(() => {
    void useAgentData.getState().loadAgents();
  }, []);
  return agents;
}
