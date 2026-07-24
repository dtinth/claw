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

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0;
  }
  .app-shell { display: flex; align-items: flex-start; }
  .app-sidebar {
    flex: 0 0 16rem; box-sizing: border-box; border-right: 1px solid #8884;
    padding: 1rem; position: sticky; top: 0; height: 100vh; overflow-y: auto;
  }
  .app-main { flex: 1; min-width: 0; }
  .page { max-width: 780px; margin: 0 auto; padding: 1.5rem; }
  @media (max-width: 700px) {
    .app-shell { flex-direction: column; }
    .app-sidebar {
      flex: none; width: 100%; height: auto; position: static;
      border-right: none; border-bottom: 1px solid #8884; order: 2;
    }
    .app-main { order: 1; }
  }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h1 a { color: inherit; text-decoration: none; }
  .muted { color: gray; }
  form.inline { display: inline; }
  label { display: block; margin: .75rem 0 .2rem; font-weight: 600; }
  input[type=text], input[type=number], select, textarea {
    width: 100%; padding: .45rem .55rem; border: 1px solid #8888; border-radius: 6px;
    background: transparent; color: inherit; font: inherit;
  }
  textarea { min-height: 8rem; }
  button {
    padding: .5rem .9rem; border: 0; border-radius: 6px; cursor: pointer;
    background: #2563eb; color: white; font: inherit; font-weight: 600;
  }
  button.secondary { background: #6b7280; }
  .preset-row { display: flex; gap: .4rem; flex-wrap: wrap; margin: 0 0 .6rem; }
  button.preset { padding: .3rem .6rem; font-size: .85rem; font-weight: 500; background: #4b5563; }
  .row { display: flex; gap: .75rem; align-items: flex-end; }
  .row > * { flex: 1; }
  fieldset { border: 1px solid #8884; border-radius: 8px; margin: 1rem 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #8883; }
  code, pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #8882; border-radius: 6px;
  }
  code { padding: .1rem .3rem; }
  pre { padding: .8rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .grid { display: grid; grid-template-columns: 10rem 1fr; gap: .3rem .8rem; align-items: center; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .ok { color: #16a34a; } .warn { color: #d97706; }
  .copy-row { display: flex; gap: .5rem; align-items: center; }
  .copy-row input[type=text] {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .copy-row button { flex: none; }
  .app-sidebar h3 { margin: 0 0 .5rem; font-size: 1rem; }
  .sidebar-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .7rem; }
  .sidebar-list li { font-size: .85rem; overflow-wrap: anywhere; }
  .sidebar-list li.prominent {
    border-left: 3px solid #d97706; padding-left: .5rem; margin-left: -.5rem;
  }
  .sidebar-list time { display: block; color: gray; font-size: .75rem; }
  .sidebar-list .excerpt {
    margin: .2rem 0 0; color: gray;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .sidebar-list .excerpt.prominent { color: inherit; font-weight: 600; }
`;

/**
 * Wrap page content in the standard document shell. When `sidebar` is given
 * (HTML for the dashboard's "recent bot activity" panel), it's rendered as a
 * sticky left rail that's part of the shell itself — present on every
 * logged-in page, not just one — via a single `.app-shell` flex row; without
 * it, the page renders as a plain single column like before.
 */
export function layout(title: string, body: string, sidebar?: string): string {
  const page = `
<header>
  <h1><a href="/">🐾 claw</a></h1>
</header>
${body}`;
  const shellBody = sidebar
    ? `<div class="app-shell">
  <aside class="app-sidebar">${sidebar}</aside>
  <div class="app-main"><div class="page">${page}</div></div>
</div>`
    : `<div class="page">${page}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${shellBody}
</body>
</html>`;
}
