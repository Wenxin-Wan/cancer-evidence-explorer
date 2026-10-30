// EpiDetective tools gate — Cloudflare Worker
// Serves the two evidence-explorer tools behind a login, runs a waiting list,
// and exposes an admin page for the owner. Email is best-effort: it needs the
// epidetective.com domain onboarded for Email Sending in the Dashboard first.
//
// 2026-09-09: the two tools are launched publicly. /cancer and /chronic (and
// the / root, which aliases to /chronic) no longer require a session — they
// are served straight from GitHub. The login, waiting list and /admin code
// are left in place, unused by the tool routes, in case gating needs to come
// back for a future revision.

const AUTH_USERNAME = "wenxin"; // login handle (not secret; matches the site owner)
const SESSION_COOKIE = "epi_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const CONSENT_VERSION = "2026-08-17-v1";
const OWNER_EMAIL = "epidetective@gmail.com";
const FROM_EMAIL = "noreply@epidetective.com";

const TOOLS = {
  chronic: {
    title: "Chronic Disease Evidence Explorer",
    raw: "https://raw.githubusercontent.com/Wenxin-Wan/epidetective/main/chronic-disease-explorer/index.html",
  },
  cancer: {
    title: "Cancer Evidence Explorer",
    raw: "https://raw.githubusercontent.com/Wenxin-Wan/cancer-evidence-explorer/main/index.html",
  },
};

const ALLOWED_NEXT = ["/chronic", "/cancer", "/admin"];

const enc = new TextEncoder();

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

async function hmacHex(keyHex, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(keyHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

// Constant-time comparison of two hex strings of equal length.
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// stored looks like: pbkdf2_sha256$<iterations>$<saltHex>$<hashHex>
async function verifyPassword(input, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = hexToBytes(parts[2]);
  const expected = hexToBytes(parts[3]);
  if (!iterations || salt.length === 0 || expected.length === 0) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(input), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    expected.length * 8,
  );
  return timingSafeEqualHex(bytesToHex(new Uint8Array(bits)), bytesToHex(expected));
}

async function makeSession(env) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const sig = await hmacHex(env.COOKIE_SECRET, "session:" + expiry);
  return `${expiry}.${sig}`;
}

