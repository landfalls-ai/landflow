export function timeAgo(iso?: string): string {
  if (!iso) return '—';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function duration(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const LANGUAGE_META: Record<string, { label: string; color: string; short: string }> = {
  typescript: { label: 'TypeScript', color: 'var(--viz-1)', short: 'TS' },
  python: { label: 'Python', color: 'var(--viz-4)', short: 'PY' },
  go: { label: 'Go', color: 'var(--viz-3)', short: 'GO' },
};

export function languageMeta(language: string) {
  return LANGUAGE_META[language] ?? { label: language, color: 'var(--t3)', short: language.slice(0, 2).toUpperCase() };
}

export const TRANSPORT_META: Record<string, { label: string }> = {
  'in-process': { label: 'in-process' },
  http: { label: 'HTTP' },
  grpc: { label: 'gRPC' },
  kafka: { label: 'Kafka' },
  amqp: { label: 'RabbitMQ' },
  nats: { label: 'NATS' },
  jetstream: { label: 'JetStream' },
  valkey: { label: 'Valkey' },
  mqtt: { label: 'MQTT' },
  sqs: { label: 'SQS' },
  pubsub: { label: 'Pub/Sub' },
  servicebus: { label: 'Service Bus' },
  amqp1: { label: 'AMQP 1.0' },
  pulsar: { label: 'Pulsar' },
};

/** Label of any transport kind: the known ones from TRANSPORT_META, an unknown kind as is (the engine's Transport is open). */
export function transportLabel(transport: string): string {
  return TRANSPORT_META[transport]?.label ?? transport;
}
