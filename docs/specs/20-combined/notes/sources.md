# Notes for the integrator: P21 `sources` (C22)

## docs/limitations.md

- Add: knowledge sources are for agent knowledge bases; a project's knowledge has none (C22-D5).
- Add: a Google Drive source uses the person's own connected Google OAuth2 credential (no service accounts, no shared drives picker); Docs are read as Markdown, Sheets as CSV, Slides as text; shortcuts and forms are skipped and counted.
- Add: a site source reads plain HTTP pages only (no JavaScript rendering, no login), one host, depth 3, 500 pages, `robots.txt` obeyed; its links are kept so an unchanged page (304) still leads to the pages under it.
- Add: sources poll (hourly or daily); there are no webhooks or change notifications, and a sync reads at most 2,000 items (a longer source continues a minute later).
- Add: the S3 source uses the `S3` credential's explicit keys only, never the host's default AWS chain.

- Add: the S3 source's connections go through the outbound policy at the socket (every host the SDK derives, virtual-hosted bucket names too); with private addresses blocked, a name that does not resolve is refused. Other S3 uses (audit anchoring, binary storage, secrets) are configured infrastructure and still not covered by it.
- Add: a source reads a page up to 2 MB, robots.txt up to 512 KB, a file up to 25 MB, all counted after decompression; one crawl keeps at most about 100 MB of changed pages in memory, the rest waits for the next sync and the listing is marked not whole.
- Add: the credential is checked again at every sync; one that was deleted, changed type or is no longer usable by the agent's project fails the run and pauses the source.
- Add: the duplicate-place check is in the process, not a unique index (Postgres mode replays writes); two hosts adding the same place at once can leave two sources doing the same sync.

## docs/roadmap.md

- C22 built: knowledge sources (folder, S3, site, Google Drive) with schedules, Pause, Sync now and sync history; `s3Api` credential; migration 2929.

## docs/README.md

- No new page (sources are in `docs/agents.md`, Knowledge bases).

## docs/development.md

- Tests: `LANDFLOW_INTEGRATION=queue` runs `knowledge-sources.postgres.test.ts` (one claim of thirty wins across two processes); `LANDFLOW_INTEGRATION=aws` runs `knowledge-sources-localstack.test.ts` (S3 against LocalStack, which now starts the `s3` service in `deploy/compose.infra.yml`).
- Fakes: `@landflow/test-fakes/s3`, `/site` and `/drive`.

## Other

- Migration 2929 sits after P26's 2928 (merged in). Its index on (collection, kind, location) is not unique, on purpose.
- `deploy/compose.infra.yml` (outside P21's files): LocalStack `SERVICES` gained `s3`.
- `docs/reference/configuration.md` gains `LANDFLOW_KNOWLEDGE_DRIVE_URL` (a test seam for the Drive API address, ignored in production); regenerate with `pnpm --filter @landflow/web gen:config-docs`.
- Migration 2929 has an `extra` column on `knowledge_source_items` (the links of a crawled page).
