# Route test cases for worker.js

Run on 30 October 2026 (fix round 2) with `wrangler dev --local` (wrangler 4.156.0, no login; workerd with the real HTMLRewriter and Cache API). **Result: 26 of 26 cases pass (183 checks).** The verifier's extra cases (19 groups, 219 checks, 248 requests), the verifier's round-2 cases (13 groups, 92 checks, 78 requests) and the burst and abort stress test pass on the same build. See "Extra checks".

Two local instances ran the unmodified `worker.js`:

- **Live** (cases 1 to 17). The upstream is the real raw.githubusercontent.com. The share files are not published yet, so the share routes show the "file missing" behaviour.
- **Fixture** (cases 18 to 26). The same `worker.js`, imported by a small test wrapper that sends its GitHub requests to a local stand-in server. The stand-in holds copies of both tool pages and test share files, gives sha256 ETags, answers `If-None-Match` with 304, and can be switched off, made to hang (it then never answers), made to cut a transfer short (headers and N bytes, then the connection is dropped) or made to stall it (N bytes, then nothing until released). The wrapper can also move the Worker's clock forward, clear its cache (all entries or one) and show what is stored under a key.

Every response must carry the five security headers:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: frame-ancestors 'self'
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

Pages served from GitHub also carry `Cache-Control: public, max-age=300, stale-while-revalidate=86400` and `Vary: Accept-Encoding`.

## Cases

