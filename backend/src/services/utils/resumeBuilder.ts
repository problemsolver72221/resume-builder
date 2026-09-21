function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `shorter` appears inside `longer` as whole words, case-insensitively. */
function containsAsWords(longer: string, shorter: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(shorter)}(?=$|[^A-Za-z0-9])`, 'i').test(longer);
}

/**
 * Drops skills that another skill already contains as complete words — "microservices"
 * next to "microservices architecture", "AWS" next to "AWS Lambda" — since any keyword
 * scan for the shorter term matches the longer one anyway.
 *
 * Containment has to be word-level. Plain substring matching threw away "SQL" because of
 * "PostgreSQL", "Go" because of "MongoDB", and "Java" because of "JavaScript", none of
 * which a keyword scan would treat as the same term.
 */
export function removeDuplicateSubstrings(skills: string[]): string[] {
  return skills.filter(
    (skill) =>
      !skills.some(
        (other) => other !== skill && other.length > skill.length && containsAsWords(other, skill)
      )
  );
}
