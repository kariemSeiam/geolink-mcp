/**
 * The browser-facing surface: the page a person lands on when a client sends
 * them here to connect, and the page they get if they open the endpoint by hand.
 *
 * Self-contained by necessity. This is served during an authorization redirect,
 * often inside an in-app browser with an unknown network, so every style and
 * script is inline: no CDN, no font fetch, no build step between the server and
 * the screen. It renders correctly with JavaScript disabled, because the form is
 * a real form posting to a real endpoint.
 *
 * The palette is GeoLink's own (deep azure #1A5F7A, vibrant teal #00B4D8), so a
 * person who arrives from a client they trust can see at a glance that they
 * landed where they expected. It adapts to the viewer's colour scheme, to
 * narrow screens, to reduced-motion preferences, and to Arabic — which needs
 * `dir="rtl"` and a mirrored layout, not a translated string in a Latin frame.
 */

export type PageLang = "en" | "ar";

interface ConnectPageOptions {
  lang: PageLang;
  /** Where the form posts; carries the OAuth transaction. */
  action: string;
  /** Hidden fields that must survive the round trip. */
  hidden: Record<string, string>;
  /** Name of the client asking for access, when it identified itself. */
  clientName?: string;
  error?: string;
  registerUrl: string;
  siteUrl: string;
}

