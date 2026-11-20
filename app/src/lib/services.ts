/**
 * "Only the services I use" for tech outages. `null` (or missing) means every service, including
 * ones added later. The app never saves an empty list: unpicking the last service goes back to all
 * (turning the whole topic off is the switch above it).
 */
export type TechChoice = string[] | null | undefined;

export function followsService(choice: TechChoice, key: string): boolean {
  return !choice || choice.includes(key);
}

/** Tapping a service chip. From "all", the first tap means "only this one". */
export function toggleService(choice: TechChoice, key: string): string[] | null {
  if (!choice) return [key];
  const next = choice.includes(key) ? choice.filter((k) => k !== key) : [...choice, key];
  return next.length ? next : null;
}
