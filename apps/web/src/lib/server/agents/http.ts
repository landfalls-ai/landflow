/** Request schemas and the SSE response shared by the agent routes. */
import { z } from 'zod';
import { PLUGIN_ID, type AgentConfig, type AgentStreamEvent } from '../../shared/agents';
import { sseHeaders } from '../http';
import { logger } from '../telemetry';

const ref = z.object({ id: z.string(), name: z.string() });

const guardrailRule = z.object({
  enabled: z.boolean(),
  action: z.enum(['block', 'sanitize']),
  reply: z.string().max(5_000),
  replacement: z.enum(['redact', 'mask']).optional(),
  judge: z.object({ provider: z.string().min(1).max(64), credential: ref.optional(), model: z.string().max(200).optional() }).optional(),
  checks: z.object({}).passthrough(),
});

/** A draft or an imported config: the builder owns the shape, the store fills what's missing. */
export const agentConfigSchema = z
  .object({
    name: z.string().max(200).optional(),
    description: z.string().max(5_000).optional(),
    icon: z.string().max(64).optional(),
    color: z.string().max(32).optional(),
    model: z
      .object({
        provider: z.enum(['anthropic', 'openai', 'ollama']),
        model: z.string(),
        credential: ref.optional(),
        baseUrl: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
      })
      .optional()
      .nullable(),
    persona: z
      .object({
        role: z.string().max(500),
        audience: z.string().max(500),
        mission: z.string().max(5_000),
        tones: z.array(z.string().max(40)).max(20),
        length: z.enum(['sentence', 'paragraph', 'detailed']),
        language: z.string().max(60),
        signoff: z.string().max(200),
        whatIDo: z.array(z.string().max(300)).max(10),
        always: z.array(z.string().max(1_000)).max(50),
        never: z.array(z.string().max(1_000)).max(50),
        examples: z.array(z.object({ user: z.string().max(5_000), assistant: z.string().max(5_000) })).max(10),
      })
      .partial()
      .optional(),
    instructions: z.string().max(100_000).optional(),
    skills: z.array(z.object({ id: z.string(), name: z.string(), whenToUse: z.string(), instructions: z.string().max(65_536) }).passthrough()).optional(),
    tools: z.array(z.object({ id: z.string(), type: z.enum(['node', 'workflow', 'agent', 'mcp', 'knowledge', 'a2a']) }).passthrough()).optional(),
    schedules: z.array(z.object({ id: z.string(), prompt: z.string(), frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly', 'cron']) }).passthrough()).optional(),
    channels: z.array(z.object({ id: z.string(), type: z.enum(['telegram', 'slack', 'teams']), credential: ref }).passthrough()).optional(),
    memory: z.object({ crossSession: z.boolean() }).optional(),
    guardrails: z.object({ input: guardrailRule.optional(), output: guardrailRule.optional(), toolResult: guardrailRule.optional() }).optional(),
    cache: z
      .object({
        enabled: z.boolean(),
        ttlSeconds: z.number().int().min(10).max(30 * 86_400),
        semantic: z.object({ enabled: z.boolean(), threshold: z.number().min(0.7).max(0.99), model: z.string().max(200), baseUrl: z.string().max(500).optional() }).optional(),
      })
      .optional(),
    access: z
      .object({
        rules: z
          .array(
            z.object({
              id: z.string().max(64),
              tool: z.string().min(1).max(200),
              who: z.object({ role: z.string().max(64).optional(), user: z.string().max(200).optional(), source: z.enum(['test', 'schedule', 'telegram', 'slack', 'teams', 'workflow', 'agent', 'api']).optional() }),
              effect: z.enum(['allow', 'ask', 'deny']),
            }),
          )
          .max(100),
      })
      .optional(),
    router: z
      .object({
        mode: z.enum(['fixed', 'auto']),
        cheapModel: z.object({ provider: z.enum(['anthropic', 'openai', 'ollama']), model: z.string(), credential: ref.optional(), baseUrl: z.string().optional(), temperature: z.number().min(0).max(2).optional() }).optional(),
        maxChars: z.number().int().min(20).max(20_000),
        allowTools: z.boolean(),
      })
      .optional(),
    plugins: z.array(z.string().max(200).regex(PLUGIN_ID, 'A plugin is <plugin>@<marketplace>')).max(20).optional(),
    settings: z
      .object({
        maxIterations: z.number().int().min(1).max(200),
        toolConcurrency: z.number().int().min(1).max(20),
        sessionTokenBudget: z.number().int().min(0),
        maxDelegationDepth: z.number().int().min(1).max(5),
        dailyTokenLimit: z.number().int().min(0),
        dailyCostLimit: z.number().min(0),
        monthlyCostLimit: z.number().min(0),
        approvalEmails: z.array(z.string().max(320)).max(20),
      })
      .partial()
      .optional(),
  })
  .passthrough();

/** The parsed body as a config (a cleared model arrives as null; a body without one leaves the model as it is). */
export function asConfig(body: z.infer<typeof agentConfigSchema>): Partial<AgentConfig> {
  const { model, ...rest } = body;
  return { ...(rest as Partial<AgentConfig>), ...(model !== undefined && { model: model ?? undefined }) };
}

/**
 * Stream a run's events as SSE `data:` lines. The run keeps going if the client goes away:
 * the session is saved either way and shows up under Sessions.
 */
export function agentEventStream(run: (onEvent: (event: AgentStreamEvent) => void) => Promise<unknown>): Response {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false;
        }
      };
      write(': connected\n\n');
      run((event) => write(`data: ${JSON.stringify(event)}\n\n`))
        .catch((error: Error) => {
          logger.error('agent run failed', { error });
          write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
        })
        .finally(() => {
          if (!open) return;
          open = false;
          try {
            controller.close();
          } catch {}
        });
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, { headers: sseHeaders });
}
