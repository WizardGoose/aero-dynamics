# Aero-Dynamics — Create Aeronautics Ship & Shape Studio

A fast, self-contained studio for Create mod airships (Create Aeronautics), rebuilt around
shapes and ships: **balloons, propellers, wings, rhombus crystal shard ships, classic shape
primitives, and a schematic audit lab** — with the lift/burner math built into every relevant
tab and every model exportable as a real schematic.

| module | what it generates |
|---|---|
| **Balloon** | hot-air envelopes (balloonshaper profile), ribs, keel, fins, burner-exact interior — **with the full lift/burner math live in the tab** |
| **Propeller** | 2–12 blade propellers, swept/curved, wool or sail — **with swept-disc and material math live in the tab** |
| **Wings** | copycat-wing planforms (tapered / delta, swept, mirrored) |
| **Crystal** | rhombus crystal shards, Blade & Sorcery style — double-terminated (a point at both ends), lying horizontal like a bullet in flight (upright optional), deliberately imperfect (seeded jitter, twist, lean, asymmetric taper, truncation, cracks, inclusions); the studio sizes the cavity's burners and lift, you fit the interior |
| **Shapes** | sphere, ellipsoid, cylinder, cone, pyramid, torus, dome — hollow or solid, in wool / planks / logs / glass |
| **Lab** | drop in any `.schem` / `.nbt` / `.litematic` (Sponge v2 / structure / Litematica, gzipped or raw): block census, namespace breakdown, mass estimate, Create Aeronautics part census and a **center-of-mass report** (Create-style block weights), with a 3D view and a jump into the crystal balance check |

**Textures** — the 3D preview renders with real in-game textures, extracted from the vanilla
1.21.1 client jar and the exact mod jars in the pack (`textures/`), pixel-filtered like
Minecraft; glass and amethyst crystals render translucent, glass inclusion patches render
like glass and glow-block inclusions glow. If a texture can't
load (e.g. `file://`), the preview falls back to flat colors automatically.

