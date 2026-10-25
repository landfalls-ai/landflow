/**
 * The host's built-in "core" plugin. It is registered in-process, but its
 * nodes implement exactly the same INodeType interface as every external
 * plugin — there is no privileged node API.
 */
import { definePlugin } from '@landflow/sdk';
import { messageAgentNode, workflowTrigger } from './agents';
import { aiAgentNode, anthropicChatModelNode, calculatorToolNode, ollamaChatModelNode, simpleMemoryNode } from './ai';
import { chainLlmNode, informationExtractorNode, textClassifierNode } from './chains';
import { anthropicApiCredential, openAiApiCredential } from './credentials';
import { codeNode, httpRequestNode, setNode } from './data';
import { dataTableNode } from './datatable';
import { dateTimeNode } from './datetime';
import { filterNode, ifNode, limitNode, mergeNode, noOpNode, sortNode, stopAndErrorNode, switchNode, waitNode } from './flow';
import { recordMetricNode } from './metric';
import { openAiChatModelNode, openAiNode } from './openai';
import { aggregateNode, removeDuplicatesNode, renameKeysNode, splitOutNode, summarizeNode } from './transform';
import { chatTrigger, manualTrigger, scheduleTrigger, webhookTrigger } from './triggers';

export const corePlugin = definePlugin({
  info: {
    id: 'core',
    name: 'Landflow Core',
    version: '0.1.0',
    description: 'Built-in triggers, flow control, data and AI nodes',
    icon: 'lucide:hexagon',
    color: '#64748b',
    author: 'Landflow',
  },
  nodes: [
    manualTrigger,
    webhookTrigger,
    chatTrigger,
    scheduleTrigger,
    workflowTrigger,
    httpRequestNode,
    setNode,
    codeNode,
    ifNode,
    switchNode,
    filterNode,
    mergeNode,
    sortNode,
    limitNode,
    splitOutNode,
    aggregateNode,
    removeDuplicatesNode,
    summarizeNode,
    renameKeysNode,
    dateTimeNode,
    waitNode,
    noOpNode,
    stopAndErrorNode,
    recordMetricNode,
    dataTableNode,
    aiAgentNode,
    messageAgentNode,
    chainLlmNode,
    textClassifierNode,
    informationExtractorNode,
    openAiNode,
    anthropicChatModelNode,
    ollamaChatModelNode,
    openAiChatModelNode,
    simpleMemoryNode,
    calculatorToolNode,
  ],
  credentialTypes: [openAiApiCredential, anthropicApiCredential],
});
