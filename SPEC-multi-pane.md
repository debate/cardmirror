# Multi-pane document view — spec (v3, implemented)

Single-window UI that holds up to three documents side by side,
sharing a ribbon and a nav pane. Originally drafted 2026-05-14 (v3,
two rounds of answers folded in). **Implementation is complete and
merged into main.** Spec retained here as the design rationale of
record; for the live behavior, the code is authoritative.

## 1. Goals

- Read and edit multiple debate files simultaneously in one window
  (e.g., open-source file + your speech doc + their speech doc) without
  Alt-Tabbing.
- Move/copy content between docs via drag (always copy across docs).
- Keep the shared chrome (ribbon, nav, status bar's zoom) coherent.

## 2. Master switch: "Multi-doc"

A single setting toggles the whole multi-pane shell.

- **OFF (default):** today's single-doc behavior. Comments visible.
  One open file at a time; opening a new one replaces / prompts to
  close.
- **ON:** three logical slots, each holding a stack of 0+ docs.
  Comments are **disabled** entirely in this mode (no comments
  column, no @-mention flows, no comment-related ribbon actions).

Setting lives in the Settings dialog under a new "Workspace" group
(top of the settings list, before "Display"). Label: **"Multi-doc
workspace"** with a short description: "Enable a three-slot side-
by-side workspace. Comments are unavailable while this is on."

## 3. Slot model

When multi-doc is ON:

- Three persistent slot IDs: `slot1`, `slot2`, `slot3`.
- Each slot is a stack of 0+ doc records, with at most one "visible"
  per slot. Hidden docs in the stack keep a live `EditorView`
  (per Q14: simpler than serialize/restore; memory cost accepted).
- Slots render in numeric order, left → right. Empty slots take no
  space — they're skipped, not shown as placeholders.
- Slot identity is persistent: routing to `slot3` always means the
  rightmost slot conceptually, even if `slot1`/`slot2` are empty
  (in which case `slot3`'s doc fills the screen alone).

### Layout count → visible cells

| Active slots | Editor area | Nav pane |
| --- | --- | --- |
| 0 | empty state / start screen | empty |
| 1 | full width | full height |
| 2 | 50/50 split | split in half (equal halves) |
| 3 | Compact OR Wide-scroll (see §4) | split into thirds (equal) |

(Active = stack has at least one doc.)

## 4. Compact vs Wide-scroll (only meaningful at 3 slots)

A sub-toggle that only changes rendering when all three slots are
populated. With 1 or 2 active slots the two modes look identical.

- **Compact (image 1):** all 3 panes fit side by side, each ~1/3
  of available width.
- **Wide-scroll (image 2):** the 3-pane row is wider than the
  viewport; user sees 2 full panes + edge of 3rd. Paged horizontal
  scroll — clicking the peek snaps to the next doc, no in-between
  positions. (Q4 resolved: paged, not continuous.)

- **Pane widths:** fixed. No user-draggable splitters in v1.
- **Persistence:** mode toggle persists across sessions in settings.

## 5. Pane anatomy

Top → bottom inside each pane:

1. **Doc title chip** — minimal, *much smaller* than in the drawing.
   Just the doc filename in a single line at the top of the pane.
   In a single-doc stack, the chip is plain text. In a multi-doc
   stack, the chip is the dropdown trigger that lists every doc in
   the stack (§9).
2. **Editor area** — a live ProseMirror `EditorView` for the
   currently-visible doc in this slot's stack.
3. **Footer** — per-pane word-count strip (matches the bottom-of-
   image-1 sketch). Shows word counts using the user's configured
   reader settings. The strip is per-pane and reflects the doc
   currently visible in that pane.

No comments column anywhere when multi-doc mode is on.

## 6. Focus model + shared ribbon

A single ribbon at the top of the window. Commands target the
focused pane.

- Click anywhere inside a pane's editor → that pane becomes focused.
- Visual cue: a subtle highlight on the focused pane's title chip
  + a slightly heavier border / accent on the pane body.
- Sticky last-focused fallback: if focus moves to the nav, ribbon
  still routes to whichever pane was last focused. (Word's behavior.)
- Default focus on app launch: `slot1` (or whichever is leftmost
  active, if slot1 is empty).
- Save / Save As / Print / Export / Find / Replace all act on the
  focused pane.
- **Mod-1 / Mod-2 / Mod-3** focus slot 1, 2, or 3 from the keyboard.
  No-op for empty slots.

### Per-pane state (not stored on the doc)

The slot record holds per-pane state that should not travel with the
docx: read mode (§9 of `ARCHITECTURE.md`), nav-panel collapsed state,
scroll position, paintbrush arming. Two slots can hold the same doc
(by `docUid`) with independent read-mode flags — one in edit mode for
the cutter, one in read mode at the podium.

## 7. Nav pane

A single sidebar at the window's left edge, split vertically into
one section per active slot (equal heights).

- Each section lists the headings/cards of the doc currently
  visible in its slot.
- Sections scroll independently.
- Clicking a heading in section K → focuses pane K and scrolls its
  editor to that heading.
- The outline-level controls (today's `1 2 3 4` row — shown at the
  top-left of image 1) live **at the top of each nav section,
  independently** per section. Each pane's outline filter is
  independent.
- Nav pane stays anchored at the window's left edge in both Compact
  and Wide-scroll layouts — it does not scroll horizontally with the
  pane row.

## 8. Drag-and-drop semantics

Three drag flavors to support:

### 8a. Editor pane → editor pane

Drop in a *different* pane than the source → always copy, regardless
of modifiers. Same-pane drags keep today's behavior (move by default,
Ctrl-drag for copy).

- Visual: the cursor / drop-indicator picks up a "+" affordance
  the instant the drag crosses out of the source pane.
- After drop, focus moves to the destination pane.
- Implementation note: stamp the source `paneId` onto the drag
  payload at `dragstart`; inspect at `handleDrop`. Anything dropped
  with a foreign `paneId` is forced copy.

### 8b. Editor pane → nav section

Drop content from a doc onto a nav section: **same rules as today's
single-doc drag-into-nav behavior**, applied to the target section's
doc. The existing drag-controller (`src/editor/drag-controller.ts`)
already supports nav-pane drop targets; we just wire each pane's nav
section as a surface targeting its own pane's view.

- Cross-doc → copy; same-doc → today's move semantics.
- After drop, focus moves to the destination pane and the editor
  scrolls to reveal the inserted content.

### 8c. Nav section → nav section / nav section → editor

Drag *from* a nav heading: **same rules as today's single-doc
drag-from-nav behavior**. The drag-controller already grabs the
heading + its subtree (`DragItem.from` / `DragItem.to` cover "heading
+ its subtree, or a card/analytic_unit container" — see
`drag-controller.ts:25–27`).

- Cross-doc → copy; same-doc → today's move semantics.

### Source detection

Detection logic needs to handle four source/target pairs:

| Source | Target | Same-doc? |
| --- | --- | --- |
| editor pane A | editor pane B | A === B → move, else copy |
| editor pane A | nav section K | A's doc === K's doc → move, else copy |
| nav section A | editor pane K | A's doc === K's doc → move, else copy |
| nav section A | nav section K | A === K → reorder/move, else copy |

The "same-doc" check is on the doc identity (a doc UID), not the
slot/pane index — important because in stacks a slot's visible doc
can change.

## 9. Stacks: opening, switching, closing docs

### Opening (routing)

When multi-doc mode is on, the File → Open flow:

1. User picks a file.
2. **Inline "Send to..." picker** appears near the file-list entry
   (or the open dialog's footer). Shows three buttons: `Slot 1`,
   `Slot 2`, `Slot 3`. No default selected — user must pick.
3. Doc loads into the chosen slot. If that slot already had a doc,
   the new doc becomes the visible doc; the existing one moves
   into the stack.

Always prompts, even when only one slot is non-empty. (Q13c
resolved.) If the inline picker is awkward in practice we fall back
to a modal. (Q13a resolved.)

- **Add-to-slot shortcut:** Each pane's footer (next to the per-pane
  word-count strip) has a small "+" → Open file button that
  auto-routes to *that* slot, no picker.

### Stack chip / dropdown

When a slot's stack has 2+ docs, the pane's title chip becomes a
dropdown trigger. Clicking shows the stack contents, each entry
clickable to switch the visible doc, with an × icon per entry to
close.

- Visible doc's state (selection, history, scroll) is preserved
  when switched away from (live view kept; Q14 resolved).
- Closing a doc that's currently visible → make the next stack
  entry visible. Close the last doc in a slot → the slot is now
  empty; layout reflows (3 → 2 slots, or 2 → 1).
- **Close affordance:** the title chip always carries an inline
  `×` button, whether the stack has one doc or many. (When the
  chip is a dropdown trigger, the `×` closes only the currently-
  visible doc; per-entry `×` icons inside the dropdown close
  individual stacked docs.)

### Limit on docs per slot

No hard cap on stack depth. Practically 5-ish would be a lot; UI
should still cope (scrollable dropdown).

## 10. Status bar & shared elements

A single status bar across the bottom:

- **Zoom controls:** shared. One zoom level applies to all panes.
- **Word counts:** per-pane — shown as a per-pane strip *at the
  bottom of each pane* (above the shared status bar), not in the
  status bar itself. This matches the `# . ''' : # . ''' : #` row
  in image 1.
- Other status items (cursor pos, doc dirty marker, etc.) reflect
  the focused pane.

## 11. Architecture sketch (informal)

Today's single-doc shell wraps:

- One `EditorView` + state
- One ribbon
- One nav pane
- One comments column

Multi-doc shell wraps:

- `PaneManager` — owns the three slots, focus state, layout mode,
  multi-doc on/off.
- `Slot` × 3 — each owns a stack of `DocRecord`s. Each record holds
  a live `EditorView`, state, and the per-pane drag-controller.
  Only the visible record's view is mounted into the DOM; the
  others' views exist (memory-resident) but are detached. Swapping
  a stack member back to visible re-mounts the view.
- One `Ribbon` — dispatches through `PaneManager.focusedPane.view`.
- One `NavPane` — subscribes to all active panes, renders N sections.
  Each section owns its own outline-level filter state.
- One `StatusBar` — shared zoom, focused-pane reflections.
- Doc UIDs (separate from filename) stamp drag payloads so cross-
  doc detection works even when docs share names.

Each pane stamps its drag payloads with `{ slotId, docUid }`:

- `slotId` (`slot1`/`slot2`/`slot3`) — *where* the drag came from
  in the layout. Used for post-drop focus + scroll-to-bring-into-
  view decisions.
- `docUid` (a unique id per loaded document, independent of slot)
  — *which document* the dragged content belongs to. Cross-doc
  forcing (auto-copy) compares `docUid`. A doc that swaps slots
  via stack switching keeps its `docUid`; a slot whose visible doc
  changes presents a new `docUid`.

(Both fields are cheap to carry; keeping both avoids tangling
layout identity with content identity.)

## 12. Resolved decisions (recap)

- Multi-doc master toggle replaces the earlier ATC concept.
  Settings home: "Workspace" group, label "Multi-doc workspace".
- Comments disabled whenever multi-doc is ON.
- Compact / Wide-scroll persists across sessions.
- 1 doc → full screen; 2 docs → 50/50 + nav split in half;
  3 docs → compact or wide-scroll.
- Pane widths are fixed (no splitter resize).
- Wide-scroll uses paged snap navigation (no in-between).
- Default focus on launch: slot 1 (leftmost active).
- Drag *between* panes / nav sections / pane↔nav all force copy
  when cross-doc; move when same-doc. Drag-into-nav and drag-
  from-nav use today's single-doc rules, applied per pane.
- Live `EditorView` for every doc in every stack (no serialize).
- Zoom is shared; word count is per-pane.
- Nav sections equal-height (thirds when 3 active, halves when 2,
  full when 1). Outline-level filter is per section.
- Doc title chip is small, always carries an inline `×` close button.
- Opening with multi-doc on always prompts for slot. No default.
  Footer "+" Open-file button per pane shortcuts routing to that slot.
- Closing the last doc in a slot collapses the slot; layout reflows.
- Drag payloads carry `{ slotId, docUid }`; cross-doc detection
  compares `docUid`.
- Read mode is per-pane state, not a doc attribute. Two slots can
  hold the same doc with different read-mode flags.
- Slot focus keyboard shortcuts: Mod-1 / Mod-2 / Mod-3.

## 13. Out of scope (v1)

- More than 3 slots.
- Splitting the same doc into two panes (synchronized scroll).
- Cross-pane Find / Replace.
- Drag *between* nav sections to *reorder* docs across stacks
  (vs copying content). Possible follow-up.
- Comments support inside multi-doc mode.
- Auto-restoring the open document set across sessions.
- Mobile / narrow-window fallback.