**Handbook** — `wiki.html` is the Create Aeronautics handbook, rebuilt as a **Ponder-style
interactive guide** (Create's Ponder mechanic): 10 scenes, 50 narrated steps with key-block
chips, in-world diagrams, auto-play and studio deep-links. Physics values are all from mod
source; airship anatomy, seven example builds with studio links, the math, a component
reference and troubleshooting.

## The crystal shard

The Crystal tab generates a hollow voxel crystal in the Blade & Sorcery shard style:
**double-terminated** — a single point block at BOTH ends (the `/\` over `\/` diamond) —
with the widest band where you want it (`midY`, plus an optional straight `midBand` prism
stretch). Shards **lie horizontal** by default: the long axis runs along X, nose forward,
like a bullet in flight — one click flips them upright — and the default shard carries a
**1-block nose dip** (the dip slider works in blocks, 0–20, quarter-block steps). The
**center** can be odd (a single block at the cross-section middle) or even (the middle
lands on a 2×2 junction); the tab shows which one you're on. It is a pure shard: no
deck, no drive. The cavity is your hot-air interior — the tab reports its volume, the
burners it needs (1 adjustable burner per 500 blocks) and the lift (1.5 per heated
block, per the mod's own config), so you know exactly what your interior can weigh.

Real crystals are never perfect, and this one isn't either — every inconsistency is a slider:

- **facets** (3–10; 4 = rhombus), **taper curve**, **truncated tip** (a broken shard)
- **twist**, **vertex jitter**, **lean** (X/Z — the bullet angle), **asymmetric taper**
- **cracks** — sealed grooves carved along short seeded lines (the hull stays airtight; the cavity never vents), **inclusions** — patchwork variants (any mix of glass and glow blocks, as many as you like),
  sized as a **percentage of the hull** so big crystals glow proportionally more than small ones
- **seed** — the same seed + sliders always reproduce the exact same shard, so share links
  and tests are deterministic

Materials: every glass in the game — clear, tinted, and all 16 stained glass colors — plus amethyst, or aeronautics levitite / pearlescent levitite. Inclusion patches are variants you stack: each is a material with its own % of the hull, generated in seeded patches (e.g. three glass types for patchwork crystal texturing) — pick any glass, sea lantern, amethyst, glowstone, shroomlight or froglight.
Every preset flies out of the box once you fit its interior.

## The math is in the tabs

The old separate Math page is gone — the math now lives where the shape lives:

- **Balloon & Crystal**: interior volume → burners (`ceil(interior / 500)`), covered/waste,
  lift (`interior × 1.5`), estimated craft mass (blocks × avg block mass + payload), net lift
  and a flies/too-heavy verdict, with `blockMass`/`payload` sliders right in the panel. For
  the crystal this is the cavity math for the interior *you* fit.
- **Propeller**: swept disc diameter (`2 × length`) and area (`π × length²`), blocks per
  blade, disc coverage, material totals and the one-bearing-per-propeller mount rule.

The machines / ships / math tabs of the old generator are gone entirely.

## Why this fork

- **Performance** — per-slice ellipse fill instead of a triple-nested loop, flat `Uint8Array`
  voxel grids, frontier-based shell peeling, typed-array output. Generation runs in a **Web
  Worker** (with a main-thread fallback for `file://`), so the UI never blocks. Sliders are
  debounced, the 3D preview reuses geometries, and spin is off by default.
- **Burner matching for Create Aeronautics** — live stats bar + requirements panel show the
  interior (enclosed air) volume, burners needed (1 per 500 blocks), wasted lift, and
  **vol/wool efficiency**. An **EXACT ✔** badge shows when the interior is a multiple of 500.
  Balloon presets are ranked by efficiency; crystal presets are all flight-tested (net > 0).
- **Minimal envelope (eliminate redundant blocks)** — enabled by default: only blocks that
  touch air are kept, exactly like removing the support block below each new layer when
  building by hand.
- **True hot-air balloon profile (balloonshaper.xyz)** — the exact closed-form profile from
  balloonshaper.xyz: narrow throat, sine flare to full width at 62% of the height, crown
  tapering to a point. ★ = exact 500-multiple; ≈ = a block or two short.
- **Deterministic imperfection** — the crystal engine uses a seeded PRNG (mulberry32): a
  share link reproduces the identical shard, cracks and all.
- **Sun & shadows** — the preview is lit by a directional sun with real shadow
  mapping (PCF-soft): models self-shadow and throw a contact shadow on the ground plane,
  and the sun's shadow frustum refits to each model. A startup probe detects software
  rasterizers that can't sample shadow maps and brightens the fill lights instead, so
  the preview is never murky.
- **Natural light** — every preview block gets a deterministic per-block brightness
  variation (faceted glints on crystals), so walls of identical blocks don't read as one
  flat colour.
- **One hub block** — propellers always carry exactly one center block, the way a real
  bearing mounts.
- **Odd/even centers** — the crystal tab lets you choose whether the cross-section
  middle is a single block or a 2×2 junction, and reports it live.
- **Balance checker** — the Crystal tab takes your ship schematic (drop it in) and
  renders it inside the shard. A full **six-axis report**: back/forth, left/right and
  up/down COM offsets, tilt (roll), pan (pitch) and yaw — each axis graded, with an
  overall **PERFECTLY STRAIGHT / WONKY / UNEVEN** verdict and per-axis fix
  instructions ("shift ~N mass-blocks toward the tail"…). **Ship placement sliders**
  slide the ship inside the shard and re-check the combined craft live, and
  **Auto-trim** one-clicks the position that zeroes the combined COM. Block masses
  use a Create-style weight table (casing 4, brass 5, shaft 2, cogwheel 3, tank 3,
  steam engine 8…), default 1 — the same assumption as the blockMass slider. The Lab
  reports the same six axes for any schematic on its own.
- **Client-side schematic export** — two real formats with real `Properties`
  (facing, axis, powered…) for every stateful block:
  - **`.nbt`** — gzipped structure NBT, the **Create mod schematic** format: drop it
    into Create's `schematics/` folder and the Schematicannon prints it directly.
  - **`.litematic`** — native **Litematica / Forgematica** format (Version +
    MinecraftDataVersion + Metadata + region with variable-bit `BlockStates`), so
    Litematica loads your build as-is, metadata included.
  The **Center block** toggle adds a single sea lantern at the model's exact middle —
  a visible center reference when you paste.
- **Schematic lab** — the same NBT machinery in reverse: parses modern (1.20.2+) and legacy
  list layouts, gzipped or raw, fully client-side.
- **Share links** — compact hash URLs per tab, one prefix per module (`b3` balloon, `p3`
  prop, `w4` wings, `c5` crystal, `h5` shapes); links round-trip in the test suite.
- **Ponder-styled guides** — every model ships a build sequence with per-step text,
  scrubbing and auto-play; the guide shows the **current layer plus the previous one**
  (dimmed, off-color), and blocks that **stack on the previous layer get a third
  color**; balloons and crystals also get a cut-section view into the cavity. The guide
  viewport is draggable and wheel-zoomable, and the handbook (`wiki.html`) is a full
  Ponder player: 10 scenes, 50 narrated steps, in-world diagrams and studio deep-links.
- No ads, no analytics, no htmx, no server.

## GitHub Pages

Push it to GitHub and it compiles and deploys itself. The workflow
(`.github/workflows/deploy-pages.yml`) runs on every push to `main` **or** `master`:
it **compiles the site** (`npm run build` — syntax-checks every script the pages ship,
verifies the texture manifest against `textures/`, and emits the release into `_site/`),
runs the test suite, then uploads `_site/` as the Pages artifact and deploys it.

1. Create a repo and push: `git remote add origin <url> && git push -u origin master`
2. On GitHub: **Settings → Pages → Source → GitHub Actions** (no branch deploy needed)
3. Every push redeploys; the site lands at `https://<user>.github.io/aero-dynamics/`

## Run

```
cd aero-dynamics
python3 -m http.server 8000     # any static server works
# open http://localhost:8000
```

Opening `index.html` directly from disk also works (the engine falls back to main-thread
generation if the browser blocks Web Workers on `file://`).

## Test

```
npm test                        # node --test, no dependencies
```

- `tests/engine.test.js` (33 tests) — balloon parity against the original engine (exact
  hot-air presets land exactly on their 500-multiples), propeller/wings invariants (incl.
  the force-one-block-center hub + root-row regression), crystal determinism + structure
  invariants + flight math, shapes primitives, schematic reader
  (modern + legacy + gzip + garbage), dispatch, perf smoke.
- `tests/ui.test.js` (14 tests) — boots the real inline script in a stubbed DOM: every tab
  generates, stat labels switch, share links round-trip per tab, a crystal link routes and
  regenerates, a crystal schematic export re-audits through the lab reader, the lab tab
  handles drops and rejects garbage, the force-center checkbox drives the prop engine, and
  every handbook link in the Ponder wiki decodes and generates.
- `tests/images.test.js` (4 tests) — every texture is structurally validated (signature,
  IHDR/IDAT/IEND, chunk CRCs, palette rules), converted to token variants (base64 +
  sha256) that round-trip byte-for-byte, and cross-checked against every texture path the
  site references. The token manifest lives at `textures.tokens.json`.
- `tests/browser.test.js` (1 test, optional) — a real headless-Chromium pass: boots the
  site, generates every tab, checks the requirements panels, round-trips a share link,
  exports a crystal schematic in-page and re-audits it in the lab, routes a handbook link,
  and fails on any console/page error. Skipped automatically when playwright isn't
  installed; run it with:

  ```
  npm i playwright && npx playwright install chromium   # + install-deps on Linux
  NODE_PATH=$(npm root -g) node --test tests/browser.test.js
  ```

## Files

| file | purpose |
|---|---|
| `index.html` | UI, 3D preview (three.js, real textures), requirements math panels, NBT export, share links, Ponder-style guide, schematic lab |
| `wiki.html` | the Create Aeronautics handbook (physics, builds, math, reference) |
| `textures/` | real block textures from the vanilla client jar + the pack's mod jars (+ generated sail canvases) |
| `textures.tokens.json` | token manifest: sha256 + base64 + dimensions for every texture |
| `engine.js` | the generation engine (balloon, propeller, wings, crystal, shapes, requirement math, schematic reader) |
| `engine-worker.js` | Web Worker entry point (dispatches every module + the crystal solid pass) |
| `three.min.js` | vendored three.js r160 (same version the original site uses) |
| `tests/` | the node:test suite |
| `COMPONENTS.md` | component map extracted from the exact pack jars |

## Notes

- Balloon interior volume = solid ellipsoid cells − structure cells. For the exact-multiple
  presets nothing is inside the cavity, so interior = solid − shell, verified against the
  original engine including ribs, keel, fins, side fins, all shells 1–5, solid mode and every
  propeller variant.
- Ribs/keel/fins don't change the interior (ribs recolor shell blocks; keel and fins attach
  outside), so you can add them after picking a size.
- Crystal interior = solid − hull (cracks are sealed grooves, so they never open the cavity;
  stray rasterization air pockets are filled with crystal; a solid shard has no cavity).
  `interior + crystal + inclusions = solid` always holds for hollow shards — the tests
  enforce it.
- The lab reports the **occupied** bounding box, not the schematic's nominal size field.
