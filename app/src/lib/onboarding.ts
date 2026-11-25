/**
 * PRD 5.3 onboarding order, as a pure module so it can be tested without React Native
 * (test/onboarding.test.ts): value → location (foreground, then "always" only if foreground was
 * allowed) → notifications → topics → privacy/consent. Each screen is counted as `onb_<step>`
 * (lib/analytics.ts).
 */

export const ONBOARDING_STEPS = ['value', 'location', 'always', 'notifications', 'categories', 'consent'] as const;
export type Step = (typeof ONBOARDING_STEPS)[number];

/** What the person did on a step: a permission answer, or simply "continue". */
export type StepAnswer = boolean | 'later' | 'continue';

/** The step after `step`, given the answer; null after the last one (finish onboarding). */
export function nextStep(step: Step, answer: StepAnswer = 'continue'): Step | null {
  switch (step) {
    case 'value': return 'location';
    // Asking for "always" makes no sense once the foreground permission was refused or put off.
    case 'location': return answer === true ? 'always' : 'notifications';
    case 'always': return 'notifications';
    case 'notifications': return 'categories';
    case 'categories': return 'consent';
    case 'consent': return null;
  }
}

/** The topics step needs at least one topic before it can go on. */
export function canContinue(step: Step, categories: readonly string[]): boolean {
  return step !== 'categories' || categories.length > 0;
}
