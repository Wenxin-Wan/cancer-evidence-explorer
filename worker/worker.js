// EpiDetective tools: the Cloudflare Worker for tools.epidetective.com
//
// Draft of 28 October 2026 (Batch 8 of review-2026-10-28/PLAN-2026-10-28.md).
// It replaces the gate Worker of 10 September 2026, which is kept beside this
// file as legacy-2026-09-10.js for rollback. DEPLOY.md says how to deploy and
// check it; ROUTES-TEST.md lists the route cases it was tested against.
//
// What it does
// - Serves the two tool pages from the deploy repo on GitHub
//   (Wenxin-Wan/cancer-evidence-explorer, branch main, raw files).
// - Keeps every upstream file in the Cache API (caches.default). Only a
//   complete file is stored: a page must end with </html> and a share file
//   must parse as JSON, so a transfer cut short is never kept. A copy is
//   fresh for 5 minutes; after that the Worker asks GitHub again with
//   If-None-Match. Each copy is kept for 7 days from the last successful check
//   as the last good copy: it is served when GitHub fails or sends a file that
//   is not complete, and the next check then waits a minute. The wait for
//   GitHub's headers is 3 seconds when a copy or a marker exists, and for the
//   share files, and 10 seconds otherwise; the body may take 15 seconds more.
//   A visitor gets the 502 page only when GitHub fails and no copy exists.
// - Passes GitHub's ETag through. Share routes add a suffix of their own,
//   because their head differs from the plain page. If-None-Match is answered
//   with 304 before any rewriting.
// - Share routes give each entry its own title, description, canonical link
//   and share card: /cancer/e/<slug>, /cancer/c/<slug>, /chronic/d/<id>,
//   /chronic/r/<id> and /chronic/l/<risk>/<disease>. The <risk>|<disease> form
//   gets a 301 to the two-segment form. The data come from share/cancer.json
//   and share/chronic.json in the same repo. When a file or an entry is
//   missing, the page is served unchanged with status 404; the page itself
//   then shows its not-found notice. When the share file cannot be fetched,
//   or arrives cut short, and no copy exists here, the unchanged page gets
//   status 503, so that a crawler tries again later; that failure is
//   remembered for a minute.
// - "/" is a small chooser page. /cancer, /chronic, upper-case variants and
//   index.html paths get a 301 to the canonical form. /favicon.ico goes to the
//   site icon, and /chronic/references.html, framework.html and changelog.html
//   go to those pages on the site. Every other path, including the old /login,
//   /logout, /join, /admin and /waitlist.csv, gets an HTML 404.
// - The chooser, the 404 page and the error page follow ?lang= in English,
//   Chinese, French, Spanish and Russian (the site's languages), with texts
//   reused from the site and the tools; the other tool languages see English.
// - Sends the security headers on every response.
//
// Self-contained: the code is the whole Worker. It uses no bindings or secrets
// and sets no cookies.

const SITE = "https://epidetective.com";
// Canonical host, used for og:url, canonical links and the internal cache keys.
const ORIGIN = "https://tools.epidetective.com";
const RAW = "https://raw.githubusercontent.com/Wenxin-Wan/cancer-evidence-explorer/main/";

// Upstream files. kind says what a complete file looks like (see complete()).
// Optional files may be absent: a 404 from GitHub then means "not published
// yet" and is remembered for 5 minutes.
const UPSTREAM = {
  cancer: { url: RAW + "index.html", kind: "html", optional: false },
  chronic: { url: RAW + "chronic/index.html", kind: "html", optional: false },
  "share-cancer": { url: RAW + "share/cancer.json", kind: "json", optional: true },
  "share-chronic": { url: RAW + "share/chronic.json", kind: "json", optional: true },
};

const TOOLS = {
  cancer: {
    name: "Cancer Evidence Explorer",
    path: "/cancer/",
    image: SITE + "/assets/og/cancer.png",
    upstream: "cancer",
    share: "share-cancer",
  },
  chronic: {
    name: "Chronic Disease Evidence Explorer",
    path: "/chronic/",
    image: SITE + "/assets/og/chronic.png",
    upstream: "chronic",
    share: "share-chronic",
  },
};

// The ten tool languages; the site itself has pages for these four besides
// English (English lives at the root).
const LANGS = ["en", "zh", "fr", "es", "ru", "pt", "ar", "de", "ja", "it"];
const SITE_LANGS = ["zh", "fr", "es", "ru"];

const FRESH_MS = 5 * 60 * 1000; // a cached copy counts as fresh for 5 minutes
const RETRY_MS = 60 * 1000; // after a failed check, the next check waits a minute
const KEEP_MS = 7 * 24 * 60 * 60 * 1000; // the last good copy is kept for 7 days
const UPSTREAM_TIMEOUT_MS = 10000; // wait for GitHub's headers when nothing is cached
const STALE_TIMEOUT_MS = 3000; // wait when a last good copy or a marker can answer instead, and for share files
const BODY_TIMEOUT_MS = 15000; // after the headers, the whole body must arrive within this
const HEAD_SCAN_LIMIT = 1 << 20; // look for </head> in the first 1 MiB only
const CACHE_PREFIX = ORIGIN + "/__edge-cache/v1/"; // internal keys, never routed
// Part of every ETag this Worker computes itself, so that a new Worker
// version never matches a browser copy made by an older one.
const WORKER_REV = "w20261028";

