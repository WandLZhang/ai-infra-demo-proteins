# AI Models Slide — Design Spec

**Date:** 2026-06-01
**Author:** Willis (brainstormed with Claude)
**Status:** Approved — ready for implementation plan

## Purpose

Add the "AI Models Only Google Has" section to the NIH Biowulf demo as three sequential info-box slides (`models1`, `models2`, `models3`), with a hero-sized centered info box and a live 3D rendering of the AF2-TPU output protein covering the side ladder.

This is the deck's keynote moment — the visual job is to (a) carry dense talk-track content in a hero info box, and (b) prove "AlphaFold ran on our infrastructure five minutes ago" by rendering the actual PDB the demo produced.

## Slide structure

Three slides, all sharing the same layout and 3D panel; only the info-box content changes between them.

| Phase | Title | Content (verbatim from `talk_track.md`) |
|---|---|---|
| `models1` | AI Models Only Google Has | Hassabis/Kohli quote + Nature Index baseline (Alphabet #3, Microsoft #27, Amazon #90) + the 7-model Google-exclusive catalog |
| `models2` | (cont.) | Gemini for Science (3 Google Labs experiments) + Science Skills (AK2 gene example, Antigravity, 30+ databases) + Scientific peer review (PAT, ScholarPeer) |
| `models3` | (cont.) | Isomorphic Labs $2B + Federal precedent (DOE Genesis, CHOP, CMU, Purdue, SUNY, ODU) + closing frame (Transformer/TF/K8s/JAX → single-vendor stack) |

Titles for `models2` and `models3` are TBD during wordsmithing — start with the same title across all three slides (matches keynote rhythm) and refine later.

Navigation: `tpu3 → models1 → models2 → models3 → done`. Left arrow reverses.

## Layout

Three vertical columns:

```
┌──────────┬──────────────────────────────────────────┬──────────┐
│ terminal │   AI MODELS ONLY GOOGLE HAS              │   3D     │
│ (left)   │   [hero info box, scrollable, ~58vw]     │ PROTEIN  │
│ ~22vw    │   [content from talk_track.md]           │  ~20vw   │
│          │                                          │ covers   │
│          │                                          │ ladder   │
└──────────┴──────────────────────────────────────────┴──────────┘
```

- **Terminal** (~22vw, left): unchanged.
- **Hero info box** (~58vw, centered): a new variant of `InfoButton` (see Components). Wider, taller, and centered instead of the current top-right popover. Hamburger menu still toggles it.
- **3D protein panel** (~20vw, right): new `ProteinViewer` component. Sits where the side ladder is, visually covering it. Side ladder is not unmounted — it continues rendering underneath but is hidden by stacking order. Re-emerges when leaving the models phases.

Map stays visible behind everything, zoomed to default CONUS view (center `{39.5, -98.35}`, zoom 5). Falls through the existing `else` clause in App.tsx since `models1/2/3` are not in any `isMd / isPd1 / isTpu` group.

## Components

### Modified

#### `src/App.tsx`
- Extend `Phase` union with `'models1' | 'models2' | 'models3'`.
- Add `const isModels = phase === 'models1' || phase === 'models2' || phase === 'models3'`.
- Forward + reverse navigation: extend the existing `ArrowRight`/`ArrowLeft` chain so `tpu3 → models1 → models2 → models3 → done` flows correctly in both directions.
- Title selector: add three entries for the models phases.
- Section bodies: add three entries with talk-track content (HTML-formatted with `<ul>`, `<li>`, `<a>`, `<b>` tags; same pattern as existing tpu1/tpu2 slides).
- Pass `variant={isModels ? 'hero' : 'popover'}` to `<InfoButton>`.
- Render `<ProteinViewer />` conditionally on `isModels`.

#### `src/components/InfoButton.tsx`
- Add prop: `variant?: 'popover' | 'hero'` (default `'popover'` — preserves existing behavior on all non-models slides).
- When `variant === 'hero'`, the open popover renders as a centered ~58vw panel with larger inner padding and font scale. Container class branches: `info-popover` (existing) vs `info-popover-hero` (new).
- All other behavior — `open`/`onToggle`, title rendering, `dangerouslySetInnerHTML` of section bodies, `key={title}` cross-dissolve — is unchanged.

#### `src/hud.css`
- Add `.info-popover-hero` rules: centered (`left: 50%; top: 50%; transform: translate(-50%, -50%)`), `width: 58vw`, `max-height: 80vh`, slightly larger font scale than the popover variant, opaque dark background (matches existing HUD), cyan border.
- Reuse the existing `softFadeIn` animation for entry — no transform inside the keyframe so the centering transform isn't overridden.

### New

#### `src/components/ProteinViewer.tsx`

Wraps 3Dmol.js. Responsibilities:
1. On mount and every 30 seconds, fetch `https://storage.googleapis.com/storage/v1/b/wz-nih-demo-shared/o/job%2Faf2-tpu.pdb` and read the `updated` field from the JSON response.
2. If `updated` is new since the last fetch (or first load), fetch the raw PDB body at `https://storage.googleapis.com/wz-nih-demo-shared/job/af2-tpu.pdb`. Call `viewer.clear()` → `viewer.addModel(pdbText, "pdb")` → `viewer.setStyle({}, { cartoon: { color: "#09d3ac" } })` → `viewer.zoomTo()` → `viewer.spin("y", 0.5)`.
3. Render the EST-converted `updated` timestamp below the viewer canvas. Use `Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })`. Format: `INFERRED 2026-06-01 14:32:18 EST`.

Container: fixed-position div at the right edge, ~20vw wide, full viewport height, dark transparent background. 3Dmol viewer canvas fills most of it; timestamp label sits at the bottom in monospace cyan-grey.

Assumes the PDB always exists. No error states, no loading spinner, no fallback. If something breaks on demo day, you see a black panel and fix manually (the bucket will be seeded with at least one warm run before the demo).

### Untouched

- `SideLadder`, `InfraMap`, `ZoneMarker` — no changes. They render normally on the models slides; the `ProteinViewer` panel just visually covers the side ladder.

## Dependencies

- `3dmol` via `npm install 3dmol`. ~500KB gzipped. Local install instead of CDN avoids load-time delays during the demo.

## Animation

- `ProteinViewer` panel and hero info box both fade in via the existing `softFadeIn` keyframe (opacity + blur only, no transform — same fix as the russian-doll boxes to avoid the "hop").
- 450ms ease.
- Info box content cross-dissolves between `models1 → models2 → models3` via the existing `key={title}` remount pattern.
- 3D structure rotates continuously at 0.5 rad/sec around the Y axis via `viewer.spin("y", 0.5)`. No interactive controls.

## Visual style

- Hero info box: solid black background (`#000`), 1.5px cyan border (`#09d3ac`), font scale slightly larger than the popover variant (title 22px, body 14px vs popover's 18px / 13px). Title in BaronNeue uppercase (existing pattern). Body in 'Google Sans' with `<a>` styled cyan, `<code>` styled yellow (existing `.info-body` rules apply).
- 3D structure: cyan cartoon ribbon (`#09d3ac`), transparent canvas background, continuous Y-axis rotation.
- Timestamp label: `Courier New` monospace, 10px, color `#708090`, uppercase, letter-spacing 0.12em — matches `.bucket-label-meta` / `.md-doll-storage-meta` from elsewhere in the HUD.

## Testing

Manual visual verification via Playwright (extend `tests/md-doll-inspect.spec.ts` or add new file):
1. Press Enter, then right-arrow through to `models1`. Confirm: hero info box is centered, ProteinViewer panel visible on right with rotating cyan structure, EST timestamp label below.
2. Right-arrow to `models2`. Confirm: same panel, info-box content cross-dissolves to new content.
3. Right-arrow to `models3`. Confirm: same panel, info-box content updates again.
4. Left-arrow back through. Confirm: panel disappears when leaving models, side ladder re-appears.
5. Verify EST timestamp matches the actual GCS object's `updated` field for `gs://wz-nih-demo-shared/job/af2-tpu.pdb`.

No unit tests — this is a presentation UI driven by user keyboard input. Visual confirmation is the only meaningful verification.

## Out of scope

- Bullet-list breakdown / interactive model-catalog clicks.
- Multiple structure renderings (only AF2-TPU's output; ESMFold and Boltz-2 outputs are not rendered).
- 3D viewer interactivity (zoom, rotate by drag). Hands-off rotation only.
- Wordsmithing of section titles or content. Talk-track content goes in verbatim and is refined later.
- Federal precedent map markers. Considered but cut — the hero info box + 3D panel together carry enough visual weight.
- Nature Index scoreboard overlay. Considered but cut for the same reason.

## Risks

- **3Dmol.js bundle size** adds ~500KB gzipped to the frontend bundle. Acceptable for a demo, but bumps the first-load time slightly. Mitigated by Cloud Run + CDN edge caching.
- **GCS metadata poll** runs every 30s while ProteinViewer is mounted. ~30 requests/hour, well under any quota. The bucket is already public-read so no auth path to break.
- **Demo-day file absence** (PDB doesn't exist at expected path) — produces a black panel. Mitigation: seed with at least one warm AF2-TPU run before the briefing.