const COPY = {
  en: {
    dir: "ltr",
    title: "Connect GeoLink",
    kicker: "Model Context Protocol",
    heading: "Connect GeoLink",
    subheadWith: (client: string) => `${client} is asking to use your GeoLink key.`,
    subheadPlain: "Give your assistant access to your GeoLink key.",
    label: "GeoLink API key",
    placeholder: "Paste your key",
    help: "The key is stored against this connection only, and is sent to GeoLink and nowhere else.",
    cta: "Connect",
    noKey: "Don't have a key?",
    noKeyLink: "Get one free",
    noKeyTail: "— no card, takes under a minute.",
    grants: "What this allows",
    grantList: [
      "Look up addresses and coordinates",
      "Search for places and cover whole areas",
      "Get routes and travel times",
    ],
    readOnly: "Read-only. Nothing in your GeoLink account can be changed from here.",
    footerDocs: "Documentation",
    footerSite: "geolink-eg.com",
  },
  ar: {
    dir: "rtl",
    title: "ربط GeoLink",
    kicker: "Model Context Protocol",
    heading: "ربط GeoLink",
    subheadWith: (client: string) => `${client} بيطلب استخدام مفتاح GeoLink بتاعك.`,
    subheadPlain: "اربط مساعدك بمفتاح GeoLink بتاعك.",
    label: "مفتاح GeoLink",
    placeholder: "الصق المفتاح هنا",
    help: "المفتاح بيتحفظ لهذا الاتصال وحده، وبيتبعت لـ GeoLink ولا لأي جهة تانية.",
    cta: "اربط",
    noKey: "معندكش مفتاح؟",
    noKeyLink: "خد واحد مجاني",
    noKeyTail: "— من غير كارت، ودقيقة واحدة.",
    grants: "الصلاحيات",
    grantList: [
      "تحويل العناوين لإحداثيات والعكس",
      "البحث عن أماكن وتغطية مناطق كاملة",
      "حساب المسارات وأزمنة الطريق",
    ],
    readOnly: "قراءة فقط. مفيش أي حاجة في حسابك ممكن تتغير من هنا.",
    footerDocs: "التوثيق",
    footerSite: "geolink-eg.com",
  },
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Shared styles. Tokens first so the dark and RTL overrides stay one line each. */
const STYLE = `
:root{
  --azure:#1A5F7A; --teal:#00B4D8; --ink:#0F1E27; --body:#475569;
  --bg:#F8FAFC; --card:#FFFFFF; --line:#E2E8F0; --muted:#94A3B8;
  --danger:#FF7E67; --ok:#57CC99; --radius:14px;
  --font:"Cairo","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  --mono:"Roboto Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme:dark){
  :root{ --ink:#F1F5F9; --body:#CBD5E1; --bg:#0B1520; --card:#132430;
         --line:#22384A; --muted:#7C93A6; --teal:#38CFEC; }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:var(--font); background:var(--bg); color:var(--ink);
  min-height:100vh; min-height:100dvh; display:flex; justify-content:center;
  padding:24px 16px; line-height:1.6; -webkit-font-smoothing:antialiased;
}
/* Centred by auto margins rather than align-items: a flex item centred with
   align-items is clipped at the top once it outgrows a short viewport, which
   is exactly what a phone in landscape gives you. */
.card{
  margin:auto; width:100%; max-width:460px; background:var(--card);
  border:1px solid var(--line); border-radius:var(--radius);
  padding:32px 28px; box-shadow:0 1px 2px rgba(15,30,39,.04),0 12px 32px -12px rgba(15,30,39,.14);
}
.mark{display:flex;align-items:center;gap:10px;margin-bottom:22px}
.mark svg{flex:none}
.kicker{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600}
h1{font-size:24px;line-height:1.25;margin:0 0 6px;font-weight:700;letter-spacing:-.01em}
.sub{margin:0 0 26px;color:var(--body);font-size:15px}
.client{color:var(--ink);font-weight:600}
label{display:block;font-size:13px;font-weight:600;margin-bottom:7px}
input[type=password],input[type=text]{
  width:100%; padding:12px 14px; font-family:var(--mono); font-size:14px;
  color:var(--ink); background:var(--bg); border:1px solid var(--line);
  border-radius:10px; outline:none; transition:border-color .15s,box-shadow .15s;
}
input:focus{border-color:var(--teal);box-shadow:0 0 0 3px color-mix(in srgb,var(--teal) 22%,transparent)}
.help{font-size:12.5px;color:var(--muted);margin:8px 0 20px}
button{
  width:100%; padding:12px 16px; font-family:var(--font); font-size:15px; font-weight:700;
  color:#fff; background:var(--azure); border:0; border-radius:10px; cursor:pointer;
  transition:transform .12s ease, background .15s ease;
}
button:hover{background:#17536B}
button:active{transform:translateY(1px)}
button:focus-visible{outline:3px solid color-mix(in srgb,var(--teal) 55%,transparent);outline-offset:2px}
.getkey{font-size:13.5px;color:var(--body);margin:16px 0 0;text-align:center}
a{color:var(--teal);text-decoration:none;font-weight:600}
a:hover{text-decoration:underline}
.grants{margin-top:26px;padding-top:20px;border-top:1px solid var(--line)}
.grants h2{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 10px;font-weight:700}
ul{margin:0;padding:0;list-style:none}
li{display:flex;gap:9px;align-items:flex-start;font-size:14px;color:var(--body);margin-bottom:7px}
li svg{flex:none;margin-top:5px}
.ro{font-size:12.5px;color:var(--muted);margin:12px 0 0}
.err{
  display:flex;gap:9px;align-items:flex-start;font-size:13.5px;
  background:color-mix(in srgb,var(--danger) 12%,transparent);
  border:1px solid color-mix(in srgb,var(--danger) 34%,transparent);
  color:var(--ink);border-radius:10px;padding:11px 13px;margin-bottom:18px;
}
footer{margin-top:24px;text-align:center;font-size:12.5px;color:var(--muted)}
footer a{color:var(--muted);font-weight:500}
[dir=rtl] li,[dir=rtl] .err{flex-direction:row}
@media (max-width:420px){ .card{padding:26px 20px;border-radius:12px} h1{font-size:21px} }
@media (prefers-reduced-motion:reduce){ *{transition:none!important} button:active{transform:none} }
`;

const LOGO = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7Z" stroke="#00B4D8" stroke-width="1.8" stroke-linejoin="round"/>
<circle cx="12" cy="9" r="2.6" stroke="#1A5F7A" stroke-width="1.8"/></svg>`;

const TICK = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
<path d="M3.5 8.5l3 3 6-7" stroke="#57CC99" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ALERT = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
<circle cx="8" cy="8" r="6.6" stroke="#FF7E67" stroke-width="1.6"/>
<path d="M8 5v3.6M8 10.8v.1" stroke="#FF7E67" stroke-width="1.7" stroke-linecap="round"/></svg>`;

function shell(lang: PageLang, title: string, body: string): string {
  const dir = COPY[lang].dir;
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}

/** The page a client sends a person to during authorization. */
export function connectPage(opts: ConnectPageOptions): string {
  const t = COPY[opts.lang];
  const hidden = Object.entries(opts.hidden)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  const sub = opts.clientName
    ? t.subheadWith(`<span class="client">${escapeHtml(opts.clientName)}</span>`)
    : t.subheadPlain;

  return shell(
    opts.lang,
    t.title,
    `<main class="card">
  <div class="mark">${LOGO}<span class="kicker">${t.kicker}</span></div>
  <h1>${escapeHtml(t.heading)}</h1>
  <p class="sub">${sub}</p>
  ${opts.error ? `<div class="err" role="alert">${ALERT}<span>${escapeHtml(opts.error)}</span></div>` : ""}
  <form method="post" action="${escapeHtml(opts.action)}" autocomplete="off">
    ${hidden}
    <label for="key">${escapeHtml(t.label)}</label>
    <input id="key" name="api_key" type="password" required autofocus spellcheck="false"
           autocapitalize="off" autocorrect="off" placeholder="${escapeHtml(t.placeholder)}">
    <p class="help">${escapeHtml(t.help)}</p>
    <button type="submit">${escapeHtml(t.cta)}</button>
  </form>
  <p class="getkey">${escapeHtml(t.noKey)}
    <a href="${escapeHtml(opts.registerUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.noKeyLink)}</a>
    ${escapeHtml(t.noKeyTail)}</p>
  <section class="grants">
    <h2>${escapeHtml(t.grants)}</h2>
    <ul>${t.grantList.map((g) => `<li>${TICK}<span>${escapeHtml(g)}</span></li>`).join("")}</ul>
    <p class="ro">${escapeHtml(t.readOnly)}</p>
  </section>
  <footer><a href="${escapeHtml(opts.siteUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.footerSite)}</a></footer>
</main>`,
  );
}

/** Shown after a successful authorization when the client cannot be redirected. */
export function successPage(lang: PageLang, code: string): string {
  const rtl = lang === "ar";
  return shell(
    lang,
    rtl ? "تم الربط" : "Connected",
    `<main class="card" style="text-align:center">
  <div class="mark" style="justify-content:center">${LOGO}<span class="kicker">GeoLink</span></div>
  <h1>${rtl ? "تم الربط" : "You're connected"}</h1>
  <p class="sub">${rtl ? "ارجع لمساعدك — ممكن تقفل الصفحة دي." : "Return to your assistant. You can close this page."}</p>
  <label for="c">${rtl ? "لو طُلب منك كود" : "If you're asked for a code"}</label>
  <input id="c" type="text" readonly value="${escapeHtml(code)}" onclick="this.select()">
</main>`,
  );
}
