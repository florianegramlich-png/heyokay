/**
 * Prometheus metrics (PRD 13), without a dependency. Each machine keeps its own numbers and serves
 * them on an internal port (METRICS_PORT, default 9091) that Fly scrapes into its managed
 * Prometheus/Grafana (fly.toml [metrics]); the port is never exposed to the internet.
 * Labels never carry user data: only source keys, routes (patterns), status classes and results.
 */
type Labels = Record<string, string>;
const key = (l: Labels) => JSON.stringify(Object.entries(l).sort());
const fmtLabels = (l: Labels) => {
  const e = Object.entries(l);
  return e.length ? `{${e.map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',')}}` : '';
};

abstract class Metric {
  constructor(readonly name: string, readonly help: string, readonly type: 'counter' | 'gauge' | 'histogram') {}
  abstract lines(): string[];
  render() { return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`, ...this.lines()].join('\n'); }
}

export class Counter extends Metric {
  private values = new Map<string, { labels: Labels; v: number }>();
  constructor(name: string, help: string) { super(name, help, 'counter'); }
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    const cur = this.values.get(k) ?? { labels, v: 0 };
    cur.v += by;
    this.values.set(k, cur);
  }
  get(labels: Labels = {}) { return this.values.get(key(labels))?.v ?? 0; }
  lines() { return [...this.values.values()].map(({ labels, v }) => `${this.name}${fmtLabels(labels)} ${v}`); }
}

export class Gauge extends Metric {
  private values = new Map<string, { labels: Labels; v: number }>();
  constructor(name: string, help: string) { super(name, help, 'gauge'); }
  set(labels: Labels, v: number) { this.values.set(key(labels), { labels, v }); }
  reset() { this.values.clear(); }
  lines() { return [...this.values.values()].map(({ labels, v }) => `${this.name}${fmtLabels(labels)} ${v}`); }
}

export class Histogram extends Metric {
  private values = new Map<string, { labels: Labels; counts: number[]; sum: number; n: number }>();
  constructor(name: string, help: string, readonly buckets: number[]) { super(name, help, 'histogram'); }
  observe(labels: Labels, v: number) {
    const k = key(labels);
    const cur = this.values.get(k) ?? { labels, counts: this.buckets.map(() => 0), sum: 0, n: 0 };
    this.buckets.forEach((b, i) => { if (v <= b) cur.counts[i]++; });
    cur.sum += v; cur.n++;
    this.values.set(k, cur);
  }
  lines() {
    return [...this.values.values()].flatMap(({ labels, counts, sum, n }) => [
      ...this.buckets.map((b, i) => `${this.name}_bucket${fmtLabels({ ...labels, le: String(b) })} ${counts[i]}`),
      `${this.name}_bucket${fmtLabels({ ...labels, le: '+Inf' })} ${n}`,
      `${this.name}_sum${fmtLabels(labels)} ${sum}`,
      `${this.name}_count${fmtLabels(labels)} ${n}`,
    ]);
  }
}

export class Registry {
  private metrics: Metric[] = [];
  private collectors: Array<() => Promise<void>> = [];
  add<M extends Metric>(m: M): M { this.metrics.push(m); return m; }
  /** Runs before each scrape, e.g. to read the queue depth from the database. */
  onCollect(fn: () => Promise<void>) { this.collectors.push(fn); }
  async render(): Promise<string> {
    await Promise.all(this.collectors.map((c) => c().catch(() => {})));
    return this.metrics.map((m) => m.render()).join('\n') + '\n';
  }
}

/** The process-wide registry and the metrics the server records. */
export const registry = new Registry();
export const M = {
  pushes: registry.add(new Counter('heyokay_pushes_total', 'Pushes handed to Expo, by result (sent|error).')),
  pushLatency: registry.add(new Histogram('heyokay_push_latency_seconds', 'From alert created to push handed to Expo.', [1, 5, 15, 30, 60, 120, 300, 900])),
  sourcePolls: registry.add(new Counter('heyokay_source_polls_total', 'Source polls, by source and result (ok|error).')),
  sourcePollSeconds: registry.add(new Histogram('heyokay_source_poll_seconds', 'Duration of one source poll.', [0.5, 1, 2, 5, 10, 15, 30, 60])),
  sourceUp: registry.add(new Gauge('heyokay_source_up', '1 when the source\'s last poll worked and is recent, else 0.')),
  sourceLastOkAge: registry.add(new Gauge('heyokay_source_last_ok_age_seconds', 'Seconds since the source last polled successfully.')),
  pushQueue: registry.add(new Gauge('heyokay_push_queue_depth', 'Pushes waiting in the delivery queue.')),
  workerLeading: registry.add(new Gauge('heyokay_worker_leading', '1 when this machine holds the worker lease.')),
  http: registry.add(new Counter('heyokay_http_requests_total', 'HTTP requests, by route pattern, method and status class.')),
  httpSeconds: registry.add(new Histogram('heyokay_http_request_seconds', 'HTTP request duration, by route pattern.', [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5])),
  llmCalls: registry.add(new Counter('heyokay_llm_calls_total', 'Model calls, by result (ok|failed|over_budget).')),
  llmSpendToday: registry.add(new Gauge('heyokay_llm_spend_eur_today', 'AI spend today in EUR, as known to this machine.')),
  errors: registry.add(new Counter('heyokay_errors_total', 'Unexpected errors, by context.')),
};
