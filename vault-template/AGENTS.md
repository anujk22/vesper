# How this vault works

This is a Vesper knowledge vault: plain Markdown that Obsidian (or any editor) can open. It belongs to its owner. Vesper and any agent that reads it must keep it readable, honest and small.

## Layout

| Folder | What belongs here |
| --- | --- |
| `Profile/` | Who the owner is: background, preferences, communication style, tools, goals. |
| `Projects/` | One note per project: purpose, current objective, decisions, open issues, a `## Log`. `path:` links the repo. |
| `Decisions/` | Things actually chosen, by whom, when and why. A suggestion is not a decision. |
| `Ideas/` | Exploratory thoughts. Not commitments. |
| `Learning/` | Courses, source material pointers, misconceptions corrected. |
| `Career/` | Evidence-backed accomplishments and active applications. |
| `Sessions/` | One note per working session: what happened, verified, unresolved, next step. |
| `Outputs/` | Deliverables: PRDs, reviews, briefs, agent run records. An output is not evidence for its own claims. |
| `Sources/` | Pointers to (or copies of) original material that knowledge was derived from. |
| `Skills/` | Reusable workflows: when to use, inputs, output, what needs review. |
| `Inbox/` | Captured facts awaiting review. |

## Properties

Every note may carry frontmatter:

- `status`: `known` (confirmed), `needs-review` (user-reported or inferred, unconfirmed), `exploratory` (ideas), `historical` (was true, may not be now), `superseded`.
- `source`: where it came from. Keep a path back to real evidence. Never cite another generated summary as the only source.
- `learned` / `updated`: when Vesper learned it vs when it was last checked. When something happened is written in the body.
- `share: local-only`: never send this note to a cloud model or agent.
- `project`: a `[[link]]` to the project note.

## Rules for agents

1. Do not rewrite the owner's notes in your own voice or delete history. Append, or mark as `superseded`.
2. Separate observed, reported, inferred and unknown.
3. Prefer updating an existing note over creating a duplicate.
4. No em dashes.
5. Every change to this vault is committed to its local git history so it can be reviewed and undone.
