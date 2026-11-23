/**
 * A System One server (docs/features/ai.md#decide): a decision model's `POST /v1/systemone`, the model list Ollama keeps
 * at `GET /api/tags`, and `GET /v1/models`. It follows the real server's rules (1 to 64 questions, a Choice has 2 to 26
 * options, a Score 2 to 26 levels, an unknown model is Ollama's 404) and answers by keywords so a test can say what it
 * expects: a Choice favours the option whose name or description words appear in the state, a Yes/No answers high when
 * the state holds a `yes` keyword, a Score is its top level when the state holds a `high` keyword, else its lowest. Not a model: the numbers are plausible, not true.
 * Ollama needs no key; set `key` in the seed and the fake wants it as a Bearer token, like TypeSafe.
 */
import { defineFake, type FakeReply, type FakeRequest } from './harness';

export interface SystemOneSeed {
  /** Models the server holds (what `/api/tags` lists). */
  models?: string[];
  /** When set, every request needs `Authorization: Bearer <key>`. */
  key?: string;
  /** Answer as an Ollama older than 0.40 does: the endpoint is a plain-text 404. */
  oldServer?: boolean;
  /** Yes/No answers high when the state holds one of these (case-insensitive). */
  yes?: string[];
  /** A Score is at its top level when the state holds one of these, else at its lowest. */
  high?: string[];
}

export interface SystemOneState extends Required<Omit<SystemOneSeed, 'key'>> {
  key: string;
  /** The bodies the endpoint was asked, in order. */
  asked: unknown[];
}

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
const round = (n: number) => Math.round(n * 1e4) / 1e4;

function distribution(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => round(w / total));
}

const concentration = (p: number[]) => round(Math.max(...p) - 1 / p.length) / (1 - 1 / p.length);

type Question = { type?: string; instructions?: string; criteria?: unknown };

function answerOne(state: SystemOneState, text: string, q: Question): { reply?: FakeReply; answer?: Record<string, unknown> } {
  const lower = text.toLowerCase();
  const bad = (detail: string) => ({ reply: { status: 422, body: { detail } } });
  if (q.type === 'noul') {
    const hit = state.yes.some((k) => lower.includes(k.toLowerCase()));
    return { answer: { type: 'noul', noul: hit ? 0.93 : 0.07 } };
  }
  if (q.type === 'choice') {
    const criteria = q.criteria;
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) return bad('a choice question needs criteria: an object of option to description');
    const options = Object.entries(criteria as Record<string, string | null>);
    if (options.length < 2 || options.length > 26) return bad('a choice question takes 2 to 26 options');
    const tokens = new Set(words(text));
    const weights = options.map(([name, description]) => {
      const own = [...words(name), ...words(description ?? '')];
      return 0.05 + own.filter((w) => tokens.has(w)).length;
    });
    // Nothing in the text matches any option: the last one wins, as an "other" does.
    if (weights.every((w) => w === weights[0])) weights[weights.length - 1] += 0.5;
    const p = distribution(weights);
    const probabilities = Object.fromEntries(options.map(([name], i) => [name, p[i]]));
    return { answer: { type: 'choice', choice: options[p.indexOf(Math.max(...p))][0], probabilities, confidence: concentration(p) } };
  }
  if (q.type === 'score') {
    const levels = q.criteria;
    if (!Array.isArray(levels) || levels.length < 2 || levels.length > 26) return bad('a score question takes 2 to 26 levels');
    const hits = state.high.filter((k) => lower.includes(k.toLowerCase())).length;
    const top = hits ? levels.length - 1 : 0;
    const weights = levels.map((_l, i) => 0.05 + (i === top ? 1 : i === top - 1 || i === top + 1 ? 0.2 : 0));
    const p = distribution(weights);
    return {
      answer: {
        type: 'score',
        score: round(p.reduce((sum, v, i) => sum + v * i, 0)),
        legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
        probabilities: Object.fromEntries(p.map((v, i) => [String(i), v])),
        confidence: concentration(p),
      },
    };
  }
  return bad(`unknown question type "${String(q.type)}"`);
}

function routes(state: SystemOneState, request: FakeRequest): FakeReply {
  if (state.key && request.headers.authorization !== `Bearer ${state.key}`) return { status: 401, body: { detail: 'bad key' } };
  if (request.method === 'GET' && request.path === '/api/tags') return { body: { models: state.models.map((name) => ({ name, details: { parameter_size: '9B' }, capabilities: ['completion'] })) } };
  if (request.method === 'GET' && request.path === '/v1/models') return { body: { models: state.models.map((name) => ({ name })) } };
  if (request.method !== 'POST' || request.path !== '/v1/systemone') return { status: 404, body: 'Not Found' };
  if (state.oldServer) return { status: 404, body: '404 page not found' };
  const body = request.body as { model?: string; state?: unknown; questions?: Record<string, Question> } | undefined;
  state.asked.push(body);
  if (!body || typeof body.state !== 'string' && (body.state === null || typeof body.state !== 'object')) return { status: 422, body: { detail: 'state is required' } };
  const asked = Object.entries(body.questions ?? {});
  if (!asked.length || asked.length > 64) return { status: 422, body: { detail: 'a request takes 1 to 64 questions' } };
  if (body.model && !state.models.includes(body.model) && !state.models.some((m) => m.split(':')[0] === body.model && !body.model?.includes(':'))) {
    return { status: 404, body: { error: `model '${body.model}' not found` } };
  }
  const text = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
  const answers: Record<string, unknown> = {};
  for (const [name, question] of asked) {
    const one = answerOne(state, text, question);
    if (one.reply) return one.reply;
    answers[name] = one.answer;
  }
  return { body: { model: body.model ?? state.models[0], answers, usage: { input_tokens: Math.ceil(text.length / 4) + 40, output_tokens: asked.length * 3 } } };
}

export function fakeSystemOne(seed: SystemOneSeed = {}) {
  return defineFake<SystemOneState>({
    name: 'systemone',
    token: seed.key ?? 'none',
    // The route checks the key itself so one fake can be Ollama (no key) or TypeSafe (a key).
    auth: () => true,
    scriptBody: (script) => ({ detail: `scripted ${script.status}` }),
    initial: () => ({ models: seed.models ?? ['nimble:9b'], key: seed.key ?? '', oldServer: seed.oldServer ?? false, yes: seed.yes ?? ['urgent'], high: seed.high ?? ['angry', 'furious'], asked: [] }),
    routes,
  });
}
