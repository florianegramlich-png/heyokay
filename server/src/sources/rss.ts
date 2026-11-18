import { createHash } from 'node:crypto';
import type { RssFeedConfig } from '../config.js';
import type { SourceItem } from '../types.js';
import { stripHtml } from './nina.js';
import { fetchWithTimeout } from '../http.js';

/**
 * Generic RSS 2.0 / Atom adapter for unstructured sources:
 * police press releases (e.g. Presseportal Blaulicht feeds per police office),
 * transit operator disruption feeds, municipal bulletins, vetted local news.
 * Feeds are configured, never discovered — every source is on an approved list.
 */
export function parseFeed(xml: string, feed: RssFeedConfig): SourceItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return blocks.map((b) => {
    const title = text(b, 'title');
    const link = attr(b, 'link', 'href') ?? text(b, 'link');
    const body = text(b, 'description') || text(b, 'content:encoded') || text(b, 'summary') || text(b, 'content');
    const guid = text(b, 'guid') || text(b, 'id') || link || title;
    const date = text(b, 'pubDate') || text(b, 'published') || text(b, 'updated') || text(b, 'dc:date');
    const published = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : new Date().toISOString();
    return {
      source: 'rss' as const,
      sourceName: feed.sourceName,
      externalId: `${feed.sourceName}:${createHash('sha1').update(guid).digest('hex').slice(0, 16)}`,
      official: false,
      title: stripHtml(title),
      body: stripHtml(body),
      url: link || undefined,
      publishedAt: published,
      category: feed.categoryHint,
    };
  }).filter((i) => i.title || i.body);
}

function text(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function attr(block: string, tag: string, name: string): string | null {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]+)"`, 'i'));
  return m ? m[1] : null;
}

export async function fetchFeed(feed: RssFeedConfig): Promise<SourceItem[]> {
  const res = await fetchWithTimeout(feed.url, { headers: { Accept: 'application/rss+xml, application/atom+xml, text/xml' } });
  if (!res.ok) throw new Error(`${feed.url} → HTTP ${res.status}`);
  return parseFeed(await res.text(), feed);
}
