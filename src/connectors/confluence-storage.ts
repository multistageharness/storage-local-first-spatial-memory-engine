/**
 * IDEA.v2 §7.1 — Confluence storage-format → text converter.
 *
 * Rules (in priority order):
 *   1. code-macro bodies are preserved BYTE-VERBATIM — they are the
 *      exact-match payload; HTML-stripping them like prose would destroy
 *      the engine's reason to exist (IDEA.v2 §12 pitfall);
 *   2. tables → row-per-line text (cells joined with ' | ');
 *   3. links → 'title (url)'; Confluence page links keep their title;
 *   4. everything else: strip XHTML tags, decode entities, collapse
 *      whitespace.
 *
 * Zero dependencies: Confluence storage format is regular enough for a
 * staged regex pipeline (placeholders protect verbatim regions from the
 * prose transforms).
 */

const PLACEHOLDER = (i: number) => `\u0000CODE${i}\u0000`;

function decodeEntities(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&'); // last — avoid double-decoding
}

export function storageToText(storage: string): string {
  let text = storage;

  // 1. extract code macros first; bodies bypass every later transform.
  //    <ac:structured-macro ac:name="code">…<ac:plain-text-body>
  //    <![CDATA[ … ]]></ac:plain-text-body>…</ac:structured-macro>
  const codeBodies: string[] = [];
  text = text.replace(
    /<ac:structured-macro[^>]*ac:name="(?:code|noformat)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g,
    (_m, inner: string) => {
      const cdata = inner.match(/<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/);
      const body = cdata ? cdata[1] : inner.replace(/<[^>]+>/g, '');
      codeBodies.push(cdata ? cdata[1] : body);
      return `\n${PLACEHOLDER(codeBodies.length - 1)}\n`;
    },
  );
  // bare CDATA outside macros (rare) — also verbatim
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, body: string) => {
    codeBodies.push(body);
    return `\n${PLACEHOLDER(codeBodies.length - 1)}\n`;
  });

  // 2. tables → row-per-line
  text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (_m, tbl: string) => {
    const rows = [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) => {
      const cells = [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) =>
        c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      );
      return cells.join(' | ');
    });
    return `\n${rows.join('\n')}\n`;
  });

  // 3a. anchor links → 'title (url)'
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_m, url: string, title: string) => {
    const t = title.replace(/<[^>]+>/g, '').trim();
    return t ? `${t} (${url})` : url;
  });
  // 3b. Confluence page links: <ac:link><ri:page ri:content-title="X"/>…
  text = text.replace(/<ac:link[^>]*>([\s\S]*?)<\/ac:link>/g, (_m, inner: string) => {
    const page = inner.match(/ri:content-title="([^"]*)"/);
    const body = inner.match(/<ac:plain-text-link-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>/);
    return body?.[1] ?? page?.[1] ?? '';
  });

  // 4. structural tags become line breaks, the rest vanish
  text = text
    .replace(/<\/(p|h[1-6]|li|div|blockquote)>/g, '\n')
    .replace(/<(br|hr)\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  // collapse intra-line whitespace, keep line structure
  text = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 5. restore code bodies byte-verbatim
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeBodies[Number(i)]);
  return text;
}
