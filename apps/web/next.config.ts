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
  ],
  devIndicators: false,
  // Docker image (deploy/docker/host.Dockerfile): a self-contained server in .next/standalone.
  ...(process.env.LANDFLOW_NEXT_OUTPUT === 'standalone' && { output: 'standalone' as const }),
};

export default nextConfig;
