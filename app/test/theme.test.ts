import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryColor, colors, severityColor } from '../src/lib/theme.ts';
import { CATEGORIES } from '../src/lib/types.ts';

// lib/theme: every topic and level has a colour, and text stays readable on the night-sky background.

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('every topic and every severity level has its own colour', () => {
  assert.deepEqual(Object.keys(categoryColor).sort(), [...CATEGORIES].sort());
  assert.deepEqual(Object.keys(severityColor), ['1', '2', '3', '4', '5']);
  assert.equal(new Set(Object.values(categoryColor)).size, CATEGORIES.length);
  assert.equal(new Set(Object.values(severityColor)).size, 5);
});

test('text, muted text, topic and level colours are readable on the background (WCAG AA, 4.5:1)', () => {
  assert.ok(contrast(colors.text, colors.bg) >= 7, 'body text AAA');
  for (const [name, c] of Object.entries({ muted: colors.muted, cyan: colors.cyan, good: colors.good, danger: colors.danger, ...categoryColor, ...severityColor })) {
    assert.ok(contrast(c, colors.bg) >= 4.5, `${name} ${c}: ${contrast(c, colors.bg).toFixed(2)}`);
  }
});

test('calm by default: levels 1 and 2 are cool, warm colours only from 3 up (red > blue)', () => {
  const warm = (hex: string) => parseInt(hex.slice(1, 3), 16) > parseInt(hex.slice(5, 7), 16);
  assert.deepEqual(([1, 2, 3, 4, 5] as const).map((l) => warm(severityColor[l])), [false, false, true, true, true]);
});
