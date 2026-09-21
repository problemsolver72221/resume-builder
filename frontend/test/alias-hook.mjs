/**
 * Teaches `node --test` the module resolution the bundler does for us.
 *
 * The model under test imports the way the rest of the app does — `@/lib/retry`, and
 * relative specifiers without a file extension — because those are TypeScript and bundler
 * conventions, not Node ones. Rather than write `../../../lib/retry.ts` through the source
 * to keep Node happy, the harness resolves the same two rules Next and tsc already apply:
 *
 *   - `@/x`       -> frontend/src/x
 *   - `@shared/x` -> shared/x   (type-only in practice, so usually erased before this runs)
 *   - extensionless relative paths -> the .ts / .tsx / index.ts that actually exists
 *
 * Node strips the types itself, so there is no compiler and no dependency in the loop.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(testDir, '..');
const repoRoot = path.resolve(frontendRoot, '..');

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.js', '/index.ts', '/index.tsx'];

/** The first suffix that names a real file, or null when the path is already resolvable. */
function resolveOnDisk(absolutePath) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${absolutePath}${suffix}`;
    if (existsSync(candidate) && !candidate.endsWith(path.sep)) {
      return candidate;
    }
  }
  return null;
}

function aliasTarget(specifier) {
  if (specifier.startsWith('@/')) {
    return path.join(frontendRoot, 'src', specifier.slice('@/'.length));
  }
  if (specifier.startsWith('@shared/')) {
    return path.join(repoRoot, 'shared', specifier.slice('@shared/'.length));
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const aliased = aliasTarget(specifier);
    if (aliased) {
      const resolved = resolveOnDisk(aliased);
      if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }

    // An extensionless relative import, which Node alone would reject.
    if (specifier.startsWith('.') && !path.extname(specifier) && context.parentURL) {
      const fromDir = path.dirname(fileURLToPath(context.parentURL));
      const resolved = resolveOnDisk(path.resolve(fromDir, specifier));
      if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
});