const PAGE_CACHE = "public, max-age=300, stale-while-revalidate=86400";
const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "frame-ancestors 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, ctx);
    } catch (err) {
      console.error("worker error:", err && err.stack ? err.stack : String(err));
      return errorPage(request, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handle(request, ctx) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const head = method === "HEAD";
  const lang = pickLang(url.searchParams.get("lang"));
  const route = resolve(url);

  if (route.type === "notfound") {
    return htmlResponse(notFoundHtml(lang), 404, head, { "Cache-Control": "no-store" });
  }
  if (method !== "GET" && !head) {
    return new Response("Method not allowed\n", {
      status: 405,
      headers: withSecurity({
        Allow: "GET, HEAD",
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      }),
    });
  }
  if (route.type === "redirect") return redirect(route.location);
  if (route.type === "chooser") return chooser(request, lang, head);
  if (route.type === "tool") return toolPage(request, ctx, route, head);
  if (route.type === "share") return sharePage(request, ctx, route, head);
  return htmlResponse(notFoundHtml(lang), 404, head, { "Cache-Control": "no-store" });
}

// Maps a request path to a route. Matching is done on the lower-cased path;
// when the canonical path differs from the one requested (case, a missing or
// extra slash, index.html, the | form), the answer is a 301 to the canonical
// path with the query string kept.
function resolve(url) {
  const raw = url.pathname;
  const p = raw.toLowerCase();
  const canonical = (route) =>
    route.path === raw ? route : { type: "redirect", location: route.path + url.search };
  let m;

  if (p === "/") return { type: "chooser", path: "/" };
  if (p === "/index.html") return { type: "redirect", location: "/" + url.search };

  if (p === "/cancer" || p === "/cancer/" || p === "/cancer/index.html") {
    return canonical({ type: "tool", tool: "cancer", path: "/cancer/" });
  }
  if (p === "/chronic" || p === "/chronic/" || p === "/chronic/index.html") {
    return canonical({ type: "tool", tool: "chronic", path: "/chronic/" });
  }

  // Share routes. Cancer slugs are lower-case ASCII with hyphens; chronic ids
  // are lower-case ASCII with underscores.
  if ((m = /^\/cancer\/([ec])\/([a-z0-9-]+)\/?$/.exec(p))) {
    return canonical({
      type: "share", tool: "cancer", kind: m[1], key: m[2], path: `/cancer/${m[1]}/${m[2]}`,
    });
  }
  if ((m = /^\/chronic\/([dr])\/([a-z0-9_]+)\/?$/.exec(p))) {
    return canonical({
      type: "share", tool: "chronic", kind: m[1], key: m[2], path: `/chronic/${m[1]}/${m[2]}`,
    });
  }
  if ((m = /^\/chronic\/l\/([a-z0-9_]+)(?:\/|\||%7c)([a-z0-9_]+)\/?$/.exec(p))) {
    return canonical({
      type: "share", tool: "chronic", kind: "l", key: `${m[1]}/${m[2]}`,
      path: `/chronic/l/${m[1]}/${m[2]}`,
    });
  }

  if (p === "/favicon.ico") return { type: "redirect", location: SITE + "/favicon.ico" };
  // The chronic tool's companion pages live on the site. Old relative links
  // pointed at these paths on the tools host.
  if ((m = /^\/chronic\/(references|framework|changelog)\.html$/.exec(p))) {
    return { type: "redirect", location: `${SITE}/chronic-disease-explorer/${m[1]}.html` };
  }

  return { type: "notfound" };
}

function pickLang(value) {
  if (!value) return null;
  const code = String(value).trim().toLowerCase().split(/[-_]/)[0];
  return LANGS.includes(code) ? code : null;
}

// ---------------------------------------------------------------------------
// Pages served from GitHub
// ---------------------------------------------------------------------------

async function toolPage(request, ctx, route, head) {
  const tool = TOOLS[route.tool];
  const up = await getUpstream(tool.upstream, ctx);
  if (!up.ok) return errorPage(request, 502);

  if (up.etag && ifNoneMatch(request, up.etag)) {
    discard(up.body);
    return notModified(up.etag, up.source);
  }
  if (head) discard(up.body);
  return new Response(head ? null : up.body, {
    status: 200,
    headers: pageHeaders(up.etag, up.source, PAGE_CACHE),
  });
}

async function sharePage(request, ctx, route, head) {
  const tool = TOOLS[route.tool];
  const [up, share] = await Promise.all([
    getUpstream(tool.upstream, ctx),
    getShareData(tool.share, ctx),
  ]);
  if (!up.ok) return errorPage(request, 502);

  const entry = share.data ? lookup(share.data, route.kind, route.key) : null;
  if (!entry) {
    if (head) discard(up.body);
    if (share.failed) {
      // The share file could not be fetched (or was cut short) and no copy
      // exists here: the unmodified page with status 503, so that a crawler
      // tries again later.
      return new Response(head ? null : up.body, {
        status: 503,
        headers: pageHeaders(null, up.source, "no-store", { "Retry-After": "60" }),
      });
    }
    // No share file yet, or no entry for this slug: the unmodified page with
    // status 404. The page's own script shows its not-found notice.
    return new Response(head ? null : up.body, {
      status: 404,
      headers: pageHeaders(null, up.source, "no-store"),
    });
  }

  const meta = shareMeta(tool, entry, route.path);
  // The suffix covers everything the rewrite puts into the head.
  const etag = up.etag
    ? withSuffix(up.etag, fnv1a([WORKER_REV, meta.title, meta.description || "", meta.url, meta.image].join("\n")))
    : null;

  if (etag && ifNoneMatch(request, etag)) {
    discard(up.body);
    return notModified(etag, up.source);
  }
  if (head) {
    discard(up.body);
    return new Response(null, { status: 200, headers: pageHeaders(etag, up.source, PAGE_CACHE) });
  }
  const body = await rewriteHead(up.body, meta);
  return new Response(body, { status: 200, headers: pageHeaders(etag, up.source, PAGE_CACHE) });
}

function lookup(data, kind, key) {
  const group = data[kind];
  if (!group || typeof group !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(group, key)) return null;
  const entry = group[key];
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.t !== "string" || !entry.t.trim()) return null;
  return entry;
}

// t is the page title and d the description, both in English. The tool name
// is added to the title when t does not already carry it.
function shareMeta(tool, entry, path) {
  let title = squash(entry.t, 200);
  if (!title.includes(tool.name)) title += " · " + tool.name;
  const description =
    typeof entry.d === "string" && entry.d.trim() ? squash(entry.d, 600) : null;
  return { title, description, url: ORIGIN + path, image: tool.image };
}

