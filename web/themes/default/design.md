# Artifact design guide

This guide is for AI agents that publish to this 9artifacts. Follow it so
every artifact looks like it belongs to the same owner. The owner can edit
this file (`9artifacts theme init`) to change the house style.

## Format

- One self-contained `index.html` is the default. Inline CSS and JS.
  Put large images or data next to it (`assets/chart.png`, `data.json`)
  and reference them with relative paths.
- Use Markdown (`report.md`) for text-heavy documents with no layout needs.
- Libraries may load from `https://cdnjs.cloudflare.com` or
  `https://cdn.jsdelivr.net` with a pinned version. No analytics, trackers
  or remote fonts that phone home.
- The page runs in a sandbox: no cookies, no `localStorage` guarantees, no
  access to the 9artifacts API. Keep state in memory.
- Always set a meaningful `<title>`; it becomes the artifact title.

## Look

- Calm, editorial, generous whitespace. Content width 720–1100px.
- Typography: system UI sans-serif for text, monospace for code and
  numbers in tables. Base size 16px, line height 1.6.
- Colours (CSS custom properties, support dark mode):

  | Token        | Light     | Dark      | Use                         |
  |--------------|-----------|-----------|-----------------------------|
  | `--bg`       | `#f6f5f1` | `#161614` | page background             |
  | `--surface`  | `#ffffff` | `#1f1e1c` | cards, tables               |
  | `--text`     | `#1d1c1a` | `#edebe6` | body text                   |
  | `--muted`    | `#85827a` | `#8e8b83` | captions, secondary text    |
  | `--border`   | `#e4e2dc` | `#33322e` | hairlines                   |
  | `--accent`   | `#1f6f5c` | `#5cc2a3` | links, highlights, primary  |
  | `--danger`   | `#c2410c` | `#f08a5d` | errors, negative deltas     |

- Radius 12px on cards, 8px on controls. Soft shadows only.
- Charts: use the accent colour first, then `#4b5bb5`, `#b4441f`,
  `#8a5a00`. Label axes; never rely on colour alone.

## Structure

1. A header with the title, a one-line summary and the date.
2. Key numbers or the conclusion first, details after.
3. Sections with clear `h2` headings; tables for comparisons.
4. Responsive down to 360px wide; test that nothing overflows.
5. A `@media print` block so the artifact prints cleanly.

## Updating

To change an artifact, publish again with its id (`publish_artifact` with
`id`, or `9artifacts publish --update ID`). The URL stays the same and the
owner's open tab refreshes automatically.
