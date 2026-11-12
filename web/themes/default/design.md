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

## Diagrams

A topology or flow is a diagram, not a write-up. Names and addresses sit on
the boxes. The explanation — what a hop does, which header is written, what
breaks if a port is wrong — goes in a tooltip, shown on hover or focus.

Use the diagram kit. Fetch `GET /diagram.css` (also appended to
`get_design_guide` and `9artifacts design`) and **inline** it. Do not link
it: the page is sandboxed and may be served from another origin.

```html
<div class="d">
  <div class="flow">
    <div class="node" tabindex="0">
      <div class="n">Router</div>
      <div class="a">192.168.2.1</div>
      <div class="tip"><b>Router</b>Only :443 is forwarded.</div>
    </div>
    <div class="link" tabindex="0">
      <span class="lbl">:443</span>
      <span class="line"><i class="pkt"></i></span>
    </div>
    <div class="node mark" tabindex="0">
      <div class="n">nginx</div>
      <div class="a">10.36.67.4</div>
    </div>
  </div>
</div>
```

Rules:

- A connector is a `.link` between two nodes, or a `.drop` in the gap above
  the next row. Never `position` a line so it crosses a node — that is the
  bug where a laptop sits on top of its own arrow.
- A second path (a LAN bypass, a fallback) is another `.flow`, not an
  overlay. `.flow.end` right-aligns that row; `.drop` meets the centre of
  its last node and stops at the top of the box.
- Under 860px the kit stacks the row into a column; an end row is stacked
  last node first, so the `.drop` still lands on it. Do not add a second
  layout by hand.
- One accent colour, the house tokens, a moving packet. Respect
  `prefers-reduced-motion`. A legend of three items is enough.

## Updating

To change an artifact, publish again with its id (`publish_artifact` with
`id`, or `9artifacts publish --update ID`). The URL stays the same and the
owner's open tab refreshes automatically.
