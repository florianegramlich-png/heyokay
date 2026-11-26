import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FamilyMember, Store } from './store.js';

/**
 * Family sharing, part 1a (PRD 6.1 #8, 3.3 #4): family groups with invite codes. Protecting
 * places, never tracking people: a family only knows who is in it (a name each person picks).
 * Shared places follow in part 1b; nobody's location is ever shared.
 *
 * - One family per person, up to FAMILY_MAX people.
 * - The admin is whoever has been in the family longest (no stored role, so a family is never left
 *   without one when someone leaves or deletes their data). Only the admin invites or removes.
 * - One invite code per family at a time, single use, FAMILY_INVITE_DAYS valid, stored as a hash.
 * - A family ends when its last person leaves.
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
  /** True when this person is the admin (may invite and remove). */
  admin: boolean;
  max: number;
}

/** Members oldest first; the first one is the admin. */
export function sortMembers(members: FamilyMember[]): FamilyMember[] {
  return [...members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id));
}

export function familyView(members: FamilyMember[], userId: string): FamilyView {
  const sorted = sortMembers(members);
  const adminId = sorted[0]?.id;
  return {
    members: sorted.map((m) => ({ id: m.id, name: m.name, you: m.userId === userId, admin: m.id === adminId, joinedAt: m.joinedAt })),
    admin: sorted.find((m) => m.userId === userId)?.id === adminId,
    max: FAMILY_MAX,
  };
}

/** The person's family as they may see it, or null. */
export async function myFamily(store: Store, userId: string): Promise<FamilyView | null> {
  const me = await store.familyMemberByUser(userId);
  return me ? familyView(await store.familyMembers(me.familyId), userId) : null;
}

export async function createFamily(store: Store, userId: string, name: string, now = new Date()): Promise<FamilyView> {
  const m: FamilyMember = { id: randomUUID(), familyId: randomUUID(), userId, name, joinedAt: now.toISOString() };
  if (!(await store.addFamilyMember(m))) throw new FamilyError('already_in_family', 409);
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
  if (!(await store.addFamilyMember(m))) throw new FamilyError('already_in_family', 409);
  return familyView([...members, m], userId);
}

export async function leaveFamily(store: Store, userId: string): Promise<void> {
  const me = await store.familyMemberByUser(userId);
  if (!me) throw new FamilyError('not_in_family', 404);
  await store.removeFamilyMember(me.familyId, me.id);
  if ((await store.familyMembers(me.familyId)).length === 0) await store.deleteFamilyInvites(me.familyId);
}

/** The admin takes someone out of the family. */
export async function removeMember(store: Store, userId: string, memberId: string): Promise<FamilyView> {
  const { me, members } = await adminOf(store, userId);
  if (memberId === me.id) throw new FamilyError('cannot_remove_self', 400);
  if (!members.some((m) => m.id === memberId)) throw new FamilyError('not_found', 404);
  await store.removeFamilyMember(me.familyId, memberId);
  return familyView(members.filter((m) => m.id !== memberId), userId);
}
