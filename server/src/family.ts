import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FamilyMember, Store } from './store.js';
import type { SavedPlace } from './types.js';

/**
 * Family sharing (PRD 6.1 #8, 3.3 #4): family groups with invite codes, and shared places.
 * Protecting places, never tracking people: a family only knows who is in it (a name each person
 * picks) and the labels of the places its members chose to share. Everyone gets alerts for those
 * places like for their own. Nobody's current location is ever shared, and no coordinates leave
 * the server for anyone but the place's owner.
 *
 * - One family per person, up to FAMILY_MAX people.
 * - The admin is whoever has been in the family longest (no stored role, so a family is never left
 *   without one when someone leaves or deletes their data). Only the admin invites or removes.
 * - One invite code per family at a time, single use, FAMILY_INVITE_DAYS valid, stored as a hash.
 * - A family ends when its last person leaves.
 * - Sharing starts fresh with every family: starting, joining or leaving one (or being taken out)
 *   stops sharing all of that person's places, so nothing is shared with people they didn't pick.
 */
export const FAMILY_MAX = 6;
export const FAMILY_INVITE_DAYS = 7;

/** No 0/O or 1/I: easy to read out over the phone. 32 symbols, so one byte & 31 is unbiased. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** "K7QD-M2XR": 8 symbols (40 bits). */
export function makeInviteCode(random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  const s = Array.from(random(8), (b) => CODE_ALPHABET[b & 31]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** What people type: any case, spaces or dashes. Null when it can't be a code. */
export function normalizeInviteCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  return s.length === 8 && [...s].every((c) => CODE_ALPHABET.includes(c)) ? s : null;
}

export const inviteCodeHash = (normalized: string) => createHash('sha256').update(`family-invite:${normalized}`).digest('hex');

export type FamilyErrorCode = 'not_in_family' | 'already_in_family' | 'not_admin' | 'invalid_code' | 'family_full' | 'not_found' | 'cannot_remove_self';

export class FamilyError extends Error {
  constructor(readonly code: FamilyErrorCode, readonly status: number) { super(code); }
}

export interface FamilyView {
  members: Array<{ id: string; name: string; you: boolean; admin: boolean; joinedAt: string }>;
  /** Places the members share: label and whose (a member id above). Never coordinates. */
  places: Array<{ id: string; label: string; memberId: string }>;
  /** True when this person is the admin (may invite and remove). */
  admin: boolean;
  max: number;
}

/** Members oldest first; the first one is the admin. */
export function sortMembers(members: FamilyMember[]): FamilyMember[] {
  return [...members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id));
}

