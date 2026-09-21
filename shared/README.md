# shared/

The contract between `backend/` and `frontend/`, declared once.

Every type in here is **declaration-only** (`.d.ts`, no runtime values). That is what lets
one folder serve both halves without a build step, a workspace or a new dependency:

- the backend compiles as CommonJS with `rootDir: "./src"`, and a `.ts` file outside that
  root would fail to emit — but a `.d.ts` is never emitted, so it is exempt;
- the frontend compiles as ESM through Next, which never sees these files at all, because
  types are erased before a bundler runs.

Both `tsconfig.json`s map `@shared/*` to this folder. Import with `import type`:

```ts
import type { Profile, JobAnalysis } from '@shared/types/profile';
```

## Rules

1. **Types only.** No `const`, no `enum` with values, no functions. A `.d.ts` cannot carry
   runtime code, and the moment something here needs a value it belongs in one half or the
   other — or in a real shared package, which is a bigger change than this folder is.
2. **The backend is the source of truth for anything persisted.** These shapes describe
   what is written to `backend/data/`, so they follow the writer, not the reader.
3. **Neither half re-declares a shared shape.** `backend/src/types/*.ts` and
   `frontend/src/lib/api.ts` re-export from here so existing import paths keep working;
   they do not define their own copies. Two hand-maintained copies is what this folder
   exists to end — `Certification` and `Education` had already drifted apart before it did.
4. **Where the two halves genuinely differ, share a base and extend locally.**
   `TailoredContentBase` is the common shape; the backend adds the cover-letter style it
   types against a runtime module, which the frontend has no use for.
