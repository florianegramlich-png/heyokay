import { Bus, CloudLightning, Droplets, Flame, PlugZap, ServerCrash, Siren, type LucideIcon } from 'lucide-react';
import type { Category } from '@/lib/types';

export const CATEGORY_ICON: Record<Category, LucideIcon> = {
  weather: CloudLightning,
  crime: Siren,
  transit: Bus,
  public_safety: Flame,
  health: Droplets,
  infrastructure: PlugZap,
  technology: ServerCrash,
};

export const CATEGORY_COLOR: Record<Category, string> = {
  weather: 'text-sky-400',
  crime: 'text-indigo-300',
  transit: 'text-cyan-400',
  public_safety: 'text-orange-300',
  health: 'text-emerald-400',
  infrastructure: 'text-violet-300',
  technology: 'text-fuchsia-300',
};

export function CategoryIcon({ category, className }: { category: Category; className?: string }) {
  const Icon = CATEGORY_ICON[category];
  return <Icon aria-hidden className={`${CATEGORY_COLOR[category]} ${className ?? 'h-5 w-5'}`} />;
}
