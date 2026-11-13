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
      <i class="led"></i>
      <div class="n">Router</div>
      <div class="a">192.168.2.1</div>
      <div class="tip"><b>Router</b>Only :443 is forwarded.</div>
    </div>
    <div class="link live" tabindex="0">
      <span class="lbl">:443</span>
      <span class="line"><i class="pkt"></i><i class="pkt" style="--d:1.4s"></i></span>
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
- Make it look alive, the way a rack does. Every node that is running gets
  a status light: `<i class="led"></i>` (green), `led warn`, `led bad`.
  A link that carries traffic is `link live` (dashes march along it) with
  one to three packets; a broken one is `link down`. A failing node is
  `node bad` (it pulses red), a degraded one `node warn`. Stagger lights
  and extra packets with `style="--d:.6s"` so they never blink in step.
- State is information, not decoration: blink only what is really up, slow
  or down, and say which in the legend (`<i class="led warn"></i>slow`
  works there too).
- Other agents read the diagram as text (`?format=md`): the name comes from
  `.n`, the address from `.a`, the link label from `.lbl`, the explanation
  from `.tip` and the state from the classes above. Keep those in place and
  the diagram explains itself without being rendered.
- One accent colour and the house tokens. The kit already stops every
  animation under `prefers-reduced-motion` and in print.

## Slides

A presentation, lesson or pitch is a deck, not a long page. Start from the
slides template: `get_design_guide` with `kind: "slides"`,
`9artifacts design --kind slides` or `GET /template.html?kind=slides`.

- Each `<section class="slide">` is a fixed 1280×720 stage that the script
  scales to the window, so size everything in px and never let a slide
  scroll. If it does not fit, split it.
- One idea per slide: a heading and at most five short bullets, three
  numbers, one chart or one diagram. The detail belongs to the speaker.
- `class="step"` reveals an element one press at a time.
- Keep the script as it is: arrows, space, click and swipe move; `F` goes
  fullscreen; `P` prints one slide per page, which is how the owner saves
  a PDF.

## Documents

A letter, lesson plan, minutes or anything that will be printed or signed
starts from the document template: `kind: "document"`.

- Each `<article class="page">` is one A4 sheet with print margins built
  in. Start a new `.page` where the document must break.
- Serif body at 12pt, headings in the accent colour on screen and black in
  print. Tables for schedules; a `.sign` block for signatures.
- Write in the language and form the owner's organisation uses; the
  template's field names are placeholders.

## Updating

To change an artifact, publish again with its id (`publish_artifact` with
`id`, or `9artifacts publish --update ID`). The URL stays the same and the
owner's open tab refreshes automatically.
