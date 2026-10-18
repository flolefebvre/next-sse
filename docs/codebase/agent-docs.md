# Agent-facing docs

How `AGENTS.md` and `docs/codebase/` evolve. `AGENTS.md` is loaded into every conversation; these files are read at the moment of need. The docs Apps read (the package manual, `skills/next-sse/`, the `context7.json` rules) are a different audience and are not governed here.

- `AGENTS.md` carries only what an agent must never miss — hard rules, the layout, the commands — plus one pointer per topic. Everything else lives in `docs/codebase/`, one file per area.
- Link each conventions file from the `AGENTS.md` section it governs, not from the Documentation section — that section is external reference only. Adjacency is what makes a pointer fire at the right moment.
- Never state a thing in both places; the pointer is the copy. Keep `AGENTS.md` short — adherence degrades with length.
- Format follows content: static topology as a tree, rules as bullets — one imperative sentence per rule. The layout tree lists folders only; a file earns its pointer from the section it serves, never a tree entry.
- A rule must carry its own trigger and test ("promote when the second use appears"), not just a label; an agent should be able to tell, mid-change, that it is about to break it.
- Only record decisions this repo has actually made or exercised; never invent a convention ahead of its first use — leave the gap until a real change forces the decision.
- Include whatever saves a round trip: exact commands, file paths, library IDs — anything the reader would otherwise have to resolve first.
- The doc carries the rule; the reasoning behind it goes to an ADR in `docs/adr/`, or to the GitHub issue the rule can be traced to.
