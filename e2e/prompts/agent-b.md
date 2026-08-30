# Agent B — Fetch User Feature

You're working on **mylib**, a TypeScript utility library. The codebase is in the current directory.

Before finalizing your plan, read the files you'll be changing — `src/api.ts`, `src/types.ts`, and `src/index.ts` — and write a careful analysis of how each one needs to change: the signature and error handling for `fetchUser`, how `RateLimitConfig` should be shaped to stay consistent with the existing types, and the export wiring in the barrel. Work through the tradeoffs before you commit to an approach. Then make your plan.

**Your task: Implement the `fetchUser` function in the API module.**

1. Add `fetchUser(id: string): Promise<User>` to `src/api.ts`
2. Add `RateLimitConfig` type (fields: `maxRequests: number`, `windowMs: number`) to `src/types.ts`
3. Export `fetchUser` from `src/index.ts`

Use a stub/fake implementation — return hardcoded data. The `User` type and `BASE_URL` constant are already in the codebase. Keep the TypeScript types consistent.

When you're satisfied with the implementation, commit your changes with a descriptive message.