| # | Request | Expected | Check |
|---|---|---|---|
| 1 | `GET /` | 200 | Chooser in English (`<html lang="en">`, "Choose a tool"). The strip reads "Preview · under scientific revision — 预览版 · 科学内容审校中" as plain text; "A personal project by Wenxin Wan."; the cards link to `/cancer/` and `/chronic/`; the link "Back to EpiDetective" goes to `https://epidetective.com/`; `noindex`; security headers; an ETag, and that ETag in `If-None-Match` gives 304. |
| 2 | `GET /?lang=fr` | 200 | The page is French (`lang="fr"`, "Choisissez un outil", "Explorateur des preuves sur le cancer", "Un projet personnel de Wenxin Wan.", the French staff line) and the strip is unchanged; the cards link to `/cancer/?lang=fr` and `/chronic/?lang=fr`; the site and About links go to `https://epidetective.com/fr/`; the ETag differs from the English chooser. |
| 3 | `GET /?lang=xx`, `/?lang=pt-BR`, `/?lang=zh`, `/?lang=es`, `/?lang=ru` | 200 | No `?lang=` for an unknown code. `pt-BR` becomes `?lang=pt`, the page stays English and the site link stays `https://epidetective.com/` (the site has no Portuguese pages). zh, es and ru give the page in that language, with `?lang=` on the cards and the site link under `/zh/`, `/es/` or `/ru/`. |
| 4 | `GET /cancer`, `GET /chronic` | 301 | `Location: /cancer/` and `/chronic/`; security headers. |
| 5 | `GET /chronic?lang=zh`, `GET /cancer?lang=fr&q=coffee` | 301 | Query kept: `/chronic/?lang=zh`, `/cancer/?lang=fr&q=coffee`. |
| 6 | `GET /Cancer/`, `/CHRONIC`, `/Cancer/E/Aspartame` | 301 | One hop to `/cancer/`, `/chronic/`, `/cancer/e/aspartame`. |
| 7 | `GET /cancer/index.html`, `/chronic/index.html`, `/index.html` | 301 | To `/cancer/`, `/chronic/`, `/`. |
| 8 | `GET /cancer/` | 200 | `text/html; charset=utf-8`; body byte-identical to the raw `index.html`; the ETag is GitHub's; Cache-Control, Vary and security headers; no Set-Cookie. |
| 9 | `GET /chronic/` | 200 | Body byte-identical to the raw `chronic/index.html` of the deploy repo; ETag; security headers. |
| 10 | `GET /cancer/` with `If-None-Match` | 304 or 200 | The same tag: 304, empty body, the same ETag, security headers. The tag with `W/` toggled, inside a list: 304. `*`: 304. Another tag: 200 with the full page. |
| 11 | `HEAD /cancer/` | 200 | The ETag, no body. |
| 12 | `GET /cancer/e/aspartame` (no share file upstream) | 404 | Body byte-identical to the plain page; `Cache-Control: no-store`; no ETag. |
| 13 | `GET /chronic/d/stroke_isch`, `/chronic/r/smoking`, `/chronic/l/smoking/copd` (no share file) | 404 | The unmodified chronic page. |
| 14 | `GET /favicon.ico`, `/chronic/references.html`, `/chronic/changelog.html` | 301 | To `https://epidetective.com/favicon.ico` and to the same pages under `https://epidetective.com/chronic-disease-explorer/`. |
| 15 | `GET /admin`, `/admin/status`, `/login`, `/logout`, `/join`, `/waitlist.csv`; `POST /login`, `/join`, `/admin/status` | 404 | The HTML 404 page, `Cache-Control: no-store`, no Set-Cookie, no form, links to `/cancer/`, `/chronic/` and `https://epidetective.com/`, security headers. |
| 16 | `GET /robots.txt`, `/cancer/foo`, `/cancer/e/`, `/chronic/x/y`, `/wp-login.php`, `/cancer/e/aspartame/extra`; `GET /admin?lang=zh`, `/nothing?lang=ru`, `/nothing?lang=pt`; `HEAD /nothing` | 404 | "That page is not here."; with `?lang=zh` the page is Chinese ("这里没有这个页面。"), the tool links carry `?lang=zh` and the site link goes to `/zh/`; `?lang=ru` gives the Russian page; `?lang=pt` gives the English page with `?lang=pt` on the tool links; HEAD has no body. |
| 17 | `POST /cancer/`, `PUT /`, `DELETE /chronic/d/stroke_isch` | 405 | `Allow: GET, HEAD`. |
| 18 | `GET /cancer/e/aspartame` (fixture share file) | 200 | `<title>`, meta description, `og:title` and `og:description` from the entry, with " · Cancer Evidence Explorer" added to the title; `og:url` and canonical `https://tools.epidetective.com/cancer/e/aspartame` (the canonical link is added, because the page has none yet); `og:image` `https://epidetective.com/assets/og/cancer.png`; one title and one canonical; every byte after `</head>` unchanged; ETag = the page's ETag plus a suffix; security headers. |
| 19 | The same route with `If-None-Match`; `HEAD` | 304 or 200 | Its own ETag: 304. The plain page's ETag: 200. Another entry's ETag: 200. HEAD: 200, the same ETag, no body. |
| 20 | `GET /cancer/c/lung`, `/cancer/e/tobacco-smoking`, `/cancer/e/radon-222-its-decay-products`, `/cancer/e/no-title` | 200 or 404 | The cancer route works; a title that already names the tool is not doubled; `&`, `"`, `<`, `>` and `'` are escaped in the title text and in the attributes; an entry without `t` gives 404 with the unmodified page. |
| 21 | `GET /chronic/d/stroke_isch`, `/chronic/r/smoking` | 200 | The title gets " · Chronic Disease Evidence Explorer"; `og:image` `chronic.png`; `og:url` and canonical; every byte after `</head>` unchanged. |
| 22 | `GET /chronic/l/smoking/copd`; `/chronic/l/smoking\|copd`, `/chronic/l/smoking%7Ccopd`, `/Chronic/L/Smoking/COPD/`, `/chronic/l/smoking%7ccopd?lang=fr` | 200 or 301 | The link route is rewritten (`og:url` ends `/chronic/l/smoking/copd`); the bar forms, upper case and the trailing slash get a 301 to `/chronic/l/smoking/copd`, query kept. |
| 23 | `GET /cancer/e/no-such-agent`, `/chronic/d/nope`, `/chronic/d/constructor` | 404 | The unmodified page with `no-store`; a JavaScript prototype name finds no entry. |
| 24 | `GET /cancer/` at 0, 0, 4 and 6 minutes, then once more | 200 | `X-Edge-Cache`: miss, hit, hit, revalidated, hit. The stand-in saw one full request, then one conditional request (`If-None-Match` = the ETag) that it answered with 304; the bodies are identical. |
| 25 | Stand-in off, clock 10 minutes on: `/cancer/` three times (at once, at once, after another 61 s), then `/cancer/e/aspartame`; the share copy cleared: `/cancer/e/aspartame` (GET and HEAD). Stand-in hanging: `/cancer/` with a copy, then with the cache cleared. Cache cleared, stand-in off: `/cancer/`, `/chronic/d/stroke_isch`. Stand-in back on: `/cancer/` | 200, 503, 502, 200 | The last good copy is served (`X-Edge-Cache: stale`) and no internal header (`X-Fetched-At`, `X-Verified-At`, `X-Stale`, `X-Upstream-Status`) leaks. The second request is served from the copy without asking the stand-in again (one request in its log); after 61 s the stand-in is asked once more (two). The share route is still rewritten from the stale copies. With the share copy gone: 503 with the plain page, `no-store`, `Retry-After: 60`, no ETag, security headers; HEAD gives 503 without a body. With the stand-in hanging: the copy is served after about 3 seconds (bounds 2.5 to 7 s) and the next request at once (under 1.5 s); with no copy, 502 after about 10 seconds (bounds 9.5 to 16 s). With no copy and the stand-in off: the HTML 502 page, `no-store`, `Retry-After: 60`, security headers, also on the share route. With the stand-in back: a fresh miss. |
| 26 | Cache cleared, the stand-in cutting the page after 100,000 bytes: `/cancer/e/aspartame`, then `/cancer/?lang=ru`; the whole transfer again: `/cancer/`. A changed page cut after 100,000 bytes during a check (clock 6 minutes on): `/cancer/` twice, then after 61 s with the whole transfer, then the original file again. The share file cut after 400 bytes with its copy cleared: `/cancer/e/aspartame` at once, at once again, after 61 s. A changed chronic page that stalls after 50,000 bytes during a check: `/chronic/` twice; the same with no copy. Stand-in hanging, page copy fresh, no share copy: `/cancer/e/aspartame` twice. | 502, 200, 503 | A page cut short is never stored (`/__test/peek` finds no entry) and never served: with no copy the 502 page (complete, in Russian with `?lang=ru`); with a copy at hand the full old page as `stale` with its old ETag, served again at once without asking the stand-in, and the changed page after the minute. The share file cut short is never stored: 503 with the plain page, `no-store`, `Retry-After: 60`; a failure marker answers the next visit at once (the stand-in sees one request), and after the minute the entry's own title, with the full share file stored. A stalled body gives the old page (`stale`) after the 15-second body limit (bounds 14 to 25 s), the full copy still stored and the next request at once; with no copy, 502 after the limit, nothing stored, and a fresh miss after release. With the stand-in hanging and no share copy: 503 after about 3 s (bounds 2.5 to 7 s), then 503 at once from the failure marker. |

