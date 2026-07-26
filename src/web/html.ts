/** Minimal server-rendered HTML helpers (no client-side framework). */

/**
 * Serialize a value for safe interpolation into an inline `<script>` block.
 * Unlike `escapeHtml` (whose HTML-entity output isn't decoded inside
 * `<script>` text and would corrupt the JS), this only neutralizes `<` so a
 * value containing `</script>` can't prematurely close the element.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Escape a string for safe interpolation into HTML text or attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/**
 * dt.in.th design system tokens — a warm-dark, developer-native palette.
 * Source: https://claude.ai/design/p/aa537dd3-e246-4c8e-b95c-d4e46676e790
 * (dtinth/notes-frontend's `packages/client/src/style.css`, adapted here).
 */
const STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Arimo:ital,wght@0,400..700;1,400..700&display=swap');
  @font-face {
    font-family: "Comic Mono"; font-style: normal; font-weight: 400;
    src: url("https://cdn.jsdelivr.net/npm/comic-mono@0.0.1/ComicMono.ttf") format("truetype");
    font-display: swap;
  }
  @font-face {
    font-family: "Comic Mono"; font-style: normal; font-weight: 700;
    src: url("https://cdn.jsdelivr.net/npm/comic-mono@0.0.1/ComicMono-Bold.ttf") format("truetype");
    font-display: swap;
  }
  :root {
    --bg-deep: #090807; --bg-base: #252423; --bg-raised: #353433; --bg-elev: #454443;
    --border-weak: #454443; --border-base: #656463; --border-strong: #8b8685;
    --fg-primary: #e9e8e7; --fg-muted: #8b8685; --fg-strong: #ffffff; --fg-warm: #e9d7c5;
    --accent-lime: #d7fc70; --accent-cream: #ffffbb; --accent-pink: #febfea; --accent-sky: #bbeeff;
    --ok: #86efac; --warn: #fde047;
    --shadow-offset: 2px 2px 0 #00000040;
    --radius-xs: 2px; --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px;
    --font-sans: "Arimo", Helvetica, Arial, ui-sans-serif, system-ui, sans-serif;
    --font-mono: "Comic Mono", ui-monospace, SFMono-Regular, Menlo, "DejaVu Sans Mono", monospace;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-sans); font-size: 15px; line-height: 1.6; letter-spacing: .01em;
    margin: 0; background: var(--bg-base); color: var(--fg-primary);
    -webkit-font-smoothing: antialiased;
  }
  *:focus-visible { outline: 2px solid var(--accent-lime); outline-offset: 2px; }
  .app-shell { display: flex; align-items: flex-start; }
  .app-sidebar {
    flex: 0 0 16rem; box-sizing: border-box; border-right: 1px solid var(--border-weak);
    padding: 1rem; position: sticky; top: 0; height: 100vh; overflow-y: auto;
    background: var(--bg-deep);
  }
  .app-sidebar.collapsed { flex: 0 0 auto; width: auto; height: auto; overflow: visible; }
  .app-sidebar.collapsed > *:not(.sidebar-toggle) { display: none; }
  .sidebar-toggle {
    background: none; border: 1px solid var(--border-base); border-radius: var(--radius-sm);
    cursor: pointer; color: var(--fg-primary); font-size: .8rem; line-height: 1;
    padding: .3rem .5rem; margin-bottom: .6rem;
  }
  .app-main { flex: 1; min-width: 0; background: var(--bg-raised); }
  .page { max-width: 780px; margin: 0 auto; padding: 1.5rem; }
  @media (max-width: 700px) {
    .app-shell { flex-direction: column; }
    .app-sidebar {
      flex: none; width: 100%; height: auto; position: static;
      border-right: none; border-bottom: 1px solid var(--border-weak); order: 2;
    }
    .app-main { order: 1; }
  }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  h1 {
    font-size: 1.6rem; margin: 0 0 .25rem; color: var(--fg-muted);
    text-shadow: 2px 2px #00000040; font-weight: 800;
  }
  h1 a { color: inherit; text-decoration: none; }
  h1 a:hover { color: var(--accent-cream); }
  h3 { color: var(--accent-pink); font-weight: 700; text-shadow: 2px 2px #00000040; }
  a { color: var(--accent-cream); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: var(--fg-muted); }
  form.inline { display: inline; }
  label { display: block; margin: .75rem 0 .2rem; font-weight: 600; }
  input[type=text], input[type=number], select, textarea {
    width: 100%; padding: .5rem .7rem;
    background: linear-gradient(to bottom, #151413, #292827);
    color: var(--fg-primary); border: 1px solid var(--border-base);
    border-radius: var(--radius-lg); box-shadow: 0 2px 4px rgba(0,0,0,.3);
    font: 400 14px var(--font-sans);
  }
  input::placeholder, textarea::placeholder { color: var(--fg-muted); }
  /* Match the comment-card body's typography (GFM's .markdown-body:
     font-size 16px, line-height 1.5), so typing a reply doesn't visually
     jar against the comment you're replying to. Letter-spacing is set
     explicitly (not just inherited from body's .01em) because form
     controls don't inherit it by default; 0.15px is that .01em computed
     at body's 15px font-size. */
  textarea { min-height: 8rem; font-size: 16px; line-height: 1.5; letter-spacing: 0.15px; }
  textarea[hidden] { display: none; }
  button, .btn-link {
    padding: .5rem .9rem; background: linear-gradient(to bottom, #454443, #151413);
    border: 1px solid var(--border-base); border-radius: var(--radius-lg);
    box-shadow: 0 2px 4px rgba(0,0,0,.3); color: var(--fg-primary);
    font: 600 14px var(--font-sans); cursor: pointer; transition: all 300ms ease-out;
  }
  .btn-link { display: inline-block; text-decoration: none; }
  button:hover, .btn-link:hover {
    border-color: var(--border-strong); background: linear-gradient(to bottom, #555453, #151413);
    transition-duration: 0ms; text-decoration: none;
  }
  button:active, .btn-link:active { background: linear-gradient(to bottom, #151413, #353433); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.secondary { color: var(--fg-muted); }
  /* The reverse of .btn-link: a <button> (kept for its form submit) that
     should read as plain text, not a button, e.g. "Log out". */
  button.link-button {
    padding: 0; background: none; border: none; box-shadow: none;
    color: var(--accent-cream); font: inherit; text-decoration: none;
  }
  button.link-button:hover {
    background: none; border-color: transparent; text-decoration: underline;
  }
  button.link-button:active { background: none; }
  .preset-row { display: flex; gap: .4rem; flex-wrap: wrap; margin: 0 0 .6rem; }
  button.preset { padding: .3rem .6rem; font-size: .85rem; font-weight: 500; }
  .row { display: flex; gap: .75rem; align-items: flex-end; }
  .row > * { flex: 1; }
  fieldset { border: 1px solid var(--border-weak); border-radius: var(--radius-lg); margin: 1rem 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--border-weak); }
  code, pre { font-family: var(--font-mono); }
  code {
    background: var(--bg-base); color: var(--fg-warm); border: 1px solid #555453;
    border-bottom-width: 2px; border-radius: var(--radius-xs); padding: 2.5px 5px;
    box-shadow: 0 1px 0 var(--bg-base);
  }
  pre {
    background: var(--bg-deep); color: var(--fg-warm); border: 1px solid var(--border-weak);
    border-radius: var(--radius-md); padding: .8rem; overflow-x: auto;
    white-space: pre-wrap; word-break: break-all;
  }
  pre code { background: none; border: none; box-shadow: none; padding: 0; }
  .grid { display: grid; grid-template-columns: 10rem 1fr; gap: .3rem .8rem; align-items: center; }
  .card {
    border: 1px solid var(--border-weak); border-radius: var(--radius-lg);
    padding: 1rem; margin: 1rem 0; background: var(--bg-base); box-shadow: var(--shadow-offset);
  }
  .ok { color: var(--ok); } .warn { color: var(--warn); }
  .copy-row { display: flex; gap: .5rem; align-items: center; }
  .copy-row input[type=text] {
    font-family: var(--font-mono);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .copy-row button { flex: none; }
  .app-sidebar h3 {
    margin: 0 0 .5rem; font-size: .8rem; color: var(--accent-lime); text-shadow: none;
  }
  .sidebar-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .7rem; }
  .sidebar-list li { font-size: .85rem; overflow-wrap: anywhere; }
  .sidebar-list li.prominent {
    border-left: 3px solid var(--accent-lime); padding-left: .5rem; margin-left: -.5rem;
  }
  .sidebar-list relative-time { display: block; color: var(--fg-muted); font-size: .75rem; }
  .sidebar-list .excerpt {
    margin: .2rem 0 0; color: var(--fg-muted);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .sidebar-list .excerpt.prominent { color: var(--fg-primary); font-weight: 600; }
  .own-reply-icon { color: var(--fg-muted); vertical-align: -2px; }
  .mark-unread-icon {
    display: inline-block; background: none; border: none; cursor: pointer; color: var(--fg-muted);
    font-size: .8rem; line-height: 1; padding: 0 .2rem; vertical-align: middle;
  }
  .mark-unread-icon:hover { color: var(--fg-primary); }
  .earlier-comments summary { cursor: pointer; color: var(--fg-muted); margin-bottom: .5rem; }
  .usage-meter { display: flex; flex-direction: column; gap: .6rem; margin-bottom: 1rem; }
  .usage-row { display: grid; grid-template-columns: 1.5rem 2.5rem 1fr auto; gap: .4rem; align-items: center; font-size: .8rem; }
  .usage-label { font-weight: 600; }
  .usage-pct { text-align: right; }
  .usage-bar { grid-column: 3; height: .5rem; background: #8b8685; border-radius: 999px; overflow: hidden; }
  .usage-bar-fill { height: 100%; background: var(--accent-lime); }
  .usage-resets { grid-column: 1 / -1; font-size: .7rem; }
  .pacemaker-ahead { color: var(--ok); }
  .pacemaker-behind { color: var(--warn); }
`;

/**
 * Wrap page content in the standard document shell. When `sidebar` is given
 * (HTML for the dashboard's "recent bot activity" panel), it's rendered as a
 * sticky left rail that's part of the shell itself — present on every
 * logged-in page, not just one — via a single `.app-shell` flex row; without
 * it, the page renders as a plain single column like before. The rail is
 * collapsible (a small toggle button, state remembered in localStorage so it
 * stays collapsed/expanded across page loads).
 */
export function layout(title: string, body: string, sidebar?: string): string {
  const page = `
<header>
  <h1><a href="/">🐾 claw</a></h1>
</header>
${body}`;
  const shellBody = sidebar
    ? `<div class="app-shell">
  <aside class="app-sidebar" id="app-sidebar">
    <button type="button" class="sidebar-toggle" id="sidebar-toggle"></button>
    ${sidebar}
  </aside>
  <div class="app-main"><div class="page">${page}</div></div>
</div>
<script>
(function () {
  var aside = document.getElementById("app-sidebar");
  var toggle = document.getElementById("sidebar-toggle");
  var KEY = "claw-sidebar-collapsed";
  function apply(collapsed) {
    aside.classList.toggle("collapsed", collapsed);
    toggle.textContent = collapsed ? "»" : "«";
    var label = (collapsed ? "Expand" : "Collapse") + " sidebar";
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
  }
  var collapsed;
  try { collapsed = localStorage.getItem(KEY) === "1"; } catch (e) { collapsed = false; }
  apply(collapsed);
  toggle.addEventListener("click", function () {
    collapsed = !collapsed;
    try { localStorage.setItem(KEY, collapsed ? "1" : "0"); } catch (e) {}
    apply(collapsed);
  });
})();
</script>`
    : `<div class="page">${page}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
${
    sidebar
      ? '<script async src="https://cdn.jsdelivr.net/npm/iconify-icon@2.1.0/dist/iconify-icon.min.js"></script>\n' +
        '<script type="module" src="https://cdn.jsdelivr.net/npm/@github/relative-time-element@5.3.0/dist/bundle.min.js"></script>'
      : ""
  }
</head>
<body>
${shellBody}
</body>
</html>`;
}