function squash(text, max) {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// The rewrite touches the head only. The page is read into memory, the head
// (tens of kilobytes at the start of a page of more than 2 MB) goes through
// HTMLRewriter, and the rest of the bytes are passed on unchanged. This keeps
// CPU time small.
async function rewriteHead(body, meta) {
  const bytes = body instanceof ArrayBuffer
    ? new Uint8Array(body)
    : new Uint8Array(await new Response(body).arrayBuffer());
  const end = findHeadEnd(bytes);
  if (end < 0) {
    console.warn("share route: no </head> in the first 1 MiB; page served unchanged");
    return bytes;
  }
  const headHtml = new TextDecoder().decode(bytes.subarray(0, end));
  const rewritten = await headRewriter(meta)
    .transform(new Response(headHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .text();
  return new Blob([rewritten, bytes.subarray(end)]);
}

// Index just after the first "</head>" (any case, optional spaces before ">").
function findHeadEnd(b) {
  const max = Math.min(b.length, HEAD_SCAN_LIMIT);
  for (let i = 0; i + 7 <= max; i++) {
    if (b[i] !== 0x3c || b[i + 1] !== 0x2f) continue; // "</"
    if ((b[i + 2] | 0x20) !== 0x68 || (b[i + 3] | 0x20) !== 0x65) continue; // "he"
    if ((b[i + 4] | 0x20) !== 0x61 || (b[i + 5] | 0x20) !== 0x64) continue; // "ad"
    let j = i + 6;
    while (j < max && (b[j] === 0x20 || b[j] === 0x09 || b[j] === 0x0a || b[j] === 0x0d)) j++;
    if (j < max && b[j] === 0x3e) return j + 1; // ">"
  }
  return -1;
}

// Sets the title, description, canonical link and share-card tags. Tags that
// the page lacks (today: the canonical link) are added before </head>.
// Meta and link tags are replaced whole with markup escaped here, because
// HTMLRewriter's setAttribute escapes double quotes only.
function headRewriter(meta) {
  const tags = {
    description: meta.description == null ? null : metaTag("name", "description", meta.description),
    "og:title": metaTag("property", "og:title", meta.title),
    "og:description": meta.description == null ? null : metaTag("property", "og:description", meta.description),
    "og:url": metaTag("property", "og:url", meta.url),
    "og:image": metaTag("property", "og:image", meta.image),
    "twitter:title": metaTag("name", "twitter:title", meta.title),
    "twitter:description":
      meta.description == null ? null : metaTag("name", "twitter:description", meta.description),
    "twitter:image": metaTag("name", "twitter:image", meta.image),
    canonical: `<link rel="canonical" href="${esc(meta.url)}">`,
  };
  // Added when the page lacks them. The twitter: tags are only updated,
  // because Twitter falls back to the og: tags.
  const required = ["description", "og:title", "og:description", "og:url", "og:image", "canonical"];
  const seen = new Set();
  const swap = (key) => ({
    element(el) {
      seen.add(key);
      if (tags[key] != null) el.replace(tags[key], { html: true });
    },
  });
  return new HTMLRewriter()
    .on("head > title", {
      element(el) {
        seen.add("title");
        el.setInnerContent(meta.title);
      },
    })
    .on('head > meta[name="description"]', swap("description"))
    .on('head > meta[property="og:title"]', swap("og:title"))
    .on('head > meta[property="og:description"]', swap("og:description"))
    .on('head > meta[property="og:url"]', swap("og:url"))
    .on('head > meta[property="og:image"]', swap("og:image"))
    .on('head > meta[name="twitter:title"]', swap("twitter:title"))
    .on('head > meta[name="twitter:description"]', swap("twitter:description"))
    .on('head > meta[name="twitter:image"]', swap("twitter:image"))
    .on('head > link[rel="canonical"]', swap("canonical"))
    .on("head", {
      element(el) {
        el.onEndTag((end) => {
          const add = [];
          if (!seen.has("title")) add.push(`<title>${esc(meta.title)}</title>`);
          for (const key of required) {
            if (!seen.has(key) && tags[key] != null) add.push(tags[key]);
          }
          if (add.length) end.before(add.join("\n") + "\n", { html: true });
        });
      },
    });
}

function metaTag(attr, name, value) {
  return `<meta ${attr}="${name}" content="${esc(value)}">`;
}

// ---------------------------------------------------------------------------
// Upstream files through the Cache API
// ---------------------------------------------------------------------------

// Returns { ok: true, body, etag, source } or { ok: false, missing, failed }.
// body is the complete file: a stream read from a fresh copy, or the bytes
// (an ArrayBuffer) on every other path. source is "hit" (fresh copy),
// "revalidated" (GitHub answered 304), "miss" (new copy from GitHub) or
// "stale" (GitHub failed; last good copy). missing is true when GitHub
// answered 404 for an optional file, now or at the last check that got
// through. failed is true when GitHub could not be reached, or sent a file
// that was not complete, and nothing usable is cached here.
//
// Only complete files are stored (see complete()). A transfer that is cut
// short, stalls or ends early counts as a failed check, so the last good copy
// (or the 502 page) is served, and a short body is never kept, never passed
// on and never confirmed by a later 304. Nothing is streamed from GitHub:
// the whole body is read first, then the copy and the answer are both made
// from that buffer.
async function getUpstream(name, ctx) {
  const src = UPSTREAM[name];
  const key = CACHE_PREFIX + name;
  const cache = caches.default;

  let cached;
  try {
    cached = await cache.match(key);
  } catch (err) {
    console.warn(`cache match ${name}: ${err}`);
  }
  const now = Date.now();
  if (cached) {
    const age = now - num(cached.headers.get("X-Fetched-At"));
    if (age >= 0 && age < FRESH_MS) return fromStored(cached, "hit");
  }

  // The copy is due for a check, or there is none. What is cached: a copy of
  // the file, a marker for a missing file, or a marker for a failed check.
  // The last one is only ever fresh, so here it counts as nothing.
  const kind = cached ? cached.headers.get("X-Upstream-Status") || "copy" : "none";
  const isMarker = kind === "404";
  // The copy's bytes are read now, because every path below that keeps the
  // copy stores it again from this buffer. A copy that cannot be read, or is
  // not complete, is dropped and counts as no copy.
  let copy = null;
  if (kind === "copy") {
    try {
      const bytes = await cached.arrayBuffer();
      if (complete(src, bytes)) copy = bytes;
      else console.warn(`cache ${name}: stored copy not complete, dropped`);
    } catch (err) {
      console.warn(`cache read ${name}: ${err}`);
    }
    if (!copy) keep(ctx, cache.delete(key), name);
  } else if (cached) {
    discard(cached.body);
  }
  const prevTag = copy ? cached.headers.get("ETag") : null;
  // When GitHub last confirmed the copy or the marker. The 7-day keep runs from here.
  const verifiedAt = copy || isMarker
    ? num(cached.headers.get("X-Verified-At")) || num(cached.headers.get("X-Fetched-At"))
    : 0;
  const reqHeaders = { "User-Agent": "epidetective-tools/2 (+https://tools.epidetective.com/)" };
  if (prevTag) reqHeaders["If-None-Match"] = prevTag;

  let res = null;
  try {
    // With a copy or a marker at hand, the wait for GitHub is short. So is
    // the wait for a share file, which a page can be served without.
    const wait = copy || isMarker || src.optional ? STALE_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;
    res = await fetchUpstream(src.url, reqHeaders, wait);
  } catch (err) {
    console.warn(`upstream ${name}: ${err}`);
  }

  if (res && res.status === 304 && copy) {
    // Unchanged on GitHub: keep the copy and restart its 5-minute clock.
    keep(ctx, cache.put(key, stored(copy, prevTag, now, now)), name);
    return { ok: true, body: copy, etag: prevTag, source: "revalidated" };
  }
  if (res && res.status === 200) {
    if (complete(src, res.bytes)) {
      keep(ctx, cache.put(key, stored(res.bytes, res.etag, now, now)), name);
      return { ok: true, body: res.bytes, etag: res.etag, source: "miss" };
    }
    console.warn(`upstream ${name}: body not complete (${res.bytes.byteLength} bytes), not stored`);
    res = null; // counts as a failed check
  }
  if (res && res.status === 404 && src.optional) {
    // The file is not published (yet). Remember that for 5 minutes.
    keep(ctx, cache.put(key, missingMarker(now, now)), name);
    return { ok: false, missing: true, failed: false };
  }

  // GitHub failed (error status, timeout, network error, or a body that was
  // not complete). Serve the last good copy or keep the marker, stored again
  // with its clock set so that the next check waits RETRY_MS. The 7-day keep
  // still counts from the last check that got through, so a copy is never
  // kept longer than that. An optional file with nothing cached gets a
  // failure marker for RETRY_MS, so that share routes answer at once while
  // GitHub is down.
  if (res) console.warn(`upstream ${name}: HTTP ${res.status}`);
  const keepLeft = verifiedAt ? KEEP_MS - (now - verifiedAt) : 0;
  const retryClock = now - FRESH_MS + RETRY_MS;
  if (copy) {
    if (keepLeft > RETRY_MS) {
      keep(ctx, cache.put(key, stored(copy, prevTag, retryClock, verifiedAt, { stale: true, keepMs: keepLeft })), name);
    }
    return { ok: true, body: copy, etag: prevTag, source: "stale" };
  }
  if (isMarker) {
    if (keepLeft > RETRY_MS) keep(ctx, cache.put(key, missingMarker(retryClock, verifiedAt, keepLeft)), name);
    return { ok: false, missing: true, failed: false };
  }
  if (src.optional) keep(ctx, cache.put(key, failedMarker(retryClock)), name);
  return { ok: false, missing: false, failed: true };
}

// Fetches an upstream file into memory. The wait for GitHub's headers is
// limited to headersMs; the body then has BODY_TIMEOUT_MS more, which is
// plenty for the pages and stops a stalled transfer from holding a visitor.
// Returns { status, etag, bytes }: bytes is the whole body of a 200 answer
// and null otherwise. Throws on a network error, a timeout, or a body that
// ends before GitHub said it would.
async function fetchUpstream(url, headers, headersMs) {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(new Error(`no answer in ${headersMs} ms`)), headersMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    clearTimeout(timer);
    const etag = res.headers.get("ETag");
    if (res.status !== 200) {
      discard(res.body);
      return { status: res.status, etag, bytes: null };
    }
    const read = res.arrayBuffer();
    read.catch(() => {});
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`body not complete in ${BODY_TIMEOUT_MS} ms`);
        ctl.abort(err);
        reject(err);
      }, BODY_TIMEOUT_MS);
    });
    const bytes = await Promise.race([read, limit]);
    return { status: 200, etag, bytes };
  } finally {
    clearTimeout(timer);
  }
}