## Extra checks

- **The verifier's cases** (`records/worker-fix2/scripts/extra-tests.mjs`, adjusted for the new link text, the two new internal headers and the 503 for broken share JSON): 19 groups, 219 checks, 248 requests, all pass. They cover path traversal, encoded and injected query strings, HEAD on 11 routes, five methods on 8 routes, 8,000-character paths, upper-case slugs, the bar form, empty slugs, `?lang=` variants, the rewrite on the Batch 2 builds, adversarial share entries, weak upstream ETags, a changed entry, a missing share file, cache integrity after HEAD and 304, a page missing upstream, broken share JSON, and the five headers on all 248 responses.
- **The verifier's round-2 cases** (`records/worker-fix2/scripts/round2-tests.mjs`, run against the fixture instance and its stand-in): 13 groups, 92 checks, 78 requests, all pass. They cover the back-off, the `X-Stale` life cycle, the edge of the 7-day keep, a marker during a failure, the 503 share answer, a connection dropped mid-body, a stalled body, the 502 page in five languages, 34 more route cases and a header sweep. Its G3 "changed file" now puts the change before `</html>`, because a page with anything after `</html>` is not complete to the Worker.
- **Load and aborts.** A burst of 30 requests on a cold cache and 5 clients that disconnect after the first chunk: every page complete, the stored copy never truncated. A GET right after a cold HEAD or 304 finds the complete copy within 50 ms.
- **Revalidation against the real GitHub** (clock-only wrapper): miss, hit, revalidated after a 6-minute clock jump (GitHub answered the Worker's `If-None-Match` with 304), hit; the body equals `deploy/chronic/index.html`.
- **The real `wrangler.toml`.** `npx wrangler deploy --dry-run` builds it with "No bindings found" (47.99 KiB, 13.60 KiB gzipped), and wrangler's `unstable_readConfig` reads name, main, compatibility date, one route, `workers_dev = false` and no bindings.
- **Rendering.** The chooser and the 404 page in English, Chinese, French, Spanish and Russian, and the 502 page in English and French, in Chrome at 320, 390, 768 and 1280 px: every page fits the window width, every link and button is at least 24 px in both directions, the site fonts load from epidetective.com, the lowest contrast is 4.96:1, and the only console message is the browser's note of the page's own 404 or 502 status. A `#fragment` survives the 301s.
- **HTML validation.** The same twelve pages plus the 500 page (English and Russian, from an export shim): 0 errors and 0 warnings on validator.w3.org, checker 26.10.18.

## How to run them again

The harness (stand-in server, wrappers, configs and the runner) is saved outside the deploy repo, so that it never ships with the Worker:

- `review-2026-10-28/records/worker-fix2/harness/` holds the version that ran above: `run-all.sh`, `run-tests.mjs`, `fixture-server.mjs`, `fixture-entry.js`, `fixture.toml`, `live.toml`, `live-clock.toml`, `live-clock-entry.js`, `wait-ports.mjs`, `reval.mjs` and the test share files. The two page fixtures are byte copies of `deploy/index.html` and `deploy/chronic/index.html`, which `run-all.sh` copies in (see `fixtures/README.txt`).
- `review-2026-10-28/records/worker-fix2/scripts/` holds the verifier's suites (`extra-tests.mjs`, `round2-tests.mjs`) with their stand-in, the stress, render and validator scripts, and `build_strings.py`, which regenerates the `STRINGS` table of `worker.js` from the site and tool files; `records/verify-worker/` holds the verifier's originals.

Wrangler writes a `.wrangler/` folder into the folder it runs from, so nothing runs inside the repos. `run-all.sh` copies the harness into a new temp folder (or the folder named as its argument), copies the two page fixtures in, changes into that folder, starts the stand-in and the two wrangler instances one after the other (two started at the same moment clash on a socket), waits until every port answers, and only then runs the cases:

```sh
bash /Users/wenxin/Claude/Code/IARC_monograph/review-2026-10-28/records/worker-fix2/harness/run-all.sh          # 26 cases, about 3 minutes; cases 1 to 17 need internet
KEEP=1 bash /Users/wenxin/Claude/Code/IARC_monograph/review-2026-10-28/records/worker-fix2/harness/run-all.sh   # the same, with the servers left up for checks by hand
```

It prints the working folder first and, without `KEEP=1`, stops the servers at the end. `live.toml` and `fixture-entry.js` name `deploy/worker/worker.js` by its absolute path on this Mac, so the instances always run the file in the repo.

A few of the live cases by hand, against the live instance (`B=http://127.0.0.1:8797`) or, once deployed, against `B=https://tools.epidetective.com`:

```sh
curl -s -o /dev/null -w '%{http_code}\n' $B/                                          # 1: 200
curl -s "$B/?lang=fr" | grep -q 'href="/cancer/?lang=fr"' && echo ok                  # 2: ok (the link appears twice: card and footer)
curl -s "$B/?lang=fr" | grep -c '<html lang="fr"'                                     # 2: 1
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $B/CHRONIC                   # 6: 301 .../chronic/
curl -sI $B/cancer/ | grep -iE '^(etag|cache-control|vary)'                           # 8
E=$(curl -sI $B/cancer/ | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $E" $B/cancer/            # 10: 304
curl -s -o /dev/null -w '%{http_code}\n' $B/cancer/e/aspartame                        # 12: 404 until Batch 5, then 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/login                             # 15: 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/cancer/                           # 17: 405
```

Once Batch 5 has published the share files, cases 18 to 23 can also run against the live upstream with real slugs.
