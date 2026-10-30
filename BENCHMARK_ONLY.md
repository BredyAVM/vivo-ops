# Isolated Master refresh CPU comparison

This branch is a temporary benchmark and must never be promoted or merged into production.
It compares full Next.js RSC refresh responses from the real pre-change Master loader/client
(d868491bd0e44b58608f9463069b0e44f261ed3d) and optimized code
(46a892fe3ecd16c99d9a09f78a105bcb3c1585a7), including the old inventory Server Action.

Supabase responses are supplied by a strict in-memory fixture with anonymized shapes and
synthetic financial states. No environment files are included. 324 exported business
actions throw, push functions throw, and all unexpected database operations throw.
The only working Server Action is the old inventory summary read against this fixture.

Routes: /app/before and /app/after. Both versions use the same fixture and SDK versions.
The benchmark runner consumes the complete Flight response, not initial HTML SSR.
The before cycle includes the extra inventory action. Cold loads are separate.

This is a controlled workload, not a claim of production savings across every user or day.
Local CPU measurements are not Vercel billed CPU; platform measurements must be labeled separately.
