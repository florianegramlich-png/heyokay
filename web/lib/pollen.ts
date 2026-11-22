/**
 * "Pollen & UV: what matters to you". Keys as the server uses them (server/src/sources/dwd-health.ts,
 * POLLEN_UV_KEYS), in the order of the pollen season. Picking works like the tech-outage services
 * (lib/services.ts): null = all, the first tap means "only this one", unpicking the last goes back to all.
 */
export const POLLEN_UV_KEYS = ['hasel', 'erle', 'esche', 'birke', 'graeser', 'roggen', 'beifuss', 'ambrosia', 'uv'] as const;
export type PollenUvKey = (typeof POLLEN_UV_KEYS)[number];
export type PollenKeyString = `pollen.${PollenUvKey}`;
export const pollenStringKey = (k: PollenUvKey): PollenKeyString => `pollen.${k}`;
