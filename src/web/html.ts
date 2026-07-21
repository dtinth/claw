/** Minimal server-rendered HTML helpers (no client-side framework). */

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
    max-width: 780px; margin: 0 auto; padding: 1.5rem;
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
`;

/** Wrap page content in the standard document shell. */
export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1><a href="/">🐾 claw</a></h1>
</header>
${body}
</body>
</html>`;
}