async function sessionIsValid(cookieValue, env) {
  if (!cookieValue) return false;
  const i = cookieValue.indexOf(".");
  if (i < 0) return false;
  const expiry = parseInt(cookieValue.slice(0, i), 10);
  const sig = cookieValue.slice(i + 1);
  if (!expiry || Date.now() / 1000 > expiry) return false;
  const expected = await hmacHex(env.COOKIE_SECRET, "session:" + expiry);
  return timingSafeEqualHex(sig, expected);
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function setSessionCookie(expirySig) {
  return [
    `${SESSION_COOKIE}=${expirySig}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ---------------------------------------------------------------------------
// i18n (EN + ZH — the two languages the tools themselves support)
// ---------------------------------------------------------------------------
const I18N = {
  en: {
    brand: "EpiDetective",
    toolsLabel: "Tools",
    title: "The tools are under revision",
    sub: "The Cancer and Chronic Disease Evidence Explorers are temporarily restricted while they are revised. Authorized users can sign in below; everyone else can request access.",
    signin: "Sign in",
    username: "Username",
    password: "Password",
    signinBtn: "Sign in",
    signinError: "Incorrect username or password.",
    request: "Request access",
    requestSub: "Leave your details to join the waiting list. We will email you when access reopens.",
    name: "Name",
    email: "Email",
    institution: "Institution (optional)",
    jobTitle: "Job title (optional)",
    joinBtn: "Join the waiting list",
    consent:
      "I consent to EpiDetective storing my name and email — and institution and job title if I provide them — for the sole purpose of contacting me when access to the two tools reopens. This data is kept for up to 12 months after reopening, is not shared, and I can withdraw consent at any time by emailing epidetective@gmail.com.",
    joinedTitle: "You're on the list",
    joinedBody: "Thank you — we'll email you when access reopens.",
    already: "This email is already on the waiting list.",
    formError: "Please fill in the required fields and tick the consent box.",
    privacyLink: "How your data is handled",
    back: "Back to epidetective.com",
    logout: "Sign out",
    cookieTitle: "We value your privacy.",
    cookieBody:
      "This page uses a strictly-necessary session cookie to keep you signed in. With your consent, the tools load a font from Google Fonts, which shares your IP address with Google in the US.",
    cookieAccept: "Accept all",
    cookieEssential: "Essential only",
    adminTitle: "Waiting list",
    adminSub: "People who have requested access to the tools.",
    adminCount: "entries",
    adminFilter: "Filter",
    adminAll: "All",
    colName: "Name",
    colEmail: "Email",
    colInstitution: "Institution",
    colTitle: "Title",
    colConsented: "Consented",
    colAt: "Signed up",
    colStatus: "Status",
    csv: "Download CSV",
    empty: "No one has requested access yet.",
    statusPending: "pending",
    statusGranted: "granted",
    statusDeclined: "declined",
    statusWithdrawn: "withdrawn",
    update: "Update",
  },
  zh: {
    brand: "EpiDetective",
    toolsLabel: "工具",
    title: "工具正在修订中",
    sub: "癌症证据探索器与慢性病证据探索器正在修订，暂不对外公开。授权用户可在下方登录；其他访客可申请加入候补名单。",
    signin: "登录",
    username: "用户名",
    password: "密码",
    signinBtn: "登录",
    signinError: "用户名或密码不正确。",
    request: "申请访问",
    requestSub: "留下您的信息，加入候补名单。访问重新开放时，我们会通过邮件通知您。",
    name: "姓名",
    email: "邮箱",
    institution: "机构（选填）",
    jobTitle: "职位（选填）",
    joinBtn: "加入候补名单",
    consent:
      "我同意 EpiDetective 存储我的姓名与邮箱（以及我提供的机构与职位），仅用于在两项工具重新开放时联系我。这些信息在重新开放后最多保留 12 个月，不对外共享，我可随时发邮件至 epidetective@gmail.com 撤回同意。",
    joinedTitle: "您已加入候补名单",
    joinedBody: "感谢——访问重新开放时我们会邮件通知您。",
    already: "该邮箱已在候补名单中。",
    formError: "请填写必填项并勾选同意框。",
    privacyLink: "您的数据如何处理",
    back: "返回 epidetective.com",
    logout: "退出登录",
    cookieTitle: "我们重视您的隐私。",
    cookieBody:
      "此页面使用必要的会话 cookie 保持您的登录状态。经您同意后，工具会从 Google Fonts 加载字体，这会将您的 IP 地址提供给位于美国的 Google。",
    cookieAccept: "全部接受",
    cookieEssential: "仅必要项",
    adminTitle: "候补名单",
    adminSub: "已申请访问工具的人。",
    adminCount: "条",
    adminFilter: "筛选",
    adminAll: "全部",
    colName: "姓名",
    colEmail: "邮箱",
    colInstitution: "机构",
    colTitle: "职位",
    colConsented: "已同意",
    colAt: "登记时间",
    colStatus: "状态",
    csv: "下载 CSV",
    empty: "还没有人申请访问。",
    statusPending: "待处理",
    statusGranted: "已授权",
    statusDeclined: "已拒绝",
    statusWithdrawn: "已撤回",
    update: "更新",
  },
};

const PRIVACY = {
  en: `<p><strong>Controller.</strong> Wenxin Wan, IARC / WHO, Lyon — epidetective@gmail.com.</p>
<p><strong>What we collect.</strong> Name and email (required); institution and job title (optional).</p>
<p><strong>Purpose.</strong> To place you on a waiting list and contact you once the tools reopen.</p>
<p><strong>Lawful basis.</strong> Your consent (Art. 6(1)(a) GDPR).</p>
<p><strong>Retention.</strong> Until access reopens, plus 12 months, then deleted; sooner if you withdraw consent.</p>
<p><strong>Recipients.</strong> None. Details are not shared and not used for marketing.</p>
<p><strong>Your rights.</strong> Access, rectification, erasure, restriction, portability, objection, and withdrawal of consent at any time (email epidetective@gmail.com). You may complain to your supervisory authority (CNIL in France).</p>`,
  zh: `<p><strong>控制者</strong>：Wenxin Wan，IARC / WHO，里昂——epidetective@gmail.com。</p>
<p><strong>收集内容</strong>：姓名、邮箱（必填）；机构、职位（选填）。</p>
<p><strong>用途</strong>：将您列入候补名单，并在两项工具重新开放时联系您。</p>
<p><strong>法律依据</strong>：您的同意（GDPR 第 6(1)(a) 条）。</p>
<p><strong>保留期限</strong>：访问重新开放后再保留 12 个月，届时删除；您撤回同意则提前删除。</p>
<p><strong>接收方</strong>：无。信息不与第三方共享，不用于营销。</p>
<p><strong>您的权利</strong>：访问、更正、删除、限制处理、可携带、反对及随时撤回同意（邮件至 epidetective@gmail.com）。您可向监管机构（法国 CNIL）投诉。</p>`,
};

const CSS = `
:root{--paper:#f3f5ef;--card:#fffef9;--ink:#173330;--ink-soft:#294b47;--muted:#667875;--line:#d9e1d9;--accent:#e16752;--teal:#1d5c57;--teal-2:#2f756e;--teal-soft:#dcece7}
*{box-sizing:border-box}
html,body{margin:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:var(--paper);color:var(--ink);line-height:1.55;font-size:16px;-webkit-font-smoothing:antialiased}
a{color:var(--teal);text-underline-offset:3px}
.wrap{max-width:1120px;margin:0 auto;padding:0 28px}
.top{display:flex;align-items:center;justify-content:space-between;height:70px;border-bottom:1px solid var(--line)}
.mark{font-weight:700;font-size:17px;color:var(--ink);text-decoration:none;letter-spacing:.01em}
.mark span{color:var(--teal)}
.top-right{display:flex;align-items:center;gap:14px;font-size:14px}
.hero{padding:56px 0 24px}
.hero h1{font-size:30px;margin:0 0 14px}
.hero p{color:var(--ink-soft);max-width:720px;margin:0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px;padding:26px 0 60px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:26px}
.card h2{font-size:19px;margin:0 0 6px}
.card .hint{color:var(--muted);font-size:14px;margin:0 0 20px}
label{display:block;font-size:13px;font-weight:600;color:var(--ink-soft);margin:14px 0 5px}
input[type=text],input[type=password],input[type=email]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;font:inherit;color:var(--ink)}
input:focus{outline:3px solid rgba(225,103,82,.25);border-color:var(--accent)}
.btn{display:inline-block;background:var(--teal);color:#fff;border:0;border-radius:10px;padding:11px 18px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;margin-top:18px}
.btn:hover{background:var(--teal-2)}
.btn.ghost{background:transparent;color:var(--teal);border:1px solid var(--line)}
.consent{display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--muted);margin-top:18px}
.consent input{margin-top:3px}
.err{color:#b94333;font-size:14px;margin:12px 0 0}
.ok{color:var(--teal);font-size:15px;margin:8px 0 0}
details{margin-top:16px;font-size:13px;color:var(--muted)}
details summary{cursor:pointer;color:var(--teal);font-weight:600}
details p{margin:8px 0}
.foot{border-top:1px solid var(--line);padding:22px 0;font-size:13px;color:var(--muted);display:flex;justify-content:space-between;gap:14px}
.banner{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:16px 0;font-size:13.5px;color:var(--ink-soft);box-shadow:0 -6px 30px rgba(28,62,57,.08)}
.banner .wrap{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.banner .btns{display:flex;gap:10px}
.banner .btn{padding:8px 14px;margin:0;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:16px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}
.pill.pending{background:#f3e8c8;color:#8a6d1f}
.pill.granted{background:var(--teal-soft);color:var(--teal)}
.pill.declined{background:#fae9e3;color:#b94333}
.pill.withdrawn{background:#e8e8e4;color:var(--muted)}
@media(max-width:760px){.grid{grid-template-columns:1fr}}
`;

function langSwitchHtml(lang) {
  const other = lang === "en" ? "zh" : "en";
  return `<a href="?lang=${other}">${other === "zh" ? "中文" : "EN"}</a>`;
}

function layout(bodyHtml, t, lang, opts = {}) {
  const banner = opts.showCookieBanner !== false;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(t.title)} — ${esc(t.brand)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="top"><div class="wrap" style="display:flex;align-items:center;justify-content:space-between;width:100%">
<a class="mark" href="/">${esc(t.brand)} <span>${esc(t.toolsLabel)}</span></a>
<div class="top-right">${langSwitchHtml(lang)}${opts.loggedIn ? ` <a href="/logout" style="color:var(--muted)">${esc(t.logout)}</a>` : ""}</div>
</div></div>
<div class="wrap">${bodyHtml}</div>
<div class="foot"><div class="wrap" style="display:flex;justify-content:space-between;gap:14px;width:100%">
<span><a href="https://epidetective.com">${esc(t.back)}</a></span>
<span><a href="mailto:${OWNER_EMAIL}">${OWNER_EMAIL}</a></span>
</div></div>
${
  banner
    ? `<div class="banner" id="cookie-banner">
<div class="wrap">
<div style="flex:1"><strong>${esc(t.cookieTitle)}</strong> ${esc(t.cookieBody)}</div>
<div class="btns">
<button class="btn" onclick="setConsent(true)">${esc(t.cookieAccept)}</button>
<button class="btn ghost" onclick="setConsent(false)">${esc(t.cookieEssential)}</button>
</div>
</div></div>
<script>
function setConsent(all){try{localStorage.setItem("epi_cookie_consent",JSON.stringify({version:"${CONSENT_VERSION}",analytics:!!all,ts:new Date().toISOString()}));}catch(e){}document.getElementById("cookie-banner").style.display="none";}
try{var c=localStorage.getItem("epi_cookie_consent");if(c)document.getElementById("cookie-banner").style.display="none";}catch(e){}
</script>`
    : ""
}
</body>
</html>`;
}

function gatePage(env, lang, next, error) {
  const t = I18N[lang];
  const safeNext = next || "/chronic/";
  const body = `
<div class="hero"><h1>${esc(t.title)}</h1><p>${esc(t.sub)}</p></div>
<div class="grid">
  <div class="card">
    <h2>${esc(t.signin)}</h2>
    <p class="hint">${esc(t.sub)}</p>
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${esc(safeNext)}">
      <label for="u">${esc(t.username)}</label>
      <input id="u" name="username" type="text" autocomplete="username" required>
      <label for="p">${esc(t.password)}</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required>
      ${error ? `<div class="err">${esc(t.signinError)}</div>` : ""}
      <button class="btn" type="submit">${esc(t.signinBtn)}</button>
    </form>
  </div>
  <div class="card">
    <h2>${esc(t.request)}</h2>
    <p class="hint">${esc(t.requestSub)}</p>
    <form method="post" action="/join">
      <input type="hidden" name="lang" value="${lang}">
      <label for="n">${esc(t.name)}</label>
      <input id="n" name="name" type="text" required>
      <label for="e">${esc(t.email)}</label>
      <input id="e" name="email" type="email" required>
      <label for="i">${esc(t.institution)}</label>
      <input id="i" name="institution" type="text">
      <label for="j">${esc(t.job_title)}</label>
      <input id="j" name="job_title" type="text">
      <div class="consent"><input type="checkbox" name="consent" value="1" id="c"><label for="c" style="margin:0;font-weight:400">${esc(t.consent)}</label></div>
      <button class="btn" type="submit">${esc(t.joinBtn)}</button>
    </form>
    <details><summary>${esc(t.privacyLink)}</summary>${PRIVACY[lang]}</details>
  </div>
</div>`;
  return layout(body, t, lang, { showCookieBanner: true });
}

function joinedPage(lang, already) {
  const t = I18N[lang];
  const body = `<div class="hero"><h1>${esc(already ? t.already : t.joinedTitle)}</h1><p>${esc(already ? t.already : t.joinedBody)}</p>
<a class="btn" href="https://epidetective.com">${esc(t.back)}</a></div>`;
  return layout(body, t, lang, { showCookieBanner: false });
}

function adminPage(rows, lang, status, csrf) {
  const t = I18N[lang];
  const statuses = ["pending", "granted", "declined", "withdrawn"];
  const rowsHtml = rows.length
    ? rows
        .map(
          (r) => `<tr>
<td>${esc(r.name)}</td>
<td>${esc(r.email)}</td>
<td>${esc(r.institution || "")}</td>
<td>${esc(r.job_title || "")}</td>
<td>${r.consent_given ? "✓" : ""}</td>
<td>${esc((r.created_at || "").slice(0, 16).replace("T", " "))}</td>
<td><span class="pill ${esc(r.status)}">${esc(t["status" + r.status[0].toUpperCase() + r.status.slice(1)] || r.status)}</span>
<form method="post" action="/admin/status" style="display:inline;margin-left:8px">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="id" value="${r.id}">
<select name="status">${statuses
            .map((s) => `<option value="${s}"${s === r.status ? " selected" : ""}>${esc(t["status" + s[0].toUpperCase() + s.slice(1)])}</option>`)
            .join("")}</select>
<button type="submit" style="font-size:12px">${esc(t.update)}</button>
</form></td>
</tr>`,
        )
        .join("")
    : `<tr><td colspan="7">${esc(t.empty)}</td></tr>`;

  const filterOptions = statuses
    .map(
      (s) =>
        `<a href="/admin?status=${s}" style="margin-right:10px">${esc(t["status" + s[0].toUpperCase() + s.slice(1)])}</a>`,
    )
    .join("");

  const body = `<div class="hero"><h1>${esc(t.adminTitle)}</h1><p>${esc(t.adminSub)}</p></div>
<div style="padding:20px 0 60px">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
<div><a href="/admin">${esc(t.adminAll)}</a> ${filterOptions}</div>
<div><a class="btn ghost" style="margin:0" href="/waitlist.csv">${esc(t.csv)}</a> <span style="color:var(--muted);font-size:13px">${rows.length} ${esc(t.adminCount)}</span></div>
</div>
<table><thead><tr><th>${esc(t.colName)}</th><th>${esc(t.colEmail)}</th><th>${esc(t.colInstitution)}</th><th>${esc(t.colTitle)}</th><th>${esc(t.colConsented)}</th><th>${esc(t.colAt)}</th><th>${esc(t.colStatus)}</th></tr></thead>
<tbody>${rowsHtml}</tbody></table>
</div>`;
  return layout(body, t, lang, { showCookieBanner: false, loggedIn: true });
}

async function emailOwner(env, row) {
  try {
    await env.EMAIL.send({
      to: OWNER_EMAIL,
      from: { email: FROM_EMAIL, name: "EpiDetective" },
      subject: `Waiting list: ${row.name} (${row.email})`,
      html: `<p>A new person joined the EpiDetective tools waiting list.</p>
<ul><li>Name: ${esc(row.name)}</li><li>Email: ${esc(row.email)}</li>
<li>Institution: ${esc(row.institution || "—")}</li><li>Job title: ${esc(row.job_title || "—")}</li></ul>
<p>Review at <a href="https://tools.epidetective.com/admin">tools.epidetective.com/admin</a>.</p>`,
      text: `New waiting-list signup: ${row.name} <${row.email}> (${row.institution || "—"}, ${row.job_title || "—"}). Review at https://tools.epidetective.com/admin`,
    });
  } catch (e) {
    // Email Sending is not onboarded yet — the signup is still recorded in D1
    // and is visible on the admin page. Log for visibility.
    console.error("EMAIL_SEND_FAILED", e && e.code ? e.code : e);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    let path = url.pathname.replace(/\/+$/, "") || "/";
    const lang = url.searchParams.get("lang") === "zh" ? "zh" : "en";
    const t = I18N[lang];

    // --- login ---
    if (path === "/login" && method === "POST") {
      const body = await request.formData();
      const username = (body.get("username") || "").toString();
      const password = (body.get("password") || "").toString();
      let next = (body.get("next") || "").toString() || "/chronic/";
      if (!ALLOWED_NEXT.some((p) => next === p || next.startsWith(p + "/"))) next = "/chronic/";
      if (username === AUTH_USERNAME && (await verifyPassword(password, env.AUTH_PASSWORD))) {
        const token = await makeSession(env);
        return new Response(null, {
          status: 303,
          headers: { Location: next, "Set-Cookie": setSessionCookie(token) },
        });
      }
      return new Response(gatePage(env, lang, next, true), {
        status: 401,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // --- logout ---
    if (path === "/logout") {
      return new Response(null, {
        status: 303,
        headers: { Location: "/", "Set-Cookie": clearSessionCookie() },
      });
    }

    // --- waitlist signup ---
    if (path === "/join" && method === "POST") {
      const body = await request.formData();
      const name = (body.get("name") || "").toString().trim();
      const email = (body.get("email") || "").toString().trim().toLowerCase();
      const institution = (body.get("institution") || "").toString().trim();
      const jobTitle = (body.get("job_title") || "").toString().trim();
      const consent = (body.get("consent") || "").toString() === "1";
      const joinLang = (body.get("lang") || "").toString() === "zh" ? "zh" : "en";

      if (!name || !isEmail(email) || !consent || name.length > 200) {
        return new Response(layout(`<div class="hero"><h1>${esc(I18N[joinLang].formError)}</h1><a class="btn" href="javascript:history.back()">←</a></div>`, I18N[joinLang], joinLang, { showCookieBanner: false }), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const now = new Date().toISOString();
      const ip = request.headers.get("CF-Connecting-IP") || "";
      const day = now.slice(0, 10);
      const ipHash = await hmacHex(env.COOKIE_SECRET, "ip:" + day + ":" + ip);

      try {
        await env.WAITLIST.prepare(
          "INSERT INTO waitlist (name, email, institution, job_title, consent_given, consent_version, consent_at, ip_hash, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
        )
          .bind(name, email, institution, jobTitle, consent ? 1 : 0, CONSENT_VERSION, now, ipHash, now)
          .run();
        const row = { name, email, institution, jobTitle };
        await emailOwner(env, row);
        return new Response(joinedPage(joinLang, false), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } catch (e) {
        // UNIQUE(email) violation → already on the list.
        return new Response(joinedPage(joinLang, true), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    // --- admin: list / status change / csv (all require session) ---
    const authed = await sessionIsValid(getCookie(request, SESSION_COOKIE), env);

    if (path === "/admin" || path.startsWith("/admin/")) {
      if (!authed) {
        return new Response(gatePage(env, lang, "/admin", false), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (path === "/admin/status" && method === "POST") {
        const body = await request.formData();
        const csrf = (body.get("csrf") || "").toString();
        const expected = await hmacHex(env.COOKIE_SECRET, "csrf");
        if (csrf !== expected) {
          return new Response("Forbidden", { status: 403 });
        }
        const id = parseInt((body.get("id") || "").toString(), 10);
        const status = (body.get("status") || "").toString();
        if (id && ["pending", "granted", "declined", "withdrawn"].includes(status)) {
          await env.WAITLIST.prepare("UPDATE waitlist SET status = ? WHERE id = ?").bind(status, id).run();
        }
        const back = url.searchParams.get("status");
        return new Response(null, { status: 303, headers: { Location: back ? "/admin?status=" + back : "/admin" } });
      }

      const statusFilter = ["pending", "granted", "declined", "withdrawn"].includes(url.searchParams.get("status"))
        ? url.searchParams.get("status")
        : null;
      let rows;
      if (statusFilter) {
        const r = await env.WAITLIST.prepare("SELECT * FROM waitlist WHERE status = ? ORDER BY created_at DESC").bind(statusFilter).all();
        rows = r.results || [];
      } else {
        const r = await env.WAITLIST.prepare("SELECT * FROM waitlist ORDER BY created_at DESC").all();
        rows = r.results || [];
      }
      const csrf = await hmacHex(env.COOKIE_SECRET, "csrf");
      return new Response(adminPage(rows, lang, statusFilter || "pending", csrf), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/waitlist.csv") {
      if (!authed) return new Response("Forbidden", { status: 403 });
      const r = await env.WAITLIST.prepare("SELECT name, email, institution, job_title, consent_given, consent_at, created_at, status FROM waitlist ORDER BY created_at DESC").all();
      const rows = r.results || [];
      const header = ["name", "email", "institution", "job_title", "consent_given", "consent_at", "created_at", "status"].join(",");
      const lines = rows.map((x) =>
        [x.name, x.email, x.institution || "", x.job_title || "", x.consent_given, x.consent_at, x.created_at, x.status]
          .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
          .join(","),
      );
      return new Response([header].concat(lines).join("\n"), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="waitlist.csv"' },
      });
    }

    // --- tool routes: public launch, 2026-09-09 — served to everyone, no session required ---
    let toolKey = null;
    if (path === "/") toolKey = "chronic";
    else if (path === "/chronic" || path.startsWith("/chronic/")) toolKey = "chronic";
    else if (path === "/cancer" || path.startsWith("/cancer/")) toolKey = "cancer";

    if (toolKey) {
      const upstream = await fetch(TOOLS[toolKey].raw, { headers: { "User-Agent": "epidetective-tools-gate/1" } });
      if (!upstream.ok) {
        return new Response("Tool unavailable (upstream error " + upstream.status + ")", { status: 502 });
      }
      return new Response(upstream.body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300, must-revalidate",
        },
      });
    }

    // --- unknown path ---
    return new Response("Not found", { status: 404 });
  },
};
