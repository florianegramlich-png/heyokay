import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserLanguage, timeAgo, translate } from '../lib/i18n';
import { APP_STRINGS, CATEGORY } from '../lib/app-strings';

test('German first: German browsers and unknown get German, others English', () => {
  assert.equal(browserLanguage(['de-DE', 'en']), 'de');
  assert.equal(browserLanguage(['en-US']), 'en');
  assert.equal(browserLanguage(['fr-FR']), 'en');
  assert.equal(browserLanguage([]), 'de');
});

test('both languages have every string, shared with the phone app', () => {
  assert.deepEqual(Object.keys(APP_STRINGS.en).sort(), Object.keys(APP_STRINGS.de).sort());
  assert.equal(translate('de', 'feed.empty.title'), 'Alles okay.');
  assert.equal(translate('en', 'web.nav.history'), 'History');
  assert.equal(translate('de', 'web.now.count', { n: 2 }), '2 aktuell');
  assert.equal(CATEGORY.de.crime.label, 'Polizeilage');
});

test('web strings exist in both languages and use no alarm words', () => {
  for (const lang of ['de', 'en'] as const) {
    for (const key of ['web.nav.now', 'web.now.title', 'web.about.text', 'web.now.webNote'] as const) {
      const s = translate(lang, key);
      assert.ok(s && s !== key, `${lang} ${key}`);
      assert.doesNotMatch(s, /\b(panik|terror|gefahr!|alarm!|danger!)\b/i);
    }
  }
});

test('relative times', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  assert.equal(timeAgo('de', '2026-11-18T11:59:40Z', now), 'gerade eben');
  assert.equal(timeAgo('de', '2026-11-18T11:15:00Z', now), 'vor 45 Min.');
  assert.equal(timeAgo('en', '2026-11-18T09:00:00Z', now), translate('en', 'time.h', { n: 3 }));
});
