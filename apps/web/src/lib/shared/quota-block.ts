// The provider quota classifier lives in the protocol package (C08: the CLI's Codex watch needs it and must not import
// `apps/`); this re-export keeps every import of `@/lib/shared/quota-block` as it was.
export * from '@landflow/protocol/quota-block';
