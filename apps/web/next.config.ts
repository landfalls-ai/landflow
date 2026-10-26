import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@landflow/protocol', '@landflow/sdk', '@landflow/engine'],
  // Native-ish / dynamic-require packages must stay out of the server bundle.
  // OpenTelemetry stays external too: one copy of the SDK per process, shared by instrumentation and routes.
  serverExternalPackages: [
    '@grpc/grpc-js',
    '@grpc/proto-loader',
    'protobufjs',
    '@opentelemetry/api',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/core',
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-prometheus',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/sdk-trace',
    // Binary data: pdf.js (PDF text) loads its worker code dynamically; the S3 client is only loaded when configured.
    'unpdf',
    '@aws-sdk/client-s3',
    // Email Trigger (IMAP): socket clients with lazily required codecs.
    'imapflow',
    'mailparser',
    // Kubernetes plugin discovery (LANDFLOW_PLUGIN_DISCOVERY=kubernetes), loaded only when it is on.
    '@kubernetes/client-node',
    // Broker clients with native addons (@landflow/transports drivers load them on connect): node-pre-gyp can't be bundled,
    // and a bundled librdkafka binding looks for its .node file under .next ("Could not locate the bindings file").
    '@confluentinc/kafka-javascript',
    'pulsar-client',
    // Tier 2 cloud clients (@landflow/transports sqs and pubsub drivers, loaded on connect): google-gax reads protos from disk over @grpc/grpc-js;
    // the SQS client is kept external like the S3 one.
    '@aws-sdk/client-sqs',
    '@google-cloud/pubsub',
  ],
  devIndicators: false,
  // Docker image (deploy/docker/host.Dockerfile): a self-contained server in .next/standalone.
  ...(process.env.LANDFLOW_NEXT_OUTPUT === 'standalone' && { output: 'standalone' as const }),
};

export default nextConfig;
