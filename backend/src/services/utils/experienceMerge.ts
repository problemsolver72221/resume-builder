/**
 * Reattaches tailored roles to the candidate profile they came from.
 *
 * The tailoring prompt asks the model for an `index` into the profile's experience array
 * plus only the prose it actually writes. Employer, title, dates and location are read back
 * from the profile here, which keeps them out of the model's output budget — they are the
 * most expensive tokens in the call — and, more importantly, out of its reach: a drifting
 * company name or a shifted date can no longer reach a generated document.
 */
import type { Profile } from '../../types/profile';
import type { TailoredExperience, TailoredExperienceReply } from '../../types/template';

/** The parts of a role that are facts rather than prose, so the model never authors them. */
export type RoleIdentity = Pick<TailoredExperience, 'title' | 'company' | 'startDate' | 'endDate' | 'location'>;

export function toRoleIdentity(source: Partial<RoleIdentity>): RoleIdentity {
  return {
    title: source.title ?? '',
    company: source.company ?? '',
    startDate: source.startDate ?? '',
    endDate: source.endDate ?? '',
    location: source.location ?? '',
  };
}

/**
 * Finds the profile role a reply entry refers to. `index` is what the prompt asks for;
 * company name catches replies in the older shape that still echo it, and position is the
 * last resort. Returns -1 when every candidate is already claimed by an earlier entry, so a
 * duplicated index cannot silently overwrite another role.
 */
function matchProfileRole(
  item: TailoredExperienceReply,
  position: number,
  roles: ReadonlyArray<Partial<RoleIdentity>>,
  claimed: ReadonlySet<number>
): number {
  const available = (index: number): boolean => index >= 0 && index < roles.length && !claimed.has(index);

  if (typeof item.index === 'number' && Number.isInteger(item.index) && available(item.index)) {
    return item.index;
  }

  const company = item.company?.trim().toLowerCase();
  if (company) {
    const byCompany = roles.findIndex(
      (role, index) => available(index) && role.company?.trim().toLowerCase() === company
    );
    if (byCompany >= 0) return byCompany;
  }

  return available(position) ? position : -1;
}

/**
 * Merges each reply entry with its profile role. Roles the model left out stay out —
 * trimming to the page budget is its job — and entries that match nothing keep whatever
 * they carried, so a hand-edited or legacy payload still renders.
 */
export function mergeRoleIdentities(
  items: readonly TailoredExperienceReply[],
  profile?: Profile
): Array<TailoredExperienceReply & RoleIdentity> {
  const roles = profile?.experience ?? [];
  if (roles.length === 0) {
    // Nothing authoritative to merge against; keep whatever the reply carried.
    return items.map((item) => ({ ...item, ...toRoleIdentity(item) }));
  }

  const claimed = new Set<number>();
  const resolved = items.map((item, position) => {
    const roleIndex = matchProfileRole(item, position, roles, claimed);
    if (roleIndex >= 0) claimed.add(roleIndex);
    return { item, roleIndex, position };
  });

  // Profile order is the resume's order — index 0 is the most recent role, which is what the
  // prompt's bullet-count and metric rules are written against. Unmatched entries trail
  // behind in the order the model sent them.
  const sortKey = (entry: (typeof resolved)[number]): number =>
    entry.roleIndex >= 0 ? entry.roleIndex : roles.length + entry.position;

  return resolved
    .slice()
    .sort((a, b) => sortKey(a) - sortKey(b))
    .map(({ item, roleIndex }) => ({
      ...item,
      ...toRoleIdentity(roleIndex >= 0 ? roles[roleIndex] : item),
    }));
}
