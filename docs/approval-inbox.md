# The approval inbox

Part of the [Landflow docs](README.md). Wave ap1: a run nobody watches that reaches a tool that asks first waits for a person in
**Needs you** instead of refusing. This page's record, claim, routes, nudges and expiry sections belong to the wave's first
package; the section below is the approver's screens.

## What you see

Shots are from a development host with made-up requests (the routes answered from fixtures; the server half was not on this
branch), at 1440 by 900 and 390 by 844.

- **Home, one and three requests.** *Waiting for your approval · 3* under the four tiles: each row is the tool, *Alert mailer v2 · Alert intake v4*, where it goes, *Waiting for your approval since 06:36 · expires 06:46*, then **Approve**, **Deny** and **Details**. Nothing shows when no request waits.
- **Details.** The parameters it would run with as a two-column list (`smtpPassword` reads `••••••`), where it goes, *Started by a webhook run*, the agent, the workflow, **Open the run**, since and expires, and the same two buttons. A side-by-side dialog on a desk, a bottom sheet on a phone.
- **After Approve.** The row reads *Approved by Owner in Needs you · 06:40* for four seconds, then leaves.
- **A lost race.** The row reads *Already approved by Owner at 14:05.* (the server's 409 words) and leaves on the next refresh.
- **`?approval=<id>`.** Opens that request's Details; a request that ended shows how it ended.
- **The Runs page.** The same rows in **Needs you**, next to the old link rows for waits that are not inbox requests.
- **The Run Trace card.** *Waiting for your approval since … · expires …*, the versions and the destination, **Approve: Send Email** and **Deny**, no **Edit**.
- **The publish card and the Publish menu.** A clock line for a step that will wait, the shield line for one that still refuses.
- **The agent page's session.** *Waiting in Needs you · Open it* under the waiting call, no **Approve** or **Deny**.

There is no *Approve all*, no select-many and no keyboard shortcut that approves.