// A page is complete when it ends with </html>; a share file when it parses
// as JSON. A transfer cut short fails both, so it is never stored or served.
function complete(src, bytes) {
  if (!bytes || !bytes.byteLength) return false;
  if (src.kind === "json") {
    try {
      JSON.parse(new TextDecoder().decode(bytes));
      return true;
    } catch (err) {
      return false;
    }
  }
  const tail = new Uint8Array(bytes, Math.max(0, bytes.byteLength - 64));
  return /<\/html\s*>\s*$/i.test(new TextDecoder().decode(tail));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fromStored(res, source) {
  const status = res.headers.get("X-Upstream-Status");
  if (status === "404") {
    discard(res.body);
    return { ok: false, missing: true, failed: false };
  }
  if (status === "failed") {
    discard(res.body);
    return { ok: false, missing: false, failed: true };
  }
  return {
    ok: true,
    body: res.body || emptyStream(),
    etag: res.headers.get("ETag"),
    // A copy stored again after a failed check keeps reporting "stale".
    source: res.headers.get("X-Stale") ? "stale" : source,
  };
}

// The stored copy. X-Fetched-At runs the 5-minute clock and X-Verified-At the
// 7-day keep (the entry's max-age). None of these headers reaches a visitor.
function stored(body, etag, fetchedAt, verifiedAt, opts) {
  const headers = cacheHeaders(fetchedAt, verifiedAt, opts && opts.keepMs);
  if (etag) headers.set("ETag", etag);
  if (opts && opts.stale) headers.set("X-Stale", "1");
  return new Response(body, { headers });
}

function missingMarker(fetchedAt, verifiedAt, keepMs) {
  const headers = cacheHeaders(fetchedAt, verifiedAt, keepMs);
  headers.set("X-Upstream-Status", "404");
  return new Response("", { headers });
}

// A failed check for an optional file with nothing cached, remembered for
// RETRY_MS (its clock is set so that it is fresh for exactly that long, and
// its max-age drops it at the same time).
function failedMarker(fetchedAt) {
  const headers = cacheHeaders(fetchedAt, 0, RETRY_MS);
  headers.set("X-Upstream-Status", "failed");
  return new Response("", { headers });
}

function cacheHeaders(fetchedAt, verifiedAt, keepMs) {
  const seconds = Math.max(1, Math.floor((keepMs || KEEP_MS) / 1000));
  return new Headers({
    "Cache-Control": `public, max-age=${seconds}`,
    "X-Fetched-At": String(fetchedAt),
    "X-Verified-At": String(verifiedAt),
  });
}

// Share data, parsed once per Worker instance and upstream version. Returns
// { data } with the parsed file, or { data: null, failed }: failed is true
// only when GitHub could not be reached, or sent a file that was not
// complete, and no copy exists here. A missing file, and a file that parses
// but has the wrong shape, both give data null with failed false.
const shareMemo = new Map();

async function getShareData(name, ctx) {
  const up = await getUpstream(name, ctx);
  if (!up.ok) return { data: null, failed: Boolean(up.failed) };
  const memo = shareMemo.get(name);
  if (memo && up.etag && memo.etag === up.etag) {
    discard(up.body);
    return { data: memo.data, failed: false };
  }
  let data = null;
  try {
    data = JSON.parse(await new Response(up.body).text());
  } catch (err) {
    console.warn(`share data ${name}: ${err}`);
    return { data: null, failed: false };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { data: null, failed: false };
  if (up.etag) shareMemo.set(name, { etag: up.etag, data });
  return { data, failed: false };
}

function keep(ctx, promise, name) {
  const p = promise.catch((err) => console.warn(`cache put ${name}: ${err}`));
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
}

function discard(body) {
  if (body && typeof body.cancel === "function") body.cancel().catch(() => {});
}

function emptyStream() {
  return new Response("").body || new ReadableStream({ start: (c) => c.close() });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function withSecurity(extra) {
  const headers = new Headers(SECURITY_HEADERS);
  for (const [k, v] of Object.entries(extra || {})) if (v != null) headers.set(k, v);
  return headers;
}

function pageHeaders(etag, source, cacheControl, extra) {
  return withSecurity({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": cacheControl,
    Vary: "Accept-Encoding",
    ETag: etag || null,
    "X-Edge-Cache": source || null,
    ...(extra || {}),
  });
}

function notModified(etag, source) {
  return new Response(null, {
    status: 304,
    headers: withSecurity({
      ETag: etag,
      "Cache-Control": PAGE_CACHE,
      Vary: "Accept-Encoding",
      "X-Edge-Cache": source || null,
    }),
  });
}

function redirect(location) {
  return new Response(null, {
    status: 301,
    headers: withSecurity({ Location: location, "Cache-Control": "public, max-age=3600" }),
  });
}

// Weak comparison, as RFC 9110 asks for If-None-Match: W/"x" matches "x".
function ifNoneMatch(request, etag) {
  const header = request.headers.get("If-None-Match");
  if (!header || !etag) return false;
  if (header.trim() === "*") return true;
  const want = opaqueTag(etag);
  return (header.match(/(?:W\/)?"[^"]*"/g) || []).some((tag) => opaqueTag(tag) === want);
}

function opaqueTag(tag) {
  return tag.trim().replace(/^W\//, "");
}

function withSuffix(etag, suffix) {
  const m = /^(W\/)?"([^"]*)"$/.exec(etag.trim());
  return m ? `${m[1] || ""}"${m[2]}-${suffix}"` : `"${etag.replace(/"/g, "")}-${suffix}"`;
}

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Pages made by the Worker: the chooser, the 404 and the error page
// ---------------------------------------------------------------------------

function htmlResponse(html, status, head, extra) {
  return new Response(head ? null : html, {
    status,
    headers: withSecurity({
      "Content-Type": "text/html; charset=utf-8",
      Vary: "Accept-Encoding",
      ...extra,
    }),
  });
}

const chooserTags = new Map();

function chooser(request, lang, head) {
  const html = chooserHtml(lang);
  const id = lang || "-";
  if (!chooserTags.has(id)) chooserTags.set(id, `"${WORKER_REV}-${fnv1a(html)}"`);
  const etag = chooserTags.get(id);
  if (ifNoneMatch(request, etag)) return notModified(etag, null);
  return htmlResponse(html, 200, head, { "Cache-Control": PAGE_CACHE, ETag: etag });
}

function errorPage(request, status) {
  const url = new URL(request.url);
  const head = request.method.toUpperCase() === "HEAD";
  const lang = pickLang(url.searchParams.get("lang"));
  // One leading slash only, so that "Try again" can never point at another host.
  const again = url.pathname.replace(/^\/+/, "/") + url.search;
  return htmlResponse(errorHtml(again, status, lang), status, head, {
    "Cache-Control": "no-store",
    "Retry-After": "60",
  });
}

function siteUrl(lang, page) {
  return SITE + (SITE_LANGS.includes(lang) ? `/${lang}/` : "/") + (page || "");
}

function toolUrl(tool, lang) {
  return TOOLS[tool].path + (lang ? `?lang=${lang}` : "");
}

// Texts of the pages this Worker makes itself, in the site's five languages.
// Reused from the site (design/i18n: nav_instruments, home_lede,
// meta_home_desc, nav_about, nav_contact, foot_tagline, inst_t1_btn_open, the
// first sentence of inst_t1_desc and inst_t2_desc) and from the tools (LANGS
// and T: gateTitle, gateWho, gateBack, staffLine). New here: choose, nf and
// err. Plain text, except "open", which carries the arrow entity. Those
// sources change with later batches, so this table is not edited by hand:
// review-2026-10-28/records/worker-fix2/scripts/build_strings.py rebuilds it
// from the current files (--check compares, --write pastes it in). DEPLOY.md
// asks for that check before every deploy.
const STRINGS = {
  "en": {
    "code": "en",
    "tools": "Tools",
    "choose": "Choose a tool",
    "lede": "EpiDetective builds free tools that let you explore published health research for yourself.",
    "desc": "A personal project by Wenxin Wan, a cancer epidemiologist: free tools to look up what published research says causes cancer and other chronic diseases, and how sure the evidence is. Cancer data: IARC Monographs.",
    "about": "About",
    "contact": "Contact",
    "tagline": "Open tools for reading health evidence.",
    "open": "Open it &rarr;",
    "who": "A personal project by Wenxin Wan.",
    "staff": "Wenxin Wan works at IARC. He alone is responsible for the views expressed here, which do not necessarily represent the decisions, policy or views of IARC or WHO.",
    "back": "Back to EpiDetective",
    "name": {
      "cancer": "Cancer Evidence Explorer",
      "chronic": "Chronic Disease Evidence Explorer"
    },
    "blurb": {
      "cancer": "See which exposures have been linked to which cancers, and how strong the evidence is behind each link.",
      "chronic": "Which risk factors have been linked to heart disease, stroke, type 2 diabetes, dementia and other major chronic conditions, and how strong the evidence is behind each link, including where studies disagree."
    },
    "data": {
      "cancer": "Data: IARC Monographs",
      "chronic": "Data: published reviews and meta-analyses"
    },
    "nf": {
      "title": "Page not found",
      "h1": "That page is not here.",
      "lede": "The link may be out of date, or the page may have moved. Both tools and the main site are one click away.",
      "desc": "This page is not on the EpiDetective tools site. Both tools are linked from here."
    },
    "err": {
      "title": "Tool not available",
      "h1": "The tool could not be loaded.",
      "lede": "It did not load just now. Please try again in a minute.",
      "again": "Try again",
      "desc": "The tool could not be loaded just now."
    }
  },
  "zh": {
    "code": "zh",
    "tools": "工具",
    "choose": "选择一个工具",
    "lede": "EpiDetective 开发免费工具，让你自己查阅已发表的健康研究",
    "desc": "癌症流行病学研究者万汶鑫的个人项目：免费工具，帮你查阅已发表的研究认为哪些因素会导致癌症和其他慢性病，以及证据有多可靠。癌症数据来自《IARC 致癌物专论》。",
    "about": "关于",
    "contact": "联系",
    "tagline": "读懂健康证据的公开工具。",
    "open": "打开 &rarr;",
    "who": "万汶鑫的个人项目。",
    "staff": "万汶鑫在 IARC 工作。这里表达的观点仅由他本人负责，不一定代表 IARC 或世界卫生组织（WHO）的决定、政策或观点。",
    "back": "返回 EpiDetective",
    "name": {
      "cancer": "癌症证据探索器",
      "chronic": "慢性病证据图谱"
    },
    "blurb": {
      "cancer": "查看哪些暴露因素与哪些癌症相关，以及支撑每条关联的证据有多强。",
      "chronic": "哪些危险因素与心脏病、卒中、2 型糖尿病、痴呆等主要慢性病有关，每条关联背后的证据有多强，研究结果不一致的地方也会标明。"
    },
    "data": {
      "cancer": "数据：《IARC 致癌物专论》",
      "chronic": "数据：已发表的综述和荟萃分析"
    },
    "nf": {
      "title": "找不到页面",
      "h1": "这里没有这个页面。",
      "lede": "链接可能已经过期，或者页面已经移动。两个工具和主站都只需点一下。",
      "desc": "EpiDetective 工具站上没有这个页面。这里有两个工具的链接。"
    },
    "err": {
      "title": "工具暂时无法使用",
      "h1": "工具未能加载。",
      "lede": "刚才没有加载成功。请过一分钟再试。",
      "again": "再试一次",
      "desc": "工具刚才未能加载。"
    }
  },
  "fr": {
    "code": "fr",
    "tools": "Outils",
    "choose": "Choisissez un outil",
    "lede": "EpiDetective conçoit des outils gratuits qui vous permettent d’explorer vous-même la recherche en santé déjà publiée.",
    "desc": "Un projet personnel de Wenxin Wan, épidémiologiste du cancer\u00a0: des outils gratuits pour consulter ce que la recherche publiée dit des causes du cancer et d’autres maladies chroniques, et la solidité des preuves. Données sur le cancer\u00a0: Monographies du CIRC.",
    "about": "À propos",
    "contact": "Contact",
    "tagline": "Des outils ouverts pour lire les preuves en santé.",
    "open": "Ouvrir &rarr;",
    "who": "Un projet personnel de Wenxin Wan.",
    "staff": "Wenxin Wan travaille au CIRC. Il est seul responsable des opinions exprimées ici, qui ne représentent pas nécessairement les décisions, la politique ou les vues du CIRC ou de l’OMS.",
    "back": "Retour à EpiDetective",
    "name": {
      "cancer": "Explorateur des preuves sur le cancer",
      "chronic": "Atlas des preuves — maladies chroniques"
    },
    "blurb": {
      "cancer": "Découvrez quelles expositions ont été associées à quels cancers, et quelle est la solidité des preuves derrière chaque lien.",
      "chronic": "Quels facteurs de risque ont été associés aux maladies cardiaques, aux AVC, au diabète de type 2, à la démence et à d’autres grandes maladies chroniques, et quelle est la solidité des preuves derrière chaque lien, y compris là où les études se contredisent."
    },
    "data": {
      "cancer": "Données\u00a0: Monographies du CIRC",
      "chronic": "Données\u00a0: revues et méta-analyses publiées"
    },
    "nf": {
      "title": "Page introuvable",
      "h1": "Cette page n’est pas ici.",
      "lede": "Le lien est peut-être périmé, ou la page a été déplacée. Les deux outils et le site principal sont à un clic.",
      "desc": "Cette page n’est pas sur le site des outils EpiDetective. Les deux outils sont accessibles d’ici."
    },
    "err": {
      "title": "Outil indisponible",
      "h1": "L’outil n’a pas pu être chargé.",
      "lede": "Il ne s’est pas chargé à l’instant. Réessayez dans une minute.",
      "again": "Réessayer",
      "desc": "L’outil n’a pas pu être chargé à l’instant."
    }
  },
  "es": {
    "code": "es",
    "tools": "Herramientas",
    "choose": "Elige una herramienta",
    "lede": "EpiDetective crea herramientas gratuitas que te permiten explorar por tu cuenta la investigación en salud ya publicada.",
    "desc": "Un proyecto personal de Wenxin Wan, epidemiólogo del cáncer: herramientas gratuitas para consultar qué dice la investigación publicada sobre las causas del cáncer y de otras enfermedades crónicas, y qué solidez tiene la evidencia. Datos sobre el cáncer: Monografías del CIIC.",
    "about": "Acerca de",
    "contact": "Contacto",
    "tagline": "Herramientas abiertas para leer la evidencia en salud.",
    "open": "Abrir &rarr;",
    "who": "Un proyecto personal de Wenxin Wan.",
    "staff": "Wenxin Wan trabaja en el CIIC. Él es el único responsable de las opiniones expresadas aquí, que no representan necesariamente las decisiones, las políticas ni las opiniones del CIIC ni de la OMS.",
    "back": "Volver a EpiDetective",
    "name": {
      "cancer": "Explorador de evidencia sobre el cáncer",
      "chronic": "Atlas de evidencia — enfermedades crónicas"
    },
    "blurb": {
      "cancer": "Consulta qué exposiciones se han vinculado a qué cánceres, y qué solidez tiene la evidencia detrás de cada vínculo.",
      "chronic": "Qué factores de riesgo se han vinculado con las enfermedades del corazón, el ictus, la diabetes tipo 2, la demencia y otras grandes enfermedades crónicas, y cuánta solidez tiene la evidencia de cada vínculo, incluso donde los estudios discrepan."
    },
    "data": {
      "cancer": "Datos: Monografías del CIIC",
      "chronic": "Datos: revisiones y metaanálisis publicados"
    },
    "nf": {
      "title": "Página no encontrada",
      "h1": "Esa página no está aquí.",
      "lede": "Puede que el enlace esté anticuado o que la página se haya movido. Las dos herramientas y el sitio principal están a un clic.",
      "desc": "Esta página no está en el sitio de herramientas de EpiDetective. Desde aquí se llega a las dos herramientas."
    },
    "err": {
      "title": "Herramienta no disponible",
      "h1": "No se pudo cargar la herramienta.",
      "lede": "No se ha cargado ahora mismo. Vuelve a intentarlo en un minuto.",
      "again": "Reintentar",
      "desc": "La herramienta no se pudo cargar ahora mismo."
    }
  },
  "ru": {
    "code": "ru",
    "tools": "Инструменты",
    "choose": "Выберите инструмент",
    "lede": "EpiDetective создаёт бесплатные инструменты, позволяющие самостоятельно изучать опубликованные исследования о здоровье.",
    "desc": "Личный проект Вэньсинь Вань, онкоэпидемиолога: бесплатные инструменты, которые показывают, что говорят опубликованные исследования о причинах рака и других хронических заболеваний и насколько прочна доказательная база. Данные о раке: Монографии МАИР.",
    "about": "Об авторе",
    "contact": "Контакты",
    "tagline": "Открытые инструменты для чтения научных данных о здоровье.",
    "open": "Открыть &rarr;",
    "who": "Личный проект Вэньсинь Вань.",
    "staff": "Вэньсинь Вань работает в МАИР. Он один несёт ответственность за изложенные здесь взгляды, которые не обязательно отражают решения, политику или позицию МАИР или ВОЗ.",
    "back": "Вернуться на EpiDetective",
    "name": {
      "cancer": "Атлас доказательств — рак",
      "chronic": "Атлас доказательств — хронические болезни"
    },
    "blurb": {
      "cancer": "Посмотрите, какие воздействия связаны с какими видами рака и насколько прочна доказательная база каждой связи.",
      "chronic": "Какие факторы риска связывают с болезнями сердца, инсультом, диабетом 2-го типа, деменцией и другими крупными хроническими болезнями, насколько надёжны доказательства для каждой связи и где исследования расходятся."
    },
    "data": {
      "cancer": "Данные: Монографии МАИР",
      "chronic": "Данные: опубликованные обзоры и метаанализы"
    },
    "nf": {
      "title": "Страница не найдена",
      "h1": "Этой страницы здесь нет.",
      "lede": "Возможно, ссылка устарела или страница переехала. Оба инструмента и основной сайт открываются в один клик.",
      "desc": "Этой страницы нет на сайте инструментов EpiDetective. Отсюда можно перейти к обоим инструментам."
    },
    "err": {
      "title": "Инструмент недоступен",
      "h1": "Не удалось загрузить инструмент.",
      "lede": "Сейчас он не загрузился. Попробуйте снова через минуту.",
      "again": "Попробовать снова",
      "desc": "Инструмент сейчас не удалось загрузить."
    }
  }
};

function strings(lang) {
  return STRINGS[lang] || STRINGS.en;
}

const CSS = `
@font-face{font-family:"Literata";src:url(${SITE}/assets/literata-latin.woff2) format("woff2");font-weight:400 800;font-style:normal;font-display:swap}
@font-face{font-family:"Literata";src:url(${SITE}/assets/literata-latin-italic.woff2) format("woff2");font-weight:400 800;font-style:italic;font-display:swap}
@font-face{font-family:"PlexMono";src:url(${SITE}/assets/plexmono-600.woff2) format("woff2");font-weight:600;font-style:normal;font-display:swap}
:root{--chalk:#F5F4F0;--ink:#161713;--ink-soft:#454740;--ink-faint:#666B62;--rule:rgba(22,23,19,.14);
--display:"Literata",Georgia,serif;--body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,sans-serif;
--mono:"PlexMono",ui-monospace,SFMono-Regular,Menlo,monospace;--pad:clamp(16px,5vw,56px)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--chalk);color:var(--ink);font-family:var(--body);font-size:clamp(15.5px,1vw,17px);line-height:1.6;-webkit-font-smoothing:antialiased;
min-height:100vh;min-height:100dvh;display:flex;flex-direction:column}
a{color:inherit}
:focus-visible{outline:2px solid var(--ink);outline-offset:4px}
.wrap{max-width:1180px;margin-inline:auto;padding-inline:var(--pad)}
.strip{background:var(--ink);color:#E8D48B;text-align:center;font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:7px 14px;line-height:17px}
.strip .nw{white-space:nowrap}
.top{border-bottom:1px solid var(--rule)}
.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:4px 20px;flex-wrap:wrap;padding-block:10px}
.mark{font-family:var(--display);font-size:1.18rem;font-weight:700;letter-spacing:-.01em;text-decoration:none}
.mark span{font-weight:450;font-style:italic}
.top .mark{display:inline-block;padding-block:8px}
.menu{display:flex;gap:0 22px;flex-wrap:wrap}
.menu a{display:inline-block;text-decoration:none;font-size:.95rem;font-weight:500;color:var(--ink-soft);padding-block:10px 8px;border-bottom:1.5px solid transparent}
.menu a:hover{color:var(--ink);border-bottom-color:var(--ink)}
main{flex:1 0 auto;width:100%;padding-block:clamp(44px,9vh,104px)}
.label{font-family:var(--mono);font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;font-weight:600;color:var(--ink-faint)}
h1,h2{font-family:var(--display);font-weight:400;letter-spacing:-.012em;margin:0}
h1{font-size:clamp(1.6rem,3.2vw,2.5rem);line-height:1.12;margin:14px 0 16px;max-width:27ch}
h2{font-size:clamp(1.15rem,1.9vw,1.4rem);line-height:1.25;font-weight:600}
.lede{color:var(--ink-soft);max-width:58ch;margin:0}
.tools{display:grid;gap:18px;margin-top:34px}
@media (min-width:760px){.tools{grid-template-columns:1fr 1fr}}
.tool{position:relative;background:#fff;border:1px solid var(--rule);padding:22px 22px 20px;display:grid;gap:10px;align-content:start}
.tool:hover,.tool:focus-within{border-color:var(--ink)}
.tool h2 a{text-decoration:none}
.tool h2 a::after{content:"";position:absolute;inset:0}
.tool p{margin:0;color:var(--ink-soft)}
.tool .src{font-family:var(--mono);font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-faint)}
.tool .go{font-weight:600;font-size:.95rem;margin-top:4px}
.who{margin:36px 0 0;max-width:62ch;font-weight:600}
.fine{margin:6px 0 0;max-width:62ch;color:var(--ink-soft);font-size:.92rem}
.onward{margin:12px 0 0}
.onward a{display:inline-block;padding-block:10px;font-weight:600;text-underline-offset:3px}
.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:30px}
.btn{display:inline-flex;align-items:center;max-width:100%;min-height:44px;text-decoration:none;padding:11px 20px;font-weight:600;font-size:.95rem;border:1px solid var(--ink)}
.btn-solid{background:var(--ink);color:var(--chalk)}
.btn-solid:hover{background:var(--ink-soft);border-color:var(--ink-soft)}
.btn-ghost{background:transparent;color:var(--ink);border-color:var(--rule)}
.btn-ghost:hover{border-color:var(--ink)}
.foot{background:var(--ink);color:var(--chalk)}
.foot .wrap{padding-block:38px 32px;display:flex;justify-content:space-between;gap:16px 28px;flex-wrap:wrap;align-items:baseline}
.foot .mark{color:var(--chalk);font-size:1.3rem}
.foot p{color:#A7ADA2;margin:6px 0 0;max-width:42ch}
.foot .menu a{color:#A7ADA2}
.foot .menu a:hover{color:var(--chalk);border-bottom-color:var(--chalk)}
`.trim();

function shell({ title, description, lang, strip, main }) {
  const S = strings(lang);
  const home = siteUrl(lang, "");
  return `<!doctype html>
<html lang="${S.code}" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="${SITE}/favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="${SITE}/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="${SITE}/apple-touch-icon.png">
<style>
${CSS}
</style>
</head>
<body>
${strip ? `<div class="strip"><span lang="en">Preview · under scientific revision</span> — <span lang="zh" class="nw">预览版 · 科学内容审校中</span></div>\n` : ""}<header class="top">
<div class="wrap">
<a class="mark" href="${home}">Epi<span>Detective</span></a>
<nav class="menu" aria-label="EpiDetective">
<a href="${siteUrl(lang, "about.html")}">${S.about}</a>
<a href="${siteUrl(lang, "about.html#contact")}">${S.contact}</a>
</nav>
</div>
</header>
<main class="wrap">
${main}
</main>
<footer class="foot">
<div class="wrap">
<div>
<div class="mark">Epi<span>Detective</span></div>
<p>${S.tagline}</p>
</div>
<nav class="menu" aria-label="${esc(S.tools)}">
<a href="${toolUrl("cancer", lang)}">${S.name.cancer}</a>
<a href="${toolUrl("chronic", lang)}">${S.name.chronic}</a>
<a href="${home}">epidetective.com</a>
</nav>
</div>
</footer>
</body>
</html>
`;
}

function chooserHtml(lang) {
  const S = strings(lang);
  return shell({
    title: `${S.tools} · EpiDetective`,
    description: S.desc,
    lang,
    strip: true,
    main: `<div class="label">${S.tools}</div>
<h1>${S.choose}</h1>
<p class="lede">${S.lede}</p>
<div class="tools">
<section class="tool">
<h2><a href="${toolUrl("cancer", lang)}">${S.name.cancer}</a></h2>
<p>${S.blurb.cancer}</p>
<p class="src">${S.data.cancer}</p>
<p class="go" aria-hidden="true">${S.open}</p>
</section>
<section class="tool">
<h2><a href="${toolUrl("chronic", lang)}">${S.name.chronic}</a></h2>
<p>${S.blurb.chronic}</p>
<p class="src">${S.data.chronic}</p>
<p class="go" aria-hidden="true">${S.open}</p>
</section>
</div>
<p class="who">${S.who}</p>
<p class="fine">${S.staff}</p>
<p class="onward"><a href="${siteUrl(lang, "")}">${S.back} &rarr;</a></p>`,
  });
}

function notFoundHtml(lang) {
  const S = strings(lang);
  return shell({
    title: `${S.nf.title} · EpiDetective`,
    description: S.nf.desc,
    lang,
    strip: false,
    main: `<div class="label">404</div>
<h1>${S.nf.h1}</h1>
<p class="lede">${S.nf.lede}</p>
<div class="actions">
<a class="btn btn-solid" href="${toolUrl("cancer", lang)}">${S.name.cancer}</a>
<a class="btn btn-solid" href="${toolUrl("chronic", lang)}">${S.name.chronic}</a>
<a class="btn btn-ghost" href="${siteUrl(lang, "")}">${S.back}</a>
</div>`,
  });
}

function errorHtml(path, status, lang) {
  const S = strings(lang);
  return shell({
    title: `${S.err.title} · EpiDetective`,
    description: S.err.desc,
    lang,
    strip: false,
    main: `<div class="label">${status === 502 ? "502" : "Error"}</div>
<h1>${S.err.h1}</h1>
<p class="lede">${S.err.lede}</p>
<div class="actions">
<a class="btn btn-solid" href="${esc(path)}">${S.err.again}</a>
<a class="btn btn-ghost" href="${siteUrl(lang, "")}">${S.back}</a>
</div>`,
  });
}
