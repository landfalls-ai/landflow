# Notes for the integrator: P21 `sources` (C22)

## docs/limitations.md

- Add: knowledge sources are for agent knowledge bases; a project's knowledge has none (C22-D5).
- Add: a Google Drive source uses the person's own connected Google OAuth2 credential (no service accounts, no shared drives picker); Docs are read as Markdown, Sheets as CSV, Slides as text; shortcuts and forms are skipped and counted.
- Add: a site source reads plain HTTP pages only (no JavaScript rendering, no login), one host, depth 3, 500 pages, `robots.txt` obeyed; its links are kept so an unchanged page (304) still leads to the pages under it.
- Add: sources poll (hourly or daily); there are no webhooks or change notifications, and a sync reads at most 2,000 items (a longer source continues a minute later).
- Add: the S3 source uses the `S3` credential's explicit keys only, never the host's default AWS chain.

## docs/roadmap.md

- C22 built: knowledge sources (folder, S3, site, Google Drive) with schedules, Pause, Sync now and sync history; `s3Api` credential; migration 2929.

## docs/README.md

- No new page (sources are in `docs/agents.md`, Knowledge bases).

## docs/development.md

- Tests: `LANDFLOW_INTEGRATION=queue` runs `knowledge-sources.postgres.test.ts` (one claim of thirty wins across two processes); `LANDFLOW_INTEGRATION=aws` runs `knowledge-sources-localstack.test.ts` (S3 against LocalStack, which now starts the `s3` service in `deploy/compose.infra.yml`).
- Fakes: `@landflow/test-fakes/s3`, `/site` and `/drive`.

## Other

- Migration 2929 added (P26 takes 2928; it had not landed when this merged `combined/w4b`).
- `deploy/compose.infra.yml` (outside P21's files): LocalStack `SERVICES` gained `s3`.
- `docs/reference/configuration.md` gains `LANDFLOW_KNOWLEDGE_DRIVE_URL` (a test seam for the Drive API address, ignored in production); regenerate with `pnpm --filter @landflow/web gen:config-docs`.
- Migration 2929 has an `extra` column on `knowledge_source_items` (the links of a crawled page).
