/**
 * FixtureConfluenceServer (IDEA.v2 §7.1) — an in-process HTTP server
 * speaking just enough of the Confluence Cloud v2 wire format for the
 * connector: spaces listing, space pages (current + trashed,
 * body-format=storage, depth=root), and the CQL lastModified search.
 *
 * Fault-injectable: 429 storms (Retry-After honored by the client) and
 * live mutations (edit / add / trash pages) for delta-crawl scenarios.
 * Zero network in CI — it binds 127.0.0.1 on an ephemeral port.
 */
import { createServer, type Server } from 'node:http';

export interface FixturePage {
  id: string;
  title: string;
  parentId?: string | null;
  /** storage-format XHTML */
  body: string;
  version: number;
  lastModified: string; // ISO
  trashed?: boolean;
}

export interface FixtureSpace {
  id: string;
  key: string;
  name: string;
  pages: FixturePage[];
}

export class FixtureConfluenceServer {
  private server: Server | null = null;
  private pending429 = 0;
  requestCount = 0;
  served429 = 0;

  constructor(readonly spaces: FixtureSpace[]) {}

  /** next `n` requests are answered 429 + Retry-After */
  injectRateLimits(n: number): void {
    this.pending429 += n;
  }

  clearFaults(): void {
    this.pending429 = 0;
  }

  editPage(spaceKey: string, pageId: string, newBody: string, lastModified: string): void {
    const page = this.mustPage(spaceKey, pageId);
    page.body = newBody;
    page.version += 1;
    page.lastModified = lastModified;
  }

  addPage(spaceKey: string, page: FixturePage): void {
    this.mustSpace(spaceKey).pages.push(page);
  }

  trashPage(spaceKey: string, pageId: string, lastModified: string): void {
    const page = this.mustPage(spaceKey, pageId);
    page.trashed = true;
    page.lastModified = lastModified;
  }

  private mustSpace(key: string): FixtureSpace {
    const s = this.spaces.find((x) => x.key === key);
    if (!s) throw new Error(`fixture: unknown space ${key}`);
    return s;
  }

  private mustPage(spaceKey: string, pageId: string): FixturePage {
    const p = this.mustSpace(spaceKey).pages.find((x) => x.id === pageId);
    if (!p) throw new Error(`fixture: unknown page ${pageId}`);
    return p;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.requestCount++;
      if (this.pending429 > 0) {
        this.pending429--;
        this.served429++;
        res.writeHead(429, { 'retry-after': '0.05' });
        res.end('rate limited');
        return;
      }
      try {
        const url = new URL(req.url ?? '/', 'http://fixture');
        const body = this.route(url);
        if (body == null) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    if (addr == null || typeof addr === 'string') throw new Error('fixture: no address');
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close((e) => (e ? reject(e) : resolve())));
    this.server = null;
  }

  // ---- routing -----------------------------------------------------------

  private paginate<T>(url: URL, items: T[], basePath: string): { results: T[]; _links?: { next?: string } } {
    const limit = Math.max(1, Number(url.searchParams.get('limit') ?? '25'));
    const offset = Number(url.searchParams.get('cursor') ?? '0');
    const slice = items.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const out: { results: T[]; _links?: { next?: string } } = { results: slice };
    if (nextOffset < items.length) {
      const next = new URL(url.toString());
      next.searchParams.set('cursor', String(nextOffset));
      out._links = { next: `${basePath}?${next.searchParams.toString()}` };
    }
    return out;
  }

  private pageJson(p: FixturePage, withBody: boolean): Record<string, unknown> {
    return {
      id: p.id,
      title: p.title,
      parentId: p.parentId ?? null,
      version: { number: p.version },
      lastModified: p.lastModified,
      ...(withBody ? { body: { storage: { value: p.body } } } : {}),
    };
  }

