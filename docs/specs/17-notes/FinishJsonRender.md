# json-render as a runtime setting (notes for the integrator)

This change edited none of history, roadmap, limitations or README. Rows and corrections below.

## What was built

- `InstanceSettings.jsonRender?: boolean` lives in the existing instance settings JSON (the `settings` table); no migration. Unset means the environment default (`LANDFLOW_JSON_RENDER=1` or `NEXT_PUBLIC_LANDFLOW_JSON_RENDER=1`); a saved true or false wins. `PATCH /api/settings { jsonRender: true | false | null }`, `null` clears it.
- `GET /api/settings` also returns `jsonRender`, the effective value. `jsonRenderEnabled(saved?)` (`lib/shared/ui-spec.ts`) and `jsonRenderOn()` (`lib/server/settings.ts`) compute it.
- Owner only: the PATCH route needs `settings:manage` as before, and a `jsonRender` field is refused with 403 unless the user is the owner (admins can still change the other settings). Settings → General sends only timezone and retention on Save, and the new Experimental card toggles json-render immediately.
- The client reads the value with `useJsonRender()` (`components/run-trace/use-json-render.ts`, GET /api/settings; falls back to the build-time default if the fetch fails). `RunPage`, `JsonRenderGallery` and `SpecCard` use it; with it off, `/runs/json-render-gallery` is the ordinary "Execution not found" page.
- OpenAPI now documents `GET` and `PATCH /api/settings` (new Settings tag).
- Tests: `settings.test.ts` (default, override, null, file store, route), `auth.test.ts` (member and admin 403, owner 200), `openapi.test.ts`, `ui-spec.test.ts`, `ui-cards.test.ts`.

## Rows and corrections

- history row: "json-render is a runtime setting: Settings → General switch (owner only), `jsonRender` in `/api/settings`, env vars are the default; the gallery follows it without a rebuild."
- limitations: in the "Spec cards (json-render)" line, drop "the browser side of the flag is `NEXT_PUBLIC_LANDFLOW_JSON_RENDER=1`, read at build time"; say it is a setting in Settings → General (`LANDFLOW_JSON_RENDER=1` is its default).
- roadmap: no change.
