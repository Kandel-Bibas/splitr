<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->


## Machine-checkable rules (jevlint)

This repo has no project standards document yet. When it gets one, it also gets a
`.jevlint.toml` at the root encoding the rules a model can check against a diff:
`~/homelab/jevlint/jevlint.sh check --target staged`.

Write those rules yourself, in-session. Do not delegate rule authoring to a cheap or
external model — the judgement is in the `NOT` clauses and the confidence floors, and a
small model produces rules that validate, read plausibly, and never fire. Keep the
rules in step with the prose in the same change that edits it.

Skip anything ESLint, `tsc`, or Prettier already catches exactly. A rule earns a model
call only when it must tell apart two things that look alike. New rules stay
`severity = "info"` until `jevlint calibrate` covers them with a clear positive and a
hard negative.

## Database

- `npm run test:db` runs the row-security tests against a local Supabase Postgres in Docker; one-time setup is in test/db/setup.ts. It is not part of `npm test`.
- The Homebrew Supabase CLI is killed by macOS at launch (invalid signature); use the supabase/postgres Docker image for local work.