  private route(url: URL): unknown {
    // GET /wiki/api/v2/spaces[?keys=K]
    if (url.pathname === '/wiki/api/v2/spaces') {
      const keys = url.searchParams.get('keys');
      const spaces = (keys ? this.spaces.filter((s) => keys.split(',').includes(s.key)) : this.spaces).map((s) => ({
        id: s.id,
        key: s.key,
        name: s.name,
      }));
      return this.paginate(url, spaces, url.pathname);
    }

    // GET /wiki/api/v2/spaces/:id/pages
    const pagesMatch = url.pathname.match(/^\/wiki\/api\/v2\/spaces\/([^/]+)\/pages$/);
    if (pagesMatch) {
      const space = this.spaces.find((s) => s.id === pagesMatch[1]);
      if (!space) return null;
      const status = url.searchParams.get('status') ?? 'current';
      const depthRoot = url.searchParams.get('depth') === 'root';
      const withBody = url.searchParams.get('body-format') === 'storage';
      let pages = space.pages.filter((p) => (status === 'trashed' ? p.trashed === true : p.trashed !== true));
      if (depthRoot) pages = pages.filter((p) => p.parentId == null);
      return this.paginate(
        url,
        pages.map((p) => this.pageJson(p, withBody)),
        url.pathname,
      );
    }

    // GET /wiki/rest/api/search?cql=space=KEY and lastModified > TS
    if (url.pathname === '/wiki/rest/api/search') {
      const cql = url.searchParams.get('cql') ?? '';
      const spaceKey = cql.match(/space=("?)([A-Za-z0-9_-]+)\1/)?.[2];
      const watermark = cql.match(/lastModified\s*>\s*("?)([0-9T:.Z-]+)\1/)?.[2];
      if (!spaceKey) return null;
      const space = this.spaces.find((s) => s.key === spaceKey);
      if (!space) return null;
      const changed = space.pages
        .filter((p) => p.trashed !== true && (!watermark || p.lastModified > watermark))
        .sort((a, b) => (a.lastModified < b.lastModified ? -1 : 1))
        .map((p) => this.pageJson(p, true));
      return this.paginate(url, changed, url.pathname);
    }

    return null;
  }
}

// ---- canonical fixture site (3 spaces, code macros / tables / links) ------

const code = (body: string, lang = 'ts') =>
  `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${lang}</ac:parameter>` +
  `<ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body></ac:structured-macro>`;

export function buildFixtureSite(): FixtureSpace[] {
  const t = (day: number) => `2026-01-${String(day).padStart(2, '0')}T10:00:00.000Z`;
  const mkPages = (
    spaceIdx: number,
    topics: string[],
    extras: (pageId: string, topic: string, i: number) => string,
  ): FixturePage[] => {
    const pages: FixturePage[] = [];
    for (let topicIdx = 0; topicIdx < topics.length; topicIdx++) {
      const topic = topics[topicIdx];
      // 'r' infix keeps root ids disjoint from child ids by construction
      const rootId = `${spaceIdx}r${topicIdx}`;
      pages.push({
        id: rootId,
        title: topic,
        parentId: null,
        body: `<p>Landing page for ${topic}. See child pages for details.</p>`,
        version: 1,
        lastModified: t(1 + topicIdx),
      });
      for (let i = 0; i < 12; i++) {
        const id = `${spaceIdx}${topicIdx}${String(i).padStart(2, '0')}`;
        pages.push({
          id,
          title: `${topic} — note ${i}`,
          parentId: rootId,
          body: extras(id, topic, i),
          version: 1,
          lastModified: t(2 + topicIdx + (i % 5)),
        });
      }
    }
    return pages;
  };

  return [
    {
      id: 'sp-eng',
      key: 'ENG',
      name: 'Engineering',
      pages: mkPages(1, ['Deployment Guide', 'Service Runbook', 'Architecture Decisions'], (id, topic, i) =>
        [
          `<h1>${topic} ${i}</h1><p>Operational notes for the ${topic.toLowerCase()} flow, iteration ${i}.</p>`,
          code(`export function engHelper_${id}(cfg: Config) {\n  return cfg.flags & 0x${id};\n}`),
          `<table><tr><th>Service</th><th>Owner</th></tr><tr><td>svc-${id}</td><td>team-${i}</td></tr></table>`,
          `<p>Related: <a href="https://wiki.example/runbook-${id}">Runbook ${id}</a></p>`,
        ].join(''),
      ),
    },
    {
      id: 'sp-prod',
      key: 'PROD',
      name: 'Product',
      pages: mkPages(2, ['Roadmap Planning', 'Customer Research', 'Launch Checklists'], (id, topic, i) =>
        [
          `<h2>${topic} ${i}</h2><p>Planning prose about ${topic.toLowerCase()} milestone ${i} with stakeholder context.</p>`,
          `<table><tr><th>Milestone</th><th>Quarter</th></tr><tr><td>ms-${id}</td><td>Q${(i % 4) + 1}</td></tr></table>`,
          `<p>Spec link: <a href="https://docs.example/spec-${id}">Spec ${id}</a></p>`,
        ].join(''),
      ),
    },
    {
      id: 'sp-sec',
      key: 'SEC',
      name: 'Security',
      pages: mkPages(3, ['Incident Response', 'Access Policies', 'Audit Notes'], (id, topic, i) =>
        [
          `<h1>${topic} ${i}</h1><p>Security guidance covering ${topic.toLowerCase()} case ${i}.</p>`,
          code(`audit_rule "rule_${id}" {\n  severity = ${i}\n  match    = "secToken_${id}"\n}`, 'hcl'),
        ].join(''),
      ),
    },
  ];
}
