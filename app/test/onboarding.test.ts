import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ONBOARDING_STEPS, canContinue, nextStep, type Step } from '../src/lib/onboarding.ts';
import { APP_EVENTS } from '../src/lib/analytics.ts';

// PRD 5.3: value → location (foreground, then always) → notifications → topics → privacy.

function walk(location: boolean | 'later'): Step[] {
  const seen: Step[] = [];
  let s: Step | null = 'value';
  while (s) {
    seen.push(s);
    s = nextStep(s, s === 'location' ? location : 'continue');
  }
  return seen;
}

test('location allowed: every step, in order, ending after privacy', () => {
  assert.deepEqual(walk(true), [...ONBOARDING_STEPS]);
  assert.equal(nextStep('consent'), null);
});

test('location refused or put off: no "always" question, straight to notifications', () => {
  for (const answer of [false, 'later'] as const) {
    assert.deepEqual(walk(answer), ['value', 'location', 'notifications', 'categories', 'consent']);
  }
});

test('notifications and "always" go on whatever the answer', () => {
  for (const a of [true, false, 'later'] as const) {
    assert.equal(nextStep('always', a), 'notifications');
    assert.equal(nextStep('notifications', a), 'categories');
  }
});

test('the topics step needs at least one topic; the others never block', () => {
  assert.equal(canContinue('categories', []), false);
  assert.equal(canContinue('categories', ['weather']), true);
  for (const s of ONBOARDING_STEPS) if (s !== 'categories') assert.equal(canContinue(s, []), true);
});

test('every step is a counted app event (the funnel on the Alert Desk)', () => {
  for (const s of ONBOARDING_STEPS) assert.ok((APP_EVENTS as readonly string[]).includes(`onb_${s}`), s);
});
