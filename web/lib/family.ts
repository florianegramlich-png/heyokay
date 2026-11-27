/**
 * Family sharing in the phone app and on the web (PRD 6.1 #8). The same file is in
 * app/src/lib/family.ts and web/lib/family.ts (a test checks), and it has no imports, so both
 * sides test it with node --test. The rules live on the server (server/src/family.ts); this only
 * mirrors what the screens need: code typing, error messages, and who may do what.
 *
 * Protecting places, never tracking people: a family sees names and the labels of shared places,
 * never anyone's location.
 */

export const FAMILY_MAX = 6;
export const FAMILY_NAME_MAX = 30;

export interface FamilyMember { id: string; name: string; you: boolean; admin: boolean; joinedAt: string }
/** A place someone in the family shares: label and whose (a member id). Never coordinates. */
export interface FamilyPlace { id: string; label: string; memberId: string }
export interface Family { members: FamilyMember[]; places: FamilyPlace[]; admin: boolean; max: number }
export interface FamilyInvite { code: string; expiresAt: string }

/** Same alphabet as the server: no 0/O or 1/I, so codes are easy to read out. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** The code as the server wants it (8 symbols), or null while it can't be one. */
export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  return s.length === 8 && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

/**
 * What the code field shows while someone types: upper case, a dash after four, at most 9
 * characters. Anything that can't be in a code (0, 1, I, O, spaces, other dashes) is dropped.
 */
export function formatCode(input: string): string {
  const s = [...input.toUpperCase()].filter((c) => ALPHABET.includes(c)).join('').slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export const validName = (name: string) => name.trim().length >= 1 && name.trim().length <= FAMILY_NAME_MAX;

export type FamilyErrorKey = 'fam.err.code' | 'fam.err.full' | 'fam.err.already' | 'fam.err.name' | 'fam.err.generic';

/** Server error (status + `error` code) → the message to show. */
export function familyErrorKey(status: number, message: string): FamilyErrorKey {
  if (message === 'invalid_code') return 'fam.err.code';
  if (message === 'family_full') return 'fam.err.full';
  if (message === 'already_in_family') return 'fam.err.already';
  if (status === 400) return 'fam.err.name';
  return 'fam.err.generic';
}

/** Only the admin invites, and only while there is room. */
export const canInvite = (f: Family) => f.admin && f.members.length < f.max;
/** The admin takes others out; nobody removes themselves (they leave). */
export const canRemove = (f: Family, m: FamilyMember) => f.admin && !m.you;

/** The places the others share, with whose they are, by label. Your own show under "Saved places". */
export function othersPlaces(f: Family): Array<{ id: string; label: string; by: string }> {
  const names = new Map(f.members.map((m) => [m.id, m]));
  return f.places
    .filter((p) => names.has(p.memberId) && !names.get(p.memberId)!.you)
    .map((p) => ({ id: p.id, label: p.label, by: names.get(p.memberId)!.name }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.by.localeCompare(b.by));
}

/** The date an invite is valid until, short and local ("4. Dez." / "Dec 4"). */
export function inviteDate(inv: FamilyInvite, locale: string): string {
  return new Date(inv.expiresAt).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}
