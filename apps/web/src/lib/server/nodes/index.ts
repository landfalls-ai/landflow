/**
 * The host's built-in "core" plugin. It is registered in-process, but its
 * nodes implement exactly the same INodeType interface as every external
 * plugin — there is no privileged node API.
 */
import { definePlugin } from '@landflow/sdk';
import { a2aAgentNode } from './a2a';
import { runTeamNode } from './run-team';
import { messageAgentNode, workflowTrigger } from './agents';
import { landflowUsageNode, suggestImprovementNode, usageTriggerNode } from './usage';
import { aiAgentNode, anthropicChatModelNode, calculatorToolNode, ollamaChatModelNode, simpleMemoryNode } from './ai';
import { chainLlmNode, informationExtractorNode, textClassifierNode } from './chains';
import { aiStep } from './composites';
import { anthropicApiCredential, cohereApiCredential, httpBasicAuthCredential, httpBearerAuthCredential, httpHeaderAuthCredential, jwtAuthCredential, openAiApiCredential, strandsDeciderApiCredential, typesafeApiCredential } from './credentials';
import { oAuth2ApiCredential } from './oauth2-credential';
import { mcpOAuth2ApiCredential } from './mcp-oauth-credential';
import { sshPrivateKeyCredential } from './ssh-credential';
import { codeNode, httpRequestNode, setNode } from './data';
import { dataTableNode } from './datatable';
import { dateTimeNode } from './datetime';
import { emailReadImapNode, imapCredential } from './email-imap';
import { kagentCredential } from './kagent-credential';
import { microsoftBotCredential } from './microsoft-bot-credential';
import { evaluationNode, evaluationTrigger } from './evaluation';
import { convertToFileNode, extractFromFileNode, readWriteFileNode } from './files';
import { filterNode, ifNode, limitNode, mergeNode, noOpNode, respondToWebhookNode, sortNode, splitInBatchesNode, stopAndErrorNode, switchNode, waitNode } from './flow';
import { formNode, formTrigger } from './forms';
import { guardrailsNode } from './guardrails';
import { mcpClientNode, mcpClientToolNode, mcpTrigger } from './mcp';
import { recordMetricNode } from './metric';
import {
  defaultDataLoaderNode,
  embeddingsOllamaNode,
  embeddingsOpenAiNode,
  llmRerankerNode,
  cohereRerankerNode,
  recursiveCharacterTextSplitterNode,
  retrievalQaChainNode,
  tokenTextSplitterNode,
} from './rag';
import { inMemoryVectorStoreNode, pgVectorStoreNode, postgresCredential, sqliteVectorStoreNode } from './vector-stores';
import { openAiChatModelNode, openAiNode } from './openai';
import { aggregateNode, removeDuplicatesNode, renameKeysNode, splitOutNode, summarizeNode } from './transform';
import { chatTrigger, errorTrigger, manualTrigger, scheduleTrigger, webhookTrigger } from './triggers';
import { executeWorkflowNode } from './workflows';
import { findRunbookNode } from './runbooks';
import { runReportNode } from './run-report';

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
    emailReadImapNode,
    workflowTrigger,
    formTrigger,
    errorTrigger,
    mcpTrigger,
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
    splitInBatchesNode,
    executeWorkflowNode,
    findRunbookNode,
    respondToWebhookNode,
    formNode,
    noOpNode,
    stopAndErrorNode,
    recordMetricNode,
    dataTableNode,
    readWriteFileNode,
    extractFromFileNode,
    convertToFileNode,
    aiAgentNode,
    messageAgentNode,
    runTeamNode,
    a2aAgentNode,
    landflowUsageNode,
    usageTriggerNode,
    suggestImprovementNode,
    chainLlmNode,
    textClassifierNode,
    informationExtractorNode,
    openAiNode,
    anthropicChatModelNode,
    ollamaChatModelNode,
    openAiChatModelNode,
    simpleMemoryNode,
    calculatorToolNode,
    mcpClientToolNode,
    mcpClientNode,
    inMemoryVectorStoreNode,
    sqliteVectorStoreNode,
    pgVectorStoreNode,
    embeddingsOllamaNode,
    embeddingsOpenAiNode,
    defaultDataLoaderNode,
    recursiveCharacterTextSplitterNode,
    tokenTextSplitterNode,
    llmRerankerNode,
    cohereRerankerNode,
    retrievalQaChainNode,
    guardrailsNode,
    runReportNode,
    evaluationTrigger,
    evaluationNode,
  ],
  composites: [aiStep],
  credentialTypes: [openAiApiCredential, anthropicApiCredential, typesafeApiCredential, strandsDeciderApiCredential, cohereApiCredential, httpBearerAuthCredential, httpHeaderAuthCredential, postgresCredential, oAuth2ApiCredential, mcpOAuth2ApiCredential, httpBasicAuthCredential, jwtAuthCredential, imapCredential, microsoftBotCredential, sshPrivateKeyCredential, kagentCredential],
});
