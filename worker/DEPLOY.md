# Deploying the tools Worker

`worker.js` is the new Cloudflare Worker for tools.epidetective.com, drafted on 28 October 2026 (Batch 8 of `review-2026-10-28/PLAN-2026-10-28.md`). Nothing changes on the live site until you deploy it. The Worker running today is kept here as `legacy-2026-09-10.js`, a copy of the dashboard source taken on 28 October 2026 (it holds no secrets).

What the new Worker changes, compared with today:

- The tool pages are kept at Cloudflare's edge: 5 minutes fresh, then a cheap check with GitHub. A last good copy is kept for 7 days and used when GitHub fails or sends a file that is not complete.
- Pages carry an ETag, so a returning browser gets a short 304 answer and reuses the 2 MB page it already holds.
- Share links get their own title and preview card (`/cancer/e/aspartame` and so on), once the share files of Batch 5 are published.
- `/` shows a small page that links to both tools, in English, Chinese, French, Spanish or Russian when `?lang=` says so. (Today it opens the chronic tool.)
- The old sign-in gate, waiting list and `/admin` are gone; those paths and every unknown path show an HTML "page not found" with links to both tools, in the same five languages.
- `/Cancer`, `/cancer` and `/cancer/index.html` lead to `/cancer/`; `/favicon.ico` leads to the site icon.
- Every response carries the security headers (HSTS, nosniff, referrer policy, `frame-ancestors 'self'`, permissions policy).
- The chronic page comes from the deploy repo (`chronic/index.html`). Today the Worker reads the site repo's copy; the two files are identical.

## 1. Before you deploy

1. **Export the waiting list.** The new Worker has no `/admin` and no `/waitlist.csv`. While the old Worker is still live, either:
   - open https://tools.epidetective.com/admin, sign in and press "Download CSV"; or
   - in the dashboard, open Storage & Databases → D1 → the waiting-list database → Console, run `SELECT * FROM waitlist;` and export the result; or
   - run `npx wrangler d1 export <database-name> --remote --output waitlist.sql`.

   Keep the file outside both repos. It holds names and email addresses.
2. **Check the share images.** Share routes point their card at `https://epidetective.com/assets/og/cancer.png` and `chronic.png`, which Batch 6 adds. Both commands below must print 200 before you deploy. On 28 October 2026 they printed 404.

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://epidetective.com/assets/og/cancer.png
   curl -s -o /dev/null -w '%{http_code}\n' https://epidetective.com/assets/og/chronic.png
   ```
3. **Share files.** Until Batch 5 publishes `share/cancer.json` and `share/chronic.json` in the deploy repo, every share route answers 404 with the plain tool page. That is safe: the page still opens, and its own script shows its not-found notice.
4. **Re-sync the reused texts.** The chooser, the 404 page and the error page reuse texts from the site (`design/i18n`) and from the two tools (`app/app_template.html`, `app/chronic_template.html`), and later batches change those. The `STRINGS` table in `worker.js` is generated from the current files by the script below. Run the check; it prints `STRINGS up to date` or lists every value that differs:

   ```sh
   python3 /Users/wenxin/Claude/Code/IARC_monograph/review-2026-10-28/records/worker-fix2/scripts/build_strings.py --check
   python3 /Users/wenxin/Claude/Code/IARC_monograph/review-2026-10-28/records/worker-fix2/scripts/build_strings.py --write   # when the check lists differences
   ```

   After a `--write`, run the cases in `ROUTES-TEST.md` again. The texts that are new to the Worker ("Choose a tool", the 404 and error texts) live in the generator's `NEW` table.

## 2. Deploy

Use one of the two paths.

**A. Dashboard.** Workers & Pages → `epidetective-tools` → Edit code. Select everything in the editor, paste the whole of `worker.js`, then press Deploy. The dashboard keeps the Worker's bindings and secrets until you remove them (section 5). Its preview pane does not use the Cache API, so test on the real host after deploying.

**B. Wrangler.** From this folder:

```sh
npx wrangler login
npx wrangler deploy
```

- Open Settings → Domains & Routes for `epidetective-tools` first. If tools.epidetective.com is listed there as a Custom Domain, switch to the `custom_domain` line in `wrangler.toml` before deploying.
- `wrangler deploy` removes the old bindings (the D1 waiting list and the email sender), because `wrangler.toml` declares none. That is why step 1 comes first. It keeps the secrets.
- Wrangler writes a `.wrangler/` folder here. Do not commit it; or deploy from a copy of this folder outside the repo.
- The code needs no recent compatibility flags. The dashboard path keeps the Worker's current compatibility date; the wrangler path sets 2026-10-01.

## 3. Checks after deploying

```sh
H=https://tools.epidetective.com

