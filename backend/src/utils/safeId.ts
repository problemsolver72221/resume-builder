const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ID_LENGTH = 200;

/**
 * Guards an id that is about to be joined onto a data-directory path.
 *
 * Ids in this app are opaque — UUIDs, slugs, and template paths such as "m/one-column-clean" —
 * so the rule is simply: one or (when allowed) two plain segments, each starting with a
 * letter or digit. That excludes ".", "..", backslashes, and anything URL-decoded from
 * "%2f", which is all a request needs to read or delete files outside the intended folder.
 */
export function isSafeId(value: unknown, options: { allowSlash?: boolean } = {}): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    return false;
  }
  const segments = value.split('/');
  if (segments.length > (options.allowSlash ? 2 : 1)) {
    return false;
  }
  return segments.every((segment) => SEGMENT_PATTERN.test(segment));
}
