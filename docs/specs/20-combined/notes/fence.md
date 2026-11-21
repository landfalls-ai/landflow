# Notes for the integrator: P2 `fence` (C03)

- `docs/team-notebook.md`: The notebook block at the start of a team run, and what `note_search` returns, sit inside one `<landflow-memory source="team-notebook">` fence; a note's text is escaped whole, and a note from outside still says "from outside: unchecked" on its line.
- `docs/second-brain.md`: The facts in the Ask prompt and in a page's summary prompt are fenced as `<landflow-memory source="brain-facts">`, whoever wrote them (people, Notion pulls, the study).
- `docs/limitations.md`: The memory fence marks recalled text as data; it does not detect or judge prompt injection, and knowledge-base passages and web results are not fenced by it yet.
- `docs/roadmap.md`: C03 (delimiter escaping for recalled memory): built.