# Page, headers and cache state. Expect 200, an ETag, the five security headers,
# Cache-Control "public, max-age=300, stale-while-revalidate=86400"
# and X-Edge-Cache "miss", "hit" or "revalidated".
curl -sI $H/cancer/ | grep -iE '^(HTTP|etag|cache-control|vary|x-edge-cache|strict-transport-security|x-content-type-options|referrer-policy|content-security-policy|permissions-policy)'

# A request with the ETag returns 304.
E=$(curl -sI $H/cancer/ | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $E" $H/cancer/      # 304

# A crawler sees the entry's own card on a share route.
# After Batch 5: 200 and the Aspartame title. Before Batch 5: 404 and the plain page.
curl -s -o /dev/null -w '%{http_code}\n' -A 'Twitterbot/1.0' $H/cancer/e/aspartame
curl -s -A 'Twitterbot/1.0' $H/cancer/e/aspartame | grep -E '<title>|og:title|og:url|og:image|rel="canonical"' | head

# The old gate is gone.
curl -s -o /dev/null -w '%{http_code}\n' $H/admin                                # 404

# The chooser, and the language it passes on.
curl -s $H/ | grep -q 'A personal project by Wenxin Wan' && echo ok            # ok
curl -s "$H/?lang=fr" | grep -o 'href="/cancer/?lang=fr"'

# Redirects.
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $H/Cancer               # 301 .../cancer/
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $H/favicon.ico          # 301 https://epidetective.com/favicon.ico
```

If the first command shows no ETag line, Cloudflare removed it on the way out. JavaScript Detections (part of Bot Fight Mode) strip the ETag from every HTML response they inject into, so browsers never get a 304. The pages still work; the fix is the bot decision in section 5. Cloudflare may also turn the ETag into a weak one (`W/"…"`) when it compresses the page. The Worker compares ETags the weak way, so both forms work.

Allow ten minutes after a push to the deploy repo before checking a new page version: up to 5 minutes at raw.githubusercontent.com plus up to 5 minutes in the Worker. (The Worker may revalidate just before GitHub's own copy expires; GitHub then answers 304 from its old copy, and the Worker counts that copy as fresh for 5 more minutes.) A browser that has the page cached can show the old version (for up to 5 minutes, and once more after that under `stale-while-revalidate`), so check with `curl` or a private window. The plan's live-check rule ("allow five minutes for raw.githubusercontent.com") needs the same change once this Worker is live (section 6).

## 4. Rollback

- **Quickest:** Workers & Pages → `epidetective-tools` → Deployments → choose the version from before → Rollback.
- **By hand:** paste `legacy-2026-09-10.js` into the editor and deploy. The old code expects the `WAITLIST` and `EMAIL` bindings and the `AUTH_PASSWORD` and `COOKIE_SECRET` secrets. Without `COOKIE_SECRET`, a visitor who still holds an old session cookie gets an error page from the old code.

So do the clean-up in section 5 only after the new Worker has run well for a few days.

## 5. Owner tasks

1. **Waiting list.** If it has not been done, email the people on the list that the tools opened to everyone on 9 September 2026. Then delete the rows (D1 console: `DELETE FROM waitlist;`) and, when nothing else uses it, the database.
2. **Bindings and secrets.** Remove the `WAITLIST` (D1) and `EMAIL` bindings and the `AUTH_PASSWORD` and `COOKIE_SECRET` secrets: Workers & Pages → `epidetective-tools` → Settings → Bindings, and Settings → Variables and Secrets. With wrangler: `npx wrangler secret delete AUTH_PASSWORD` and `npx wrangler secret delete COOKIE_SECRET` (a wrangler deploy already drops the bindings).
3. **Bot settings for the tools host (finding T21).** Bot Fight Mode adds a script (about 45 KB) and a hidden link to every tool page, and its JavaScript Detections strip the ETag. On the Free plan the detections come with Bot Fight Mode and cannot be switched off on their own, and no rule can skip Bot Fight Mode. For two public read-only pages, turning Bot Fight Mode off (Security → Settings → Bot traffic) is the simple choice. Keep or drop AI Labyrinth on purpose. If the ETag is still missing afterwards, turn off the other features that Cloudflare's ETag page (https://developers.cloudflare.com/cache/reference/etag-headers/) says remove or weaken an origin ETag: Email Obfuscation, Automatic HTTPS Rewrites and Rocket Loader for tools.epidetective.com with a Configuration Rule, and Replace insecure JavaScript libraries under Security → Settings. That last one is a zone-wide switch, on by default on Free plans, and it does not reach the apex, which GitHub Pages serves directly.
4. **The apex, epidetective.com (finding T17).** GitHub Pages serves it directly (DNS only), so it sends no security headers and has no IPv6 address. Proxying its DNS records through Cloudflare (orange cloud, SSL/TLS "Full (strict)") would give both: the headers through a Response Header Transform Rule, and IPv6 from Cloudflare. This is outside the Worker; decide whether you want it.

## 6. Follow-up once the new Worker is live

Tell the next session that the Worker is live. It will then:

- replace `design/chronic-disease-explorer/index.html` with a 1 KB redirect page to https://tools.epidetective.com/chronic/ (meta refresh and canonical, like `design/about/index.html`);
- make `PUBLISHED` in `scripts/build_chronic_page.py` the deploy copy only;
- point `TOOL` in `scripts/build_chronic_refs.py` at `deploy/chronic/index.html`;
- change the plan's live-check rule from five to ten minutes after a push (section 3 says why);
- update the state notes.

## 7. Reference

### Routes

| Path | Answer |
|---|---|
| `/` | Chooser page (noindex). With a valid `?lang=` (en zh fr es ru pt ar de ja it), both cards carry it; the site links go to `/zh/`, `/fr/`, `/es/` or `/ru/` where the site has that language. The page text follows `?lang=` for en, zh, fr, es and ru (texts reused from the site and the tools); the other five languages see English. |
| `/cancer/`, `/chronic/` | The tool page from the deploy repo, unchanged. |
| `/cancer/e/<slug>`, `/cancer/c/<slug>` | Cancer page with the entry's title, description, canonical link and card. Slugs: `[a-z0-9-]+`. |
| `/chronic/d/<id>`, `/chronic/r/<id>`, `/chronic/l/<risk>/<disease>` | Chronic page, the same way. Ids: `[a-z0-9_]+`. |
| `/chronic/l/<risk>\|<disease>` (also `%7C`) | 301 to the two-segment form. |
| Upper case, a missing or extra slash, `index.html` | 301 to the canonical lower-case path, query kept. |
| `/favicon.ico` | 301 to https://epidetective.com/favicon.ico. |
| `/chronic/references.html`, `framework.html`, `changelog.html` | 301 to the same page under https://epidetective.com/chronic-disease-explorer/ (old relative links pointed here). |
| Anything else, including `/login`, `/logout`, `/join`, `/admin`, `/waitlist.csv` | HTML 404 with links to both tools and the site, in the same five languages by `?lang=`, `Cache-Control: no-store`. |
| Methods other than GET and HEAD on a page route | 405, `Allow: GET, HEAD`. |

### Share files (for Batch 5)

The Worker reads `share/cancer.json` and `share/chronic.json` from the deploy repo, branch `main`:

```json
{"v": 1, "tool": "cancer", "version": "1.0", "built": "…",
 "e": {"aspartame": {"id": "Aspartame", "t": "…", "d": "…"}},
 "c": {"lung": {"id": "Lung", "t": "…", "d": "…"}}}

{"v": 1, "tool": "chronic", "version": "2.0", "built": "…",
 "d": {"stroke_isch": {…}}, "r": {"smoking": {…}}, "l": {"smoking/copd": {…}}}
```

- `t` (required) becomes `<title>` and `og:title`. When it does not already contain the tool name, the Worker adds " · Cancer Evidence Explorer" or " · Chronic Disease Evidence Explorer".
- `d` (optional) becomes the meta description and `og:description`.
- `id` is not used by the Worker.
- An entry without `t`, a missing entry and a missing file all give the unchanged page with status 404. When the share file cannot be fetched from GitHub, or arrives cut short, and no copy exists at that edge location, the unchanged page is served with status 503 and `Retry-After: 60`, so that a crawler tries again later. That failure is remembered for a minute.
- `og:url` and the canonical link become `https://tools.epidetective.com/<path>`, without the query string. `og:image` becomes `https://epidetective.com/assets/og/cancer.png` or `chronic.png`. Existing `twitter:` title, description and image tags are updated too.

### Caching and headers

- Upstream files are kept in `caches.default` under internal keys. Only a complete file is stored and served: a page must end with `</html>` and a share file must parse as JSON. A transfer that GitHub cuts short, or that stalls, counts as a failed check, so a short copy is never kept and never confirmed by a later 304. A copy is fresh for 5 minutes; after that the Worker asks GitHub with `If-None-Match`. GitHub's 304 restarts the 5 minutes, and a complete 200 replaces the copy. Each copy is kept for 7 days from the last check that got through, and is served when GitHub fails, sends a file that is not complete, or does not answer in time. The Worker waits 3 seconds for GitHub's headers when a copy exists (and always for the share files) and 10 seconds when no copy exists; the body then has 15 seconds more. After a failed check the next check waits a minute, so visitors are not held up while GitHub is down. The 502 page appears only when GitHub fails and no copy exists.
- A missing share file is remembered for 5 minutes, and a share file that could not be fetched (with no copy at hand) for a minute, so GitHub is not asked on every share request.
- ETags: the tool routes pass GitHub's ETag through. Share routes add a suffix computed from the rewritten head, so each entry has its own ETag. A matching `If-None-Match` gets a 304 before any rewriting.
- Pages: `Cache-Control: public, max-age=300, stale-while-revalidate=86400` and `Vary: Accept-Encoding`. The chooser has the same caching and its own ETag. 404, 503 and 502 pages: `no-store`. Redirects: `max-age=3600`.
- `X-Edge-Cache` says where a tool page came from: `hit` (fresh copy), `revalidated` (GitHub said unchanged), `miss` (new copy) or `stale` (GitHub failed; last good copy, also during the minute before the next check).
- Share routes rewrite the head only (tens of kilobytes at the start of the page) and pass the remaining 2 MB on unchanged, which keeps CPU time small.

### Changing the Worker later

Edit `worker.js` here and run the cases in `ROUTES-TEST.md` (`run-all.sh` in the saved harness runs them from a folder outside the repos). Before a deploy, re-sync the reused texts (section 1, step 4). If a change alters what the share rewrite writes into the head, change `WORKER_REV` at the top of `worker.js`, so that browsers do not keep a copy made by the older code. The chooser's ETag follows its own HTML and needs nothing.