export function familyView(members: FamilyMember[], userId: string, shared: SavedPlace[] = []): FamilyView {
  const sorted = sortMembers(members);
  const adminId = sorted[0]?.id;
  const memberOf = new Map(sorted.map((m) => [m.userId, m.id]));
  return {
    members: sorted.map((m) => ({ id: m.id, name: m.name, you: m.userId === userId, admin: m.id === adminId, joinedAt: m.joinedAt })),
    places: shared.filter((p) => p.shared && memberOf.has(p.userId))
      .map((p) => ({ id: p.id, label: p.label, memberId: memberOf.get(p.userId)! }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
    admin: sorted.find((m) => m.userId === userId)?.id === adminId,
    max: FAMILY_MAX,
  };
}

/** Everyone's shared places in a family (for the view). */
async function sharedPlaces(store: Store, members: FamilyMember[]): Promise<SavedPlace[]> {
  return (await Promise.all(members.map((m) => store.places(m.userId)))).flat().filter((p) => p.shared);
}

async function viewOf(store: Store, members: FamilyMember[], userId: string): Promise<FamilyView> {
  return familyView(members, userId, await sharedPlaces(store, members));
}

/** The person's family as they may see it, or null. */
export async function myFamily(store: Store, userId: string): Promise<FamilyView | null> {
  const me = await store.familyMemberByUser(userId);
  return me ? viewOf(store, await store.familyMembers(me.familyId), userId) : null;
}

async function add(store: Store, m: FamilyMember): Promise<void> {
  const r = await store.addFamilyMember(m, FAMILY_MAX);
  if (r === 'already_in_family') throw new FamilyError('already_in_family', 409);
  if (r === 'family_full') throw new FamilyError('family_full', 409);
  await store.unshareAllPlaces(m.userId);
}

export async function createFamily(store: Store, userId: string, name: string, now = new Date()): Promise<FamilyView> {
  const m: FamilyMember = { id: randomUUID(), familyId: randomUUID(), userId, name, joinedAt: now.toISOString() };
  await add(store, m);
  return familyView([m], userId);
}

async function adminOf(store: Store, userId: string): Promise<{ me: FamilyMember; members: FamilyMember[] }> {
  const me = await store.familyMemberByUser(userId);
  if (!me) throw new FamilyError('not_in_family', 404);
  const members = sortMembers(await store.familyMembers(me.familyId));
  if (members[0]?.id !== me.id) throw new FamilyError('not_admin', 403);
  return { me, members };
}

/** A new code for the family (the previous one stops working). Admin only. */
export async function createInvite(store: Store, userId: string, now = new Date()): Promise<{ code: string; expiresAt: string }> {
  const { me, members } = await adminOf(store, userId);
  if (members.length >= FAMILY_MAX) throw new FamilyError('family_full', 409);
  const code = makeInviteCode();
  const expiresAt = new Date(now.getTime() + FAMILY_INVITE_DAYS * 86_400_000).toISOString();
  await store.setFamilyInvite({ codeHash: inviteCodeHash(normalizeInviteCode(code)!), familyId: me.familyId, expiresAt });
  return { code, expiresAt };
}

export async function joinFamily(store: Store, userId: string, codeInput: string, name: string, now = new Date()): Promise<FamilyView> {
  const code = normalizeInviteCode(codeInput);
  if (!code) throw new FamilyError('invalid_code', 400);
  if (await store.familyMemberByUser(userId)) throw new FamilyError('already_in_family', 409);
  const familyId = await store.takeFamilyInvite(inviteCodeHash(code), now.toISOString());
  if (!familyId) throw new FamilyError('invalid_code', 400);
  const members = await store.familyMembers(familyId);
  if (members.length === 0) throw new FamilyError('invalid_code', 400); // everyone left meanwhile
  if (members.length >= FAMILY_MAX) throw new FamilyError('family_full', 409);
  const m: FamilyMember = { id: randomUUID(), familyId, userId, name, joinedAt: now.toISOString() };
  await add(store, m);
  return viewOf(store, [...members, m], userId);
}

export async function leaveFamily(store: Store, userId: string): Promise<void> {
  const me = await store.familyMemberByUser(userId);
  if (!me) throw new FamilyError('not_in_family', 404);
  await store.removeFamilyMember(me.familyId, me.id);
  await store.unshareAllPlaces(userId);
  if ((await store.familyMembers(me.familyId)).length === 0) await store.deleteFamilyInvites(me.familyId);
}

/** The admin takes someone out of the family. */
export async function removeMember(store: Store, userId: string, memberId: string): Promise<FamilyView> {
  const { me, members } = await adminOf(store, userId);
  if (memberId === me.id) throw new FamilyError('cannot_remove_self', 400);
  const out = members.find((m) => m.id === memberId);
  if (!out) throw new FamilyError('not_found', 404);
  await store.removeFamilyMember(me.familyId, memberId);
  await store.unshareAllPlaces(out.userId);
  return viewOf(store, members.filter((m) => m.id !== memberId), userId);
}

/**
 * Shares one of the person's own places with their family, or stops. Returns the place and the
 * user ids of the other members (so the caller can bring them up to date).
 */
export async function sharePlace(store: Store, userId: string, placeId: string, shared: boolean): Promise<{ place: SavedPlace; others: string[] }> {
  const me = await store.familyMemberByUser(userId);
  if (!me && shared) throw new FamilyError('not_in_family', 404);
  const place = await store.setPlaceShared(userId, placeId, shared);
  if (!place) throw new FamilyError('not_found', 404);
  const others = me ? (await store.familyMembers(me.familyId)).filter((m) => m.userId !== userId).map((m) => m.userId) : [];
  return { place, others };
}

/** How an alert names a place: a family member's shows whose it is, "Zuhause (Mama)". */
export function placeLabel(p: Pick<SavedPlace, 'label' | 'sharedBy'>): string {
  return p.sharedBy ? `${p.label} (${p.sharedBy})` : p.label;
}
