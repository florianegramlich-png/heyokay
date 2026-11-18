import { describe, expect, it } from 'vitest';
import { COUNTRIES, packFor } from '../src/countries.js';
import { recommendedAction } from '../src/pipeline/guidance.js';
import { newEvent } from '../src/pipeline/cluster.js';

describe('country packs', () => {
  it('infers the pack for items and events from before country tags', () => {
    expect(packFor({ language: 'de' }).code).toBe('DE');
    expect(packFor({ language: 'en' }).code).toBe('US');
    expect(packFor({ country: 'AT', language: 'de' }).code).toBe('AT');
    expect(packFor({ country: 'XX' as any, language: 'en' }).code).toBe('US');
  });

  it('advice names the numbers of the country the event is in', () => {
    expect(recommendedAction('crime', 4, 'de', undefined, COUNTRIES.DE)).toContain('Notruf 110');
    expect(recommendedAction('crime', 4, 'de', undefined, COUNTRIES.AT)).toContain('Notruf 133');
    expect(recommendedAction('crime', 4, 'de', undefined, COUNTRIES.CH)).toContain('Notruf 117');
    expect(recommendedAction('crime', 4, 'en', undefined, COUNTRIES.US)).toContain('911');
    expect(recommendedAction('crime', 4, 'en', undefined, COUNTRIES.DE)).toContain('Emergency: 110');
    expect(recommendedAction('health', 4, 'de', undefined, COUNTRIES.DE)).toBe('Hinweise des Gesundheitsamts sofort befolgen. Bei Beschwerden 116 117, im Notfall 112.');
    expect(recommendedAction('health', 4, 'de', undefined, COUNTRIES.CH)).toBe('Hinweise des Gesundheitsamts sofort befolgen. Im Notfall 112.');
    expect(recommendedAction('weather', 3, 'en', 'heat', COUNTRIES.US)).toContain('call 911');
  });

  it('the default keeps the texts from before (German → DE numbers, English → US numbers)', () => {
    expect(recommendedAction('infrastructure', 4)).toBe('Bereich meiden. Bei Gasgeruch Gebäude verlassen und 112 anrufen.');
    expect(recommendedAction('infrastructure', 4, 'en')).toBe('Avoid the area. If you smell gas, leave the building and call 911.');
    expect(recommendedAction('weather', 2)).toBe('Lose Gegenstände sichern, Aufenthalt im Freien begrenzen.');
  });

  it('new events carry the country of their source', () => {
    const ext = { category: 'crime', severity: 4, confidence: 0.9, title: 't', summary: 's', areaName: 'Wien', lat: 48.2, lon: 16.37, radiusM: 1000, startsAt: '2026-11-18T10:00:00Z', endsAt: null } as any;
    const base = { source: 'rss', sourceName: 'x', externalId: '1', official: false, title: 't', body: 'b', publishedAt: '2026-11-18T10:00:00Z' } as any;
    expect(newEvent(ext, { ...base, country: 'AT', language: 'de' }, 'auto').country).toBe('AT');
    expect(newEvent(ext, { ...base, language: 'en' }, 'auto').country).toBe('US');
  });
});
