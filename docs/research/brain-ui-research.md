# How other products show a company brain

Researched 2026-11-12 for the [Brain page](../second-brain.md#the-brain-page). Part of the [Landflow docs](../README.md).
The question: how do products that learn from a company's tools (or an LLM-kept wiki) show what they know, and what
should Landflow's page take from them? This is a summary of public product pages and docs, not a hands-on test of each.

## What they do

- **Enterprise search and assistants** (Glean, Guru, Notion AI, Dashworks, Atlassian Rovo): one Ask box first; answers
  carry their sources as numbered citations or source cards. Glean and Rovo add people and topic cards next to results.
- **Auto-written topic pages** (Microsoft Viva Topics): pages made from mined documents with people and resources, kept by
  "topic curators". Microsoft retired Viva Topics in February 2025; a wiki the machine writes alone, without owners,
  did not hold up.
- **Verified knowledge** (Guru): every card has an owner and a verification interval; stale or conflicting cards go to a
  person to review rather than being fixed silently.
- **People and expertise** (Glean, Dashworks, Viva): a person page lists what they worked on and with whom, derived from
  activity, not from a profile they fill in.
- **LLM-kept wikis** (Karpathy's "LLM wiki" idea and the tools around it): the model writes and links pages from raw
  sources, a lint pass finds orphans and stale pages, and a good answer is filed back as a page.
- **Graphs**: Obsidian- and Roam-style global graphs look good and are rarely used to find anything; the useful part is
  "related pages" and backlinks on each page.
- **Overlap across teams**: none of the shipped products flags two teams doing the same work; the nearest is Guru's
  duplicate and conflict review. This is the gap the Company Brain is for.

## What the Brain page took

| Pattern | On the Brain page |
|---|---|
| Ask first, answers with sources | One Ask box on top (and on each page, about that page); `[n]` references to the work it used, page links in the text |
| AI text marked as AI | "Written by the brain (model) · when", **Regenerate**, and **new work since** when it is behind |
| People keep the facts | Name, what it is and owner are edited by people, apart from the summary; facts people add are never staled |
| Owners and review (Guru) | **Needs a person**: no owner, quiet for 30 days, summary behind its work |
| Infobox | Chips for owner, teams, sources and last work under the title |
| Related pages and backlinks, no global graph | **Related pages** (shared work, with counts) and **Mentioned in** |
| A briefing, not a dashboard | The home leads with **Shared across teams**, then suggestions and teams |
| Phone first | One column of cards everywhere |

Not taken yet: filing a good answer back as a fact or page, and a detector that turns shared work into a suggestion
addressed to both teams ([roadmap.md](../roadmap.md#the-brain-page-built-2026-11-12)).
