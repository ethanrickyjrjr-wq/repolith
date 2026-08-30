# Agent A — Login Feature

You're working on **mylib**, a TypeScript utility library. The codebase is in the current directory.

Before finalizing your plan, read the files you'll be changing — `src/auth.ts`, `src/types.ts`, and `src/index.ts` — and write a careful analysis of how each one needs to change: the signature and error handling for `login`, how `LoginResult` should be shaped to stay consistent with the existing `User` type, and the export wiring in the barrel. Work through the tradeoffs before you commit to an approach. Then make your plan.

**Your task: Implement the `login` function in the auth module.**

1. Add `login(email: string, password: string): Promise<LoginResult>` to `src/auth.ts`
2. Define `LoginResult` (fields: `token: string`, `user: User`) in `src/types.ts`
3. Export `login` from `src/index.ts`

Use a stub/fake implementation — return hardcoded data, no real HTTP calls needed. The `User` type already exists in `src/types.ts`. Keep the TypeScript types consistent.

When you're satisfied with the implementation, commit your changes with a descriptive message.
