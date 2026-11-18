'use client';
/**
 * The agent a builder page is editing, for the pickers inside it: with it, a credential picker offers only what the agent's home
 * project may use (the server refuses a new credential outside it) and "Create" makes the credential in that project. Outside an
 * agent page there is none and nothing changes.
 */
import { createContext, useContext } from 'react';

const AgentScope = createContext<string | undefined>(undefined);
export const AgentScopeProvider = AgentScope.Provider;
export const useAgentScope = () => useContext(AgentScope);
