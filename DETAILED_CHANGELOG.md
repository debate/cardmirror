# Detailed Changelog

In-depth release notes for CardMirror. Each entry covers the
behavior, rationale, and (where useful) the implementation context
behind a change. For a shorter, jargon-free summary of what's new
in each release, see `CHANGELOG.md`.

## Unreleased

- **Repair Text placement: normalization-tolerant fallback locator;
  output cap raised; failure paths logged**
  (`src/editor/ai/repair-text.ts`, console forwarding in
  `apps/desktop/src/main.ts`). Live diagnosis on a real imported card
  (46 fixes returned, only 31 placed) showed the dominant
  "could not place" cause: the model echoes straight quotes/apostrophes
  in its `find` strings where the document has curly ones — every
  skipped fix in the log was a quoted span. Repro tests confirmed the
  full failure taxonomy: smart-punctuation echoes (dominant), inline
  pilcrows omitted from finds, overlapping context windows, and a
  flattenSelection block-boundary miss when duplicated blocks share a
  node object (copy/paste reuses nodes). Fixes: (1) when the verbatim
  search misses, a folded-space fallback retries — curly quotes/dashes
  → ASCII, ligatures (ﬀ ﬁ ﬂ ﬃ ﬄ) expanded, NBSP/tab/newline → space,
  soft-hyphen/zero-widths dropped (pilcrow deliberately NOT folded:
  it's meaningful content and a folded match spanning one would delete
  it) — and ONLY the differing middle of find→replace (the actual
  correction) is applied. The agreeing prefix/suffix are never edited,
  so the document keeps its punctuation and ligatures there, and the
  context may legitimately span a block boundary (a second live run
  showed the model writing a space where the doc has a newline);
  only an edit middle crossing a boundary is rejected — joining or
  splitting blocks from a non-verbatim match is too ambiguous.
  Middle-only edits can be pure deletions, so both apply sites guard
  the empty-replace case (insertText('') throws). (2) The reply cap rises
  4096→16K with stop_reason checked — a truncated fix list previously
  surfaced as an opaque "not valid JSON" error; now it's an actionable
  "repair a smaller region". (3) Every outcome logs a [repair]-tagged
  console line (per-pass placement summary, classified skips, errors),
  and the Electron main process forwards [repair]/[cardmirror]-tagged
  renderer console lines to stdout so terminal dev sessions can see
  them. (4) Detection: the prompt now names the
  stray-space-after-hyphen artifact explicitly with both resolutions —
  keep the hyphen for genuine compounds ("neo- Gramscian" →
  "neo-Gramscian"), drop it for ordinary words split across a line
  ("re- search" → "research"); the old prompt only covered line-break
  hyphenation, and the strict leave-it-if-uncertain guideline made the
  model skip mid-line hyphen-space errors entirely. Known remaining
  gaps (pinned in tests): "--" echoed for an em-dash
  (two-chars-for-one, not seen live), omitted pilcrows, and the
  shared-node flatten boundary miss.

- **Anthropic translation output ceiling raised; truncation surfaced**
  (`src/editor/translate.ts`). `translateAnthropic` inherited the
  client's `DEFAULT_MAX_TOKENS = 1024` — sized for chat replies, not
  translations, whose output is roughly input-sized. Anything past a
  few paragraphs came back with `stop_reason: 'max_tokens'`, which the
  translator ignored: the cut-off text was copied to the clipboard as
  if complete. Now: the translation call requests a 16K-token ceiling
  (output tokens only bill as generated, so the headroom is free on
  short selections; 16K stays within non-streaming HTTP comfort), and
  `stop_reason === 'max_tokens'` threads through `TranslateOutcome.
  truncated` — the toast warns, and the clipboard text itself gains a
  trailing `[TRANSLATION INCOMPLETE — OUTPUT LENGTH LIMIT REACHED]`
  line so the incomplete result can't be pasted without notice. Other
  AI features keep the 1024 chat default. The MyMemory/Google paths
  are unchanged (MyMemory chunks at its per-request cap and errors
  loudly on quota; neither silently truncates).

- **Cite-debris cleanup: shadow ranges skip the Layer-3 trim;
  classification ignores whitespace-only cite runs**
  (`src/editor/ribbon-commands.ts` `getOperatingRangesForFormatting` +
  `sizeCycleCommand`, `src/import/importer.ts` `hasCiteMark`,
  `src/editor/cite-classifier-plugin.ts`,
  `src/editor/similar-selection-plugin.ts` `computeSimilarMatches`).
  Real-doc case (burgum 18): a card body imported with its entire
  un-underlined text as 8pt runs carrying `cite_mark` — the original
  cut's condensed un-underlined text, cite-styled in the source docx,
  boundary spaces inside the runs. The failure chain: content-based
  classification (any cite_mark → cite_paragraph) typed the body as a
  cite line; shrink's scope only collects card_body/paragraph, so it
  silently no-opped; and the natural cleanup — Select Similar on the
  un-underlined text, then F12 — ALMOST worked: the matches were
  correct, but `getOperatingRangesForFormatting` applied the Layer-3
  trailing-space trim (built to undo double-click word-unit
  absorption, one selection at a time) to EACH of the ~55 matched run
  ranges, shaving one space per run. Those 55 still-cite-marked spaces
  kept the live classifier re-affirming cite_paragraph, so the
  paragraph stayed unshrinkable with no visible formatting left.
  Fixes: (1) shadow-selection ranges skip the Layer-3 trim — they're
  text-run-exact, nothing was absorbed; (2) both `hasCiteMark` sites
  skip whitespace-only runs, so space-only cite debris can't classify
  a paragraph (root cause — the doc now imports as card_body in the
  first place; the inverse suite pins it); (3) whitespace-only runs
  match Select Similar fingerprints on marks alone, size ignored —
  relevant when re-sampling already-cleaned text whose size no longer
  matches the debris; (4) shrink with the cursor in a cite_paragraph
  shows a toast naming the blocker instead of silently returning
  false. Existing .cmir files with debris reclassify on the first edit
  that touches the paragraph (the classifier is transaction-scoped).

- **Structural command with a selection inside a same-type head fixed**
  (`src/editor/ribbon-commands.ts` `applyStructuralToSelection` /
  `transformDocChild`). With a non-empty selection, F7 routed through
  the selection path, which marked the tag as "touched": the tag was
  re-wrapped as its own card, but every following card child was lifted
  to doc level — the cite_paragraph became a plain paragraph (losing
  the cite slot and styling) and the body detached from the card. The
  cursor path treats F7-in-a-tag as a no-op, so the two gestures
  disagreed destructively. Subtle in practice because the tag keeps its
  card wrapper — the visible symptoms are the cite losing its
  formatting and condense no longer folding the body. Fix: a child the
  command would re-create as the type it already is (tag under setTag,
  analytic under setAnalytic, undertag under setUndertag, matching
  heading under setPocket/Hat/Block) now counts as untouched, and a
  changed-content check makes a fully same-type selection return false
  instead of dispatching an identical replace (which burned an undo
  step and yanked the cursor). The deliberate split semantics —
  selection in a card_body splits a new card; multi-paragraph
  selections wrap each paragraph — are unchanged. Known residual
  asymmetry: a CROSS-type selection on a head (F7 with analytic text
  selected) still converts only the head where the cursor path converts
  the whole unit; recorded in the audit doc.

- **NavigationPanel leak on doc close fixed** (`src/editor/nav-panel.ts`,
  `src/editor/multi-pane-shell.ts`). The multi-pane shell creates one
  NavigationPanel per open doc; closing a doc destroyed the EditorView
  and detached the drag surface but never the panel. The panel's
  constructor-time `settings.subscribe` and attach-time
  `dragController.subscribe`/`registerSurface` closures therefore kept
  the panel reachable for the whole session — pinning `currentDoc` (a
  full ProseMirror doc snapshot, MBs for a real file) and the rendered
  `liEntries` map, and the leaked drag subscriber kept running
  hover/auto-expand hit-testing on every drag move event. New
  `NavigationPanel.destroy()` releases all three subscriptions, removes
  the document-level drag listeners (covers closing mid-drag), cancels
  the auto-expand/auto-restore timers, clears the entry map, nulls
  doc/view, and removes the root element; both shell close paths call
  it beside `view.destroy()`. A `destroyed` flag turns any late
  debounced `update()` into a no-op so a straggler can't re-pin the
  snapshot the destroy just released.

- **Global hotkey fallback case-folding fixed**
  (`src/editor/ribbon-commands.ts` `ribbonKeyStringFor` /
  `ribbonCommandForKey`). The window-level keydown fallback (the path
  that fires when focus is on the ribbon/nav/chrome rather than the
  editor) built its lookup string from `e.key` verbatim — but a real
  Shift or CapsLock keydown produces an uppercase letter ('S'), while
  bindings are registered lowercase ('Mod-Shift-s'), so every letter
  chord missed and the browser default fired instead. Inside the
  editor prosemirror-keymap normalizes case, which is why the same
  shortcuts worked there. `ribbonKeyStringFor` now folds
  single-character keys to lowercase, and `ribbonCommandForKey` folds
  both sides of the comparison — necessary because the keybindings
  editor captured overrides through the unfolded path, so a user's
  saved `Mod-Shift-Y` must keep matching after the fix.

- **Find/Replace offset corruption after inline images fixed**
  (`src/editor/find-replace-plugin.ts` `findMatches`,
  `src/editor/find-replace-ui.ts` `buildSnippet`). Match positions were
  computed as character offsets into each textblock's `textContent` —
  but inline image atoms occupy one document position while contributing
  zero characters, so every match after an image sat one position left
  per preceding image: decorations misaligned, snippets sliced wrong,
  and Replace edited a shifted range (corrupting the neighboring text).
  Both sites now scan `textBetween` with a one-character leaf
  placeholder, which keeps string offsets identical to document
  positions. The scan uses `U+0000` (impossible in a query, so a match
  can never span an image — correct, since there IS an image between
  those words); the snippet uses U+FFFC so an image shows as the
  standard object-replacement glyph in find results.

- **Undertag italic round-trip fixed** (`src/import/importer.ts`,
  `parseRPr`). The exporter dual-encodes `undertag_mark` as
  rStyle="UndertagChar" + `<w:i/>` (the style implies italic display in
  Word — same parity precedent as underline's `<w:u/>`), but the
  importer mapped `w:i` → italic unconditionally, so one save/open
  cycle added a real italic mark to every undertag run. `w:i` is now
  deferred to the end of the rPr scan (OOXML guarantees no order
  between rStyle and run properties, the same reason `w:u` defers) and
  swallowed when `undertag_mark` is present. Consequence, accepted: a
  *user-applied* italic on undertag text is lost on round-trip — the
  exporter emits byte-identical runs for undertag and undertag+italic,
  so no inverse can distinguish them, and rendering is identical either
  way (the style already displays italic). This mirrors underline's
  long-standing dual-encoding trade.

## 0.1.0-alpha.10 — 2026-06-08

- **Reading-position marker** (`src/editor/reading-marker.ts`, read-mode
  wiring in `src/editor/read-mode-plugin.ts`, ribbon `toggleReadingMarker`).
  Inserts a red text run `Marked h:mm` (the `font_color` mark at `FF0000`,
  Verbatim's red-text convention) at the cursor and places the caret after
  it; the inclusive red mark is stripped from stored marks so it doesn't
  bleed into the next typing. Toggling: `readingMarkerRunAt` detects when
  the cursor sits on (or at either edge of) an existing red run — expanded
  over adjacent marker text nodes — and the command deletes it instead of
  inserting. Round-trips to Word as a normal colored run.
  - **Own undo step.** Both the insert and delete paths call
    `closeHistory(tr)` so each marker is isolated in history — never grouped
    (PM's `newGroupDelay` / adjacency) with a nearby edit, which would make
    undoing the marker also revert that edit.
  - **Read-mode integration.** Read mode now keeps the editor `editable`
    (caret placeable) and blocks edits via `filterTransaction`, which lets
    through only transactions flagged `READING_MARKER_META` or
    `READ_MODE_UNDO_META`. A `handleDOMEvents.keydown` handler (fires even
    though keymaps don't, under `editable: false` historically — now under
    the filter) maps bare Space/Enter to the toggle. The plugin's
    `isReadKept` keeps red marker text visible in read mode.
  - **Undo bounded to markers.** On read-mode entry the plugin snapshots
    `baseUndoDepth`; `readModeAwareUndo` (Mod-Z) only undoes while the depth
    exceeds it, so undo can't reach edits made before read mode.
    `readModeAwareRedo` (Mod-Y / Mod-Shift-Z) is gated on a `dirtied` flag
    set by a marker edit, so redo only re-applies undone markers. Both tag
    their transactions `READ_MODE_UNDO_META` to pass the filter.

- **Slanted caret for pending italic** (`src/editor/italic-caret-plugin.ts`).
  Browsers can't slant the native caret, so when a collapsed cursor's
  effective marks (`storedMarks ?? $from.marks()`) include `italic`, the
  plugin hides the native caret (`.pmd-italic-caret-active` →
  `caret-color: transparent`) and draws a thin `position: fixed`, skewed,
  blinking caret at `coordsAtPos(head)`, repositioned on selection / scroll
  (capture) / resize / focus. Reduced motion → static slanted caret.

- **Mod-U decoupled from F9 for the collapsed-cursor case**
  (`src/editor/ribbon-commands.ts`). New `toggleUnderlineTyping` command,
  default-bound to `Mod-u` (F9 keeps `applyUnderline`). With a selection or
  shadow ranges it delegates to `applyUnderline`; on a collapsed cursor it
  toggles a STORED underline mark (parity with Mod-I/Mod-B) instead of F9's
  expand-to-word-and-underline — `underline_direct` in structural blocks,
  the named `underline_mark` in body. `applyUnderline`'s default keys drop
  `Mod-u` (now `['F9']`).

- **Repair Text** (`src/editor/ai/repair-text.ts`,
  `src/editor/repair-highlight-plugin.ts`, ribbon wiring). Diff-based OCR /
  PDF repair: the model returns `{ fixes: [{ find, replace }] }` (verbatim
  substrings + corrections) instead of a full rewrite — less hallucination
  surface, fewer output tokens. `flattenSelection` flattens the selection
  to text with `\n` between blocks (so paragraph boundaries aren't read as
  run-together words) plus a char→PM-position map; `locateFixes` finds each
  `find` sequentially and maps it to a doc range (a cross-block range joins
  on apply, repairing hyphenation split across lines).
  - **Two passes** at `temperature: 0` (new `temperature` option on
    `callAnthropic`): the model occasionally skips a token on one read, so
    a second pass over the corrected text catches it. Pass 2 is skipped
    when pass 1 found nothing.
  - **Animation**: each fix is applied as its own off-history transaction
    (sequential text replacement, orange flash via `repairHighlightPlugin`,
    scroll-into-view, ~110ms cadence); the Clod/"Thinking…" tooltip stays
    anchored where it spawned. Reduced-motion collapses to an instant apply
    + one static highlight.
  - **Single undo**: because PM groups history by time + range adjacency,
    scattered fixes across two passes can't merge naturally — so
    `collapseToSingleUndo` reverts to the pre-repair doc (off-history) and
    re-applies the corrected content in two synchronous dispatches (no
    intermediate paint), recording the whole repair as ONE undoable change.

- **Translator** (`src/editor/translate.ts`, `src/editor/settings.ts`,
  `src/editor/settings-ui.ts`, ribbon wiring). Mirror of the "Card
  Formatting Tools" Translator. `runTranslate` reads the selection,
  translates via the resolved backend, and copies the result to the
  clipboard (no doc edit). Backends:
  - **MyMemory** — keyless, CORS-OK (renderer fetch), works with AI off.
    Needs a concrete source language; MyMemory's own auto-detect is
    unreliable, so on `'auto'` we detect locally with `tinyld` (new dep)
    first. Per-request `q` is capped, so text is chunked at sentence
    boundaries (`chunkText`) and rejoined. Optional `myMemoryEmail` raises
    the daily limit.
  - **Anthropic** — reuses the reference Translator prompt (parameterized
    by target language); only when AI features are ready.
  - **Google Cloud Translation** v2 — `googleTranslateApiKey`; auto-detects
    source.
  - `translationProvider` `'auto'` resolves to Anthropic when ready else
    MyMemory. `translationSourceLang` / `translationTargetLang` (default
    `en`) pickers. All under Settings → Editing via a custom
    `translationConfig` widget; the Anthropic radio greys out when AI is
    off (live, via a self-detaching `settings.subscribe`).
  - `prependTranslationMarker` (default **on**): prepends
    `<delim>TRANSLATION BY <attr><close>` to the clipboard output, where
    `<attr>` is the model (`modelMarkerName`), `MYMEMORY`, or
    `GOOGLE TRANSLATE`, wrapped in the `condenseWarningDelimiter` (custom
    condense delimiter → square-bracket fallback, since condense's custom
    is full pause/resume strings, not an open/close pair). Six
    `TRANSLATION BY .*?` shapes added to `BUILTIN_PROTECTED_REGEXES` so all
    attributions/delimiters survive Shrink.
  - `googleTranslateApiKey` + `myMemoryEmail` join `anthropicApiKey` in a
    new `SECRET_SETTING_KEYS` set — excluded from settings export, never
    overwritten on import.

- **Unified AI model + override + retired-model message**
  (`src/editor/ai/anthropic.ts`, `src/editor/settings.ts`). `DEFAULT_MODEL`
  is documented as the single source of truth; new `resolveAiModel()`
  returns the user's `aiModelOverride` when it passes a loose id check,
  else the default. `callAnthropic` calls it when no explicit model is
  passed, so every feature (cite, explain, translate, flashcards, image)
  honors the override at once. New Settings → Comments & AI → "AI model
  (advanced)" text field (greys with the AI master switch). On a 404 /
  `not_found_error` / model-naming 4xx, `callAnthropic` throws a friendly
  `'model'`-kind error telling the user to update or set a newer model id.

- **AI cite creator: off-by-one on whole-document selections + cite
  sanitization** (`src/editor/ai/cite-creator.ts`). Two fixes:
  - `buildCiteTransaction` now clamps the incoming range to valid text
    positions with `TextSelection.between(state.doc.resolve(from),
    state.doc.resolve(to))` before inserting. The caller passes the raw
    selection bounds; a whole-document / top-of-doc selection (Ctrl+A) has
    `from === 0`, which is a block-boundary position, not inline — PM lands
    the cite at position 1, but the old code computed the cite-mark range
    AND the "cite is its own paragraph" split from the raw `from`, shifting
    every position one left. Result: the trailing token lost its last char
    (`" Cary 2"` instead of `Cary 24`) and the cite's last char was shunted
    to its own line — together, since both derive from the same anchor.
    Clamping (e.g. `0 → 1`, or `0 → 2` when the doc starts with a card)
    makes the inserted run exactly `[from, from + cite.length]` again.
  - `parseCiteResponse` now runs cite and tokens through `sanitizeCiteText`
    (strip zero-width / format / control characters, collapse every
    whitespace run incl. newlines to a single space). Messy source (often
    PDF-pasted) makes the model echo invisibles or wrap the cite across
    lines; under `white-space: pre-wrap` a stray `\n` renders as a real
    line break, and a wrap inside the author block stops the token from
    substring-matching. Tokens get the same treatment (left-trimmed,
    trailing space preserved for the two-author `"X & "` convention) so
    `indexOf` still matches.

- **Gesture zoom — pinch / Ctrl+wheel** (`src/editor/index.ts`,
  `src/editor/settings.ts`). A `window` `wheel` listener (capture,
  non-passive) intercepts events with `ctrlKey` set — Chromium delivers a
  trackpad pinch as exactly that, so one handler covers pinch AND
  Ctrl+mouse-wheel. It `preventDefault`s (otherwise Chromium also fires
  its own native page-zoom → double zoom), accumulates `deltaY`, and steps
  `zoomPct` ±10% per ~40 delta-units via the existing `setZoom` (so the
  gesture round-trips through settings and the multi-pane shell like the
  buttons / `Mod-=` chords). Gated on the new `gestureZoom` setting
  (default **false**); drives the document zoom, not chrome scale.

- **Keyboard macros surfaced in the Search Everything palette**
  (`src/editor/quick-card-search-ui.ts`, `src/editor/keybindings-editor.ts`).
  The macros editor lives inside the keybindings editor (the
  `ribbonKeyOverrides` row, Settings → Shortcuts) rather than as its own
  `SETTING_METADATA` row, so it had no auto-generated palette entry. Added
  an explicit result (same pattern as the "About this install" special)
  matched on `keyboard macros` / `macro` / `snippet` / `text expansion`,
  deep-linking via `settingsTarget: {category:'shortcuts',
  anchor:'keyboard-macros'}`; the macros `<section>` now carries
  `data-anchor="keyboard-macros"` for `revealAnchor` to scroll/flash. Also
  added a `gesture zoom` alias to the `gestureZoom` setting.

- **Removed the `enableTextDragDrop` setting** (`src/editor/settings.ts`,
  `src/editor/index.ts`). The toggle was off by default (PM's native
  text-move drag produced un-cleanly-undoable edits) and the feature never
  worked reliably, so the setting is gone entirely (interface field,
  default, metadata, sanitize). The `dragstart`-swallowing plugin now
  `preventDefault`s unconditionally — same behavior as the old default-off
  state. The card / heading pickup-drag (pointerdown-driven) is unaffected.

- **Show-in-context closes the launching Manage overlay**
  (`src/editor/learn-session-ui.ts`, `src/editor/learn-manage-ui.ts`).
  `openLearnSession` gained an `onShowInContext` callback; the Manage
  screen passes its `cleanup`, and the session invokes it (alongside its
  own cleanup) only when `showFlashcardInContext` opens the source in
  THIS window — the same in-window path that already hides the home
  screen. Cases that open the card in a separate window leave the session
  and Manage overlay up.

- **Manage Flashcards ribbon button + due-today dot** (`index.html`,
  `src/editor/index.ts`, `src/editor/settings.ts`, `src/editor/style.css`).
  Added a `manage-flashcards-btn` to the comments cluster (the 2×3 grid's
  second row is now `manage-flashcards · create-flashcard · ask-ai`),
  wired to the existing `manageFlashcards` command. A red dot
  (`.pmd-ribbon-due-dot` ::after) shows when
  `learnStore.dueCount({kind:'all'}, localToday()) > 0` and the new
  `flashcardDueDot` setting (default true) is on; `refreshFlashcardDueDot`
  recomputes on `learnStore.subscribe`, the settings subscriber (toggle),
  and `visibilitychange` (catches a day-rollover while idle).

- **Backspace on an empty first-body slot deletes the blank line**
  (`src/editor/tag-keymap.ts`). `backspaceAtFirstBodyStart` swallowed
  Backspace at the start of a card/analytic_unit's first body whenever
  the head was non-empty (the anti-collision rule). Added an exception:
  when that body is itself empty (`content.size === 0`) there's nothing
  to collide, so delete the empty paragraph and place the cursor at the
  end of the head. Non-empty bodies still no-op. (`card`/`analytic_unit`
  content is `head (…)*`, so dropping the only body is schema-valid.)

- **`selectCurrentHeading` default-bound to `Alt-a`** (`ribbon-commands.ts`
  `DEFAULT_RIBBON_KEYS`). The command existed but shipped unbound (`''`);
  no conflict with existing defaults. User-rebindable via
  `ribbonKeyOverrides`.

- **Drag-from-editor auto-scroll fixed** (`src/editor/drag-editor-surface.ts`).
  `maybeAutoScroll` scrolled `this.host`, but the host (`#editor` /
  `.pmd-pane-editor`) isn't the scroll container — `#app` is in single-doc,
  the pane body in multi-pane — so it was a no-op and the edge test never
  fired (the host's full-height rect has its bottom far below the
  viewport). Now scrolls `findScrollGate()` (the same element `hitTest`
  gates on). (A companion fix — suppressing the text selection the pickup
  chord's Shift/Alt triggers on click, via a capture-phase pointerdown
  interceptor + `user-select: none` in pickup mode — is in the code but
  held out of the changelog pending macOS verification.)

- **`@AI` mentions fire from comments + notes again; AI author name
  cleaned up** (`src/editor/comments-ui.ts`). The `@AI` / has-AI-history
  re-invocation check lived only in `submitReply`, so it was lost on the
  comment thread's first message (`commitRootText`) and was never wired
  for notes (`addNoteComment`). Extracted into `maybeInvokeAiForComment`
  (called from the root input and replies) and added `maybeInvokeAiForNote`;
  `invokeAiLocal` / `contextFromLocal` are generalized over `'ai' | 'note'`
  so a note's AI reply lands as a private `ai: true` turn (with the
  Thinking placeholder + a re-render-signature flag added to notes). The
  redundant ` (AI)` author suffix is dropped — AI comments now store the
  plain persona name and rely on `initials: 'AI'` for round-trip
  detection (it survives via comments.xml `w:initials`); a legacy trailing
  `(AI)` is stripped at display and still recognized by `isAiComment`.

- **Annotations (comment / note / ask-AI) work on images** (`learn-anchor.ts`,
  `comments-plugin.ts`, `comments-ui.ts`, `ai/explain-context.ts`,
  `ai/anthropic.ts`, `ai/image-ai.ts`, `import/importer.ts`, `index.ts`).
  Previously all three silently failed on a picture (orphaned comment /
  empty-quote note / unanchored AI). Now:
  - *Anchoring (notes + AI).* `flatten()` emits a sentinel per image —
    object-replacement char + a cheap FNV-1a fingerprint of its base64
    data — so an image is one token in the flattened text stream. The
    existing quote/prefix/suffix matcher then handles image-only and mixed
    selections unchanged: re-anchors by content (not position), with
    different images distinguished by fingerprint and identical copies
    disambiguated by surrounding context, like a repeated phrase.
  - *Comments.* A `comment_range` mark already applies to an image (inline
    atom, no `marks` restriction); the only gap was that the live-thread
    scans walked text nodes only. `collectRanges`, `collectLiveThreadIds`
    (the GC), and the delete-strip now also read marks off `image` nodes.
    Round-trip: the docx exporter already brackets images
    (`exporter.ts:416`); fixed the importer to re-apply open comment
    ranges to imported images (cmir round-trips natively as PM JSON).
  - *Ask AI sends the image.* `ExplainContext` gains `images` (vision-
    supported formats only, document order, capped at 5);
    `formatExplainFirstTurn` prepends `image` content blocks before the
    text prompt (Anthropic's recommended order), and both AI paths
    (`invokeAi`, `invokeAiLocal`) use it. `buildExplainContext` allows an
    image-only selection (empty text + images). `aiAskAboutSelection`
    toasts when the selection has >5 images. Vision media-type set
    promoted to a shared `VISION_MEDIA_TYPES` in `anthropic.ts`.

- **Editor spellcheck: a custom viewport-scoped checker** (new
  `src/editor/viewport-spellcheck.ts`, `src/editor/proto-dict/`, `nspell`
  dep; `src/editor/index.ts`, `src/editor/multi-pane-shell.ts`,
  `apps/desktop/src/main.ts`). The `editorSpellcheck` setting is now
  served by a ProseMirror decoration plugin instead of the browser's
  built-in checker. Why the switch: the built-in checker only flags words
  as you *type* them (never text in opened/imported files), needed the
  Electron session engine enabled + a language set to work at all on
  Windows/Linux, and — decisively — does not paint squiggles under native
  Wayland. The custom checker fixes all three.
  - *How it works.* On scroll/edit (trailing-debounced ~120ms), it
    hit-tests the viewport top/bottom to find the on-screen doc range,
    tokenizes only that range, and decorates misspellings
    (`.pmd-misspelled`, a CSS wavy underline that renders everywhere
    incl. Wayland). Cost tracks words-on-screen, not document size; word
    verdicts are memoized. Gated on `editorSpellcheck` (no work, and no
    dictionary load, when off). Lands via `buildEditorPlugins`, so it
    covers both single-doc and multi-pane.
  - *Dictionary.* nspell (Hunspell-in-JS) over the en `.aff`/`.dic`
    (vendored under `proto-dict/`), **dynamically imported** so the
    ~550KB dictionary is a separate async chunk fetched only the first
    time spellcheck is turned on — a spellcheck-off session never pays
    for it. Build is ~67ms (one-time).
  - *Native checker disabled.* The editable's `spellcheck` attribute is
    now always `false`; the prior native-engine wiring
    (`setupSpellChecker`, `webPreferences.spellcheck`, the
    `editor-spellcheck.ts` focus-bounce) is removed.
  - *Right-click menu.* A `contextmenu` handler on a flagged word (falls
    through otherwise, so links/images/default menus still win) shows up
    to 7 `nspell.suggest` results (click to replace), **Add to
    Dictionary** (persisted to `localStorage['pmd-user-dictionary']`,
    re-applied via `nspell.add` on load — so it also drops from
    suggestions), and **Ignore** (session-only suppression). Word
    verdicts are memoized; the cache is invalidated on add. Menu reuses
    the `.pmd-nav-context-menu` styling.
  - *Not yet done*: a Web Worker for the one-time dictionary build (the
    user accepted the ~67ms hitch for now).
- **Suppress the auto-update-in-progress messaging on macOS**
  (`apps/desktop/src/main.ts`, `src/editor/settings-ui.ts`). Unsigned
  macOS builds can't self-install via Squirrel.Mac, so the auto-updater
  could detect a new version but the download/install never landed —
  while the UI still promised a background download and a restart-to-
  install. Detection stays on; on `darwin` we now set
  `autoUpdater.autoDownload = false` and `autoInstallOnAppQuit = false`,
  skip registering the `update-downloaded` "restart to install" dialog,
  and reword the "Update available" dialog detail + the Settings
  "Check for updates" toast to send the user to the `.dmg` instead of
  claiming a background download. Windows/Linux behavior is unchanged
  (still full auto-download + install-on-quit). Pairs with the README
  note that macOS updates are manual.

- **macOS cross-window bugs fixed: Finder-open duplicate guard + the
  multi-window three-pane toggle storm** (`apps/desktop/src/main.ts`,
  `src/editor/settings.ts`, `src/editor/index.ts`). Both were pinned down
  from the temporary `cross-window-debug.log` probe.
  - *Duplicate-open guard.* The OS-open path (`openExternalFile` — macOS
    `open-file`, Windows/Linux argv) spawned a window and registered the
    path WITHOUT the dedup check the in-app Open dialog runs through
    `host:open-path-check`, so a Finder double-click of an already-open
    file opened a second copy — and closing either copy then released the
    shared `openPathOwners` claim, orphaning the other. Not a path-
    canonicalization hole (the probe's `pathForensics` were clean: empty
    `nearMisses`, matching NFC/NFD, no realpath divergence) — a missing
    call site. Fix: a shared `focusExistingOwner(p, excludeWinId?)`
    helper focuses the owning window (pruning stale entries);
    `openExternalFile` calls it before spawning, and `host:open-path-
    check` now delegates to it.
  - *Three-pane toggle.* `multiDocWorkspace` is a synced (non-transient)
    setting, so toggling it in one window fired the `storage` event in
    every OTHER window, and each ran `handleModeSwitch` independently —
    two overlapping close rounds whose senders were each other's
    targets, so both windows closed and none survived to host the new
    layout (the backgrounded window also took ~9 s to answer its
    please-close, which read as "nothing happened" and prompted the
    second toggle). Fix: `notify()` passes a `{ remote }` origin flag to
    subscribers (true when the change arrived via the storage event); the
    mode-switch subscriber ignores remote changes, so only the
    initiating window drives the switch. A `modeSwitchInProgress`
    re-entrancy guard in `host:journal-and-close-other-windows` is the
    backstop.
  The temporary instrumentation stays in this build so the next capture
  can confirm the fix; it'll be removed once verified.

## 0.1.0-alpha.9 — 2026-06-03

- **Autosave toggle persists per document across close + reopen**
  (`autosave-prefs-store.ts` new, `index.ts`, `multi-pane-shell.ts`,
  `settings.ts`). `autosaveEnabled` stays a transient per-window setting
  (still in `TRANSIENT_SETTING_KEYS`, never written to `pmd-settings`),
  but the choice is now mirrored PER FILE PATH in a tiny localStorage
  store (`pmd-autosave-paths`, a set of ON paths; absence = off).
  - Single-pane: the `toggleAutosave` ctx handler writes
    `setAutosaveForPath(activeFile().handle, next)`; both open paths
    (`routeOpenedFile`, `loadFileInPlace`) restore via
    `settings.set('autosaveEnabled', isAutosaveOnForPath(handle))` right
    after setting the handle/format.
  - Multi-pane: `DocRecord` init reads `isAutosaveOnForPath(opts.handle)`
    instead of hard `false`; `toggleFocusedAutosave` persists the flip.
  - Only Electron string-path docs key into the store; web
    `FileSystemFileHandle`s and unsaved docs no-op (stay default-off).
    Save-As to a new path doesn't retro-persist (the in-session flag is
    untouched; the new path remembers once toggled) — a minor edge, not
    the close/reopen case this targets.

- **Cross-window diagnostic instrumentation (TEMPORARY, macOS bug
  hunt)** (`apps/desktop/src/main.ts`, `preload.ts`,
  `src/editor/host/electron-host.ts`, `src/editor/index.ts`). Logging
  only — no behavior change, and deliberately NOT disabling native
  window occlusion so the bugs still reproduce. Targets two Mac-only,
  Windows/Linux-fine symptoms suspected of a shared cause: the
  duplicate-open guard missing, and the three-pane toggle's
  close/reopen being flaky (send-to-speech, which only pushes to one
  live window, works). All three use the same main-process IPC, so the
  differentiator is what each needs a *non-foreground* window to do.
  Writes one JSON line per event to `{userData}/cross-window-debug.log`
  (and console) via an `xlog` helper; a renderer→main `host:debug-log`
  bridge (`ElectronHost.debugLog`) folds renderer events into the same
  clock. Captured:
  - **Dedup canonicalization** — `canonicalOpenPath` is just
    `path.resolve` (no case-fold, no Unicode NFC/NFD normalization, no
    `/private`/`/Volumes` symlink resolution). Each
    check/register/release logs `pathForensics` (resolved key, isNFC/
    isNFD, `realpathSync.native`, realDiffers) and, on a missed check,
    `dedupeNearMisses` — registered keys that point at the SAME file
    under a DIFFERENT string (sameNFC / sameLower / sameReal). A hit
    there is direct proof of the canonicalization hole.
  - **Mode-switch close** — `host:journal-and-close-other-windows` logs
    each other window's visible/minimized/focused state, then per
    window `closed-clean` vs `destroyed-timeout` + elapsed ms (the
    10s `destroy()` skips the renderer's journal → lost doc =
    "flaky"). `host:close-self` logs `modeSwitchWakeMs` (please-close
    send → close-self arrival = the background renderer's wake+journal
    latency). Renderer logs `please-close-received` with
    `document.visibilityState` (`hidden` ⇒ occluded) and
    `please-close-journaled` with journal ms.
  - **Renderer freeze / occlusion** — per-window `wc-unresponsive`/
    `wc-responsive` and `win-blur`/`focus`/`hide`/`show`; `setdochandle`
    logs the owning window's visibility at path (re)register; a `boot`
    header records platform / Electron / Chromium versions + log path.

- **Word Count Selection button per pane in multi-pane mode**
  (`multi-pane-shell.ts`). The single-pane status bar's Σ button
  (`#word-count-btn`, hidden in multi-doc mode) had no equivalent in the
  pane footers. Each `Slot` footer now builds a `.pmd-pane-wc-btn` before
  the `.pmd-pane-wc` readout; its click focuses the slot
  (`shell.focusSlot`) and calls `openWordCount(this.visible.view)` —
  scoping the modal to that pane's own visible doc and selection rather
  than the module-level single-pane `view`. `mousedown` is
  preventDefault'd and the click `stopPropagation`'d like the sibling
  open-file button; it no-ops when the slot is empty. Styled in
  `style.css` like `.status-bar-btn`, scaled to the footer. The shared
  status-bar Σ button (`#word-count-btn`) is now also hidden in
  multi-doc mode (alongside the already-hidden `#word-count-display`) —
  it otherwise sat in the corner below the nav rail and was redundant
  with the per-pane buttons.

- **Live selection word count had no effect in multi-pane mode**
  (`multi-pane-shell.ts`). Two gaps vs. single-pane: (1) the per-pane
  `dispatchTransaction` called `slot.refreshWordCount()` only inside
  `if (tx.docChanged)`, so selection-only transactions never refreshed
  the footer — the "Sel:" readout only appeared after the next edit,
  looking permanently off. Added an `else if` mirroring single-pane's
  `index.ts` gate (`liveSelectionWordCount` on, selection changed, and a
  range on either side so empty→empty cursor moves do nothing). (2)
  `Slot.refreshWordCount` computed `hasSel = !sel.empty` WITHOUT checking
  the setting, so when it did run with a selection it showed the
  selection count regardless of the toggle; now gated on
  `settings.get('liveSelectionWordCount') && !sel.empty` like single-pane
  `refreshWordCount`. The settings-toggle path was already covered — the
  shell's settings subscriber refreshes every slot's word count on any
  change.

- **Dropzone pill stranded over the pane footer on multi-pane boot**
  (`index.ts`, `style.css`). The floating dropzone pill anchors to the
  leftmost VISIBLE pane body via `positionDropzone`, but multi-pane has
  TWO stacked bottom bars — the per-pane `.pmd-pane-footer` (word count
  + Σ) sits on top of the still-visible full-width `#status-bar`. Three
  things conspired: (1) the boot `requestAnimationFrame(positionDropzone)`
  runs in single-pane context (`#app` still visible, `pmd-multi-doc` not
  yet set) and INLINES a `bottom` measured against `#app` — clearing the
  status bar but not the footer; (2) the later multi-doc pass early-
  returns because panes boot `[hidden]` (no `.pmd-pane:not([hidden])
  .pmd-pane-body` anchor exists yet), leaving that stale inline value in
  place; (3) the `#app` `ResizeObserver` wired at boot is dead in
  multi-doc (`#app` is `display:none`), so nothing re-ran the pass when a
  pane un-hid on doc-load — only an unrelated reflow (cycling the theme)
  did. Fixes: a `body.pmd-multi-doc .pmd-dropzone-root` CSS fallback that
  clears BOTH bars (`calc(var(--status-bar-height) +
  var(--pmd-pane-footer-height) + 0.5rem)`, the footer height now a
  shared `:root` var so it can't drift from `.pmd-pane-footer`'s
  `min-height`); `positionDropzone` now REMOVES its inline `left` /
  `bottom` / `max-width` when it can't measure the anchor, so the mode-
  aware CSS fallback applies instead of a stale single-pane value; and a
  `ResizeObserver` + a `hidden`-attribute `MutationObserver` on
  `.pmd-multi-row` so the pass re-runs (and inlines the exact position)
  the moment a pane un-hides as its first doc mounts.

- **Version / "About this install" in the command palette.** A synthetic
  settings result in `searchSettingsSource` (`quick-card-search-ui.ts`),
  prepended when the query prefix-matches "version" / "about" / "about
  this install" / "release". Its name shows `CardMirror <appVersion>`
  (`appVersion` newly exported from `install-info.ts`), and it carries
  `settingsTarget: { category: 'general', anchor: 'about-this-install' }`.
  `SettingsTarget` gains an `anchor` field; `SettingsModal.open` handles
  it via a new `revealAnchor` that scrolls + flashes the `[data-anchor]`
  section (the About block, now tagged `data-anchor="about-this-install"`)
  — reusing the existing settings-search deep-link piping.

- **Settings open + change performance on large docs.** Several
  settings-subscriber paths did O(doc) work on every change (and at open):
  - `buildColorOverridesEditor` (`settings-ui.ts`) was the dominant cost:
    each of ~37 color rows ran `getComputedStyle` — via `currentValue`
    (`getComputedStyle(documentElement)`) and `parseToRgbaParts`, which
    **appended + removed a probe `<span>` to `<body>` per call** — on
    every settings change, forcing a full-document style recalc each time
    (read/write thrash × 37). Now: one persistent off-screen probe reused
    across calls (no per-call append/remove), and each row subscribes only
    to ITS OWN token (`displayColors[dcKey]` or `customColorOverrides[name]`)
    so editing one color refreshes one row, not all 37.
  - The global apply subscriber (`index.ts`) called `applyReadMode` on
    every change, which dispatches a transaction that makes the read-mode
    plugin re-walk the doc to rebuild hiding decorations — now guarded on
    `readMode` / `hideEmphasisBordersInReadMode` actually changing.
  - The nav/outline panel (`nav-panel.ts`) rebuilt the whole outline (one
    node per heading) on every settings change — now only when `navMaxLevel`
    or `showCitePreview` changes.
  - The apply subscriber's `refreshWordCount()` walked the whole doc on
    every change; now `refreshWordCount({ selectionOnly: true })` reuses
    the cached whole-doc count (the doc is unchanged on a settings toggle).
  - The Keyboard tab's ~150-row keybindings list is built on the next
    frame (`requestAnimationFrame`) rather than blocking the dialog open
    (it's not the default tab, and its panel starts hidden).

- **Convert Cited Analytics to Tags command.** New bindable command
  `convertCitedAnalyticsToTags` (`ribbon-commands.ts`, label "Convert
  Cited Analytics to Tags", no default key, Cleanup group, doc-dropdown
  Cleanup section). The existing `convertAnalyticsToTags` body was
  extracted into a shared `analyticsToTagsCommand(shouldConvert)` helper:
  the original passes `() => true`, the new one passes a predicate that
  checks the `analytic_unit` has a `cite_paragraph` child. Same
  selection-scoping as the original (selection range, or whole doc when
  empty) and same per-unit transform (analytic_unit→card, analytic→tag,
  heading id + body slots preserved).

- **AI table-from-image: large tables + a repair fallback** (`image-ai.ts`,
  `anthropic.ts`). Large tables were truncated by the 4096-token cap — the
  dominant cause, confirmed via `stop_reason === 'max_tokens'`. Fixes:
  - The table JSON schema (now shared between the extraction and repair
    prompts as `TABLE_SCHEMA_AND_RULES`) is COMPACT: cells emit only
    non-default fields, so a plain cell is `{ "text": "..." }` instead of
    carrying `bold/italic/colspan/rowspan` defaults. `validateTableSpec`
    already defaults missing fields, so no parse change was needed — this
    just cuts output size ~5×.
  - `maxTokens` raised 4096 → 16384.
  - `callAnthropic` now returns `stopReason` (the API `stop_reason`).
  - On validation failure: if `stopReason === 'max_tokens'` the data is
    genuinely cut off → a clear "too large" toast (no repair, since
    reformatting truncated JSON would silently drop rows). Otherwise (a
    real format error) a text-only repair call (`TABLE_REPAIR_SYSTEM_PROMPT`)
    reformats the broken output via the shared `parseTableSpec` helper.

- **Extract Undertag command.** New bindable command `extractUndertag`
  (`ribbon-commands.ts`, label "Extract Undertag", no default key, card
  dropdown → Excerpt section, Editing-utilities group). Walks up from the
  selection to the enclosing `card` (requires a non-empty selection and a
  card whose first child is a `tag`), reads the selection text
  (`textBetween` with block→space collapse), and inserts a new `undertag`
  node after the card's last existing undertag (or right after the tag).
  It's a copy — the original text is untouched — and the cursor lands at
  the end of the new undertag. A new `extractUndertagInQuotes` boolean
  setting (Editing category, off by default) wraps the excerpt in double
  quotes; it reaches the command via a new `RibbonContext` getter
  `extractUndertagInQuotes` → `settings.get('extractUndertagInQuotes')`.

- **Word-style paragraph navigation: cleaner collapse / cross-block
  targets** (`word-selection-keymap.ts`).
  - `verticalCommandPair`'s Down (`to-end`) move with a non-empty
    selection now collapses to the START of the paragraph after the
    selection-end paragraph (`nextTextblock(corner.end()).start`) instead
    of `corner.end()` — so a following Ctrl/Alt+Down continues downward
    rather than stopping at the current paragraph's end first. The
    `$to.parentOffset === 0` spill case (after Ctrl/Alt+Shift+Down)
    collapses to that paragraph's own start (it already IS the next
    paragraph); a selection ending in the last textblock parks at its end.
    Up (`from-start`) is unchanged (start of the selection's paragraph).
  - `destPrevUnit`'s cross-block case (Ctrl/Alt+Left at a paragraph start)
    now returns `prev.end` — the END of the previous textblock, after its
    trailing word/punctuation — instead of the start of that block's last
    unit. Mirrors the forward direction (`destNextUnit` → `next.start`):
    both stop just across the paragraph break.

- **Notes — a private, threaded annotation (fourth comments-bar kind).** A
  `Note` entity in `learn-store.ts` (`{ noteId, docId, comments:
  LocalComment[], anchor, createdAt }`), parallel to `AiThread`: stored in
  the LearnStore (never serialized into the doc → private), anchored by
  `AnchorDescriptor` + a green decoration (`'note'` kind in
  `learn-highlight-plugin.ts` → `.pmd-note-range`). Store methods
  (`addNote` / `getNote` / `appendNoteComment` / `editNoteComment` /
  `setNoteAnchor` / `removeNote` / `notesForDoc`) plus JSON (de)serialize
  and the doc-lifecycle hooks (`copyDocAnnotations` fork-copies with fresh
  ids, `rekeyDoc`, `forgetDoc`). The comments column (`comments-ui.ts`)
  gets a `NOTE_PREFIX`, a green `'note'` chip, and a full render path
  (merge/sort by doc position, `populateNote` reusing `renderAiComment`,
  `buildNoteInput` / `addNoteComment`, `activateNote`, `deleteNote`,
  unanchored row + `regroundNote`). Creation is a new ribbon command
  `addNoteToSelection` (`ribbon-commands.ts`, default `Mod-Shift-n`,
  Comments group) + a ribbon button (new `note` icon) wired in `index.ts`;
  `threadIdAtCursor` maps the `'note'` range kind to `NOTE_PREFIX`.

- **Inline edit for comments and notes.** A pencil edit button
  (`buildEditButton`) on every human-comment turn (`renderComment`) and
  note turn (`renderAiComment` gains an optional `onEdit`; AI threads omit
  it). Clicking swaps the body for a textarea + Save/Cancel via a shared
  `startInlineEdit`; human comments commit through the existing
  `editCommentTextMeta`, notes through a new `editNoteComment(noteId,
  index, text)`. New `edit` icon added to the `gen-icons.mjs` MAP
  (`edit-02`); the note button's icon also comes from the MAP (`file-02`).

- **Opt-in export of the private layer as comments.** Two new Save As
  Custom-Save checkboxes (off by default) on `SaveAsResult` —
  `includeNotes` / `includeAiThreads` (`save-as-ui.ts`). `serializeForSave`
  (`index.ts`) gains `bakePrivateThreadsIntoDoc`: for each opted-in
  note / AI thread it resolves the anchor against the export doc, mints a
  `comment_range` mark + a real `Thread` (user turns → `human`, AI turns →
  `ai`) via a temp `EditorState`, and hands the marked-up doc + threads to
  the serializer. Baking the private layer forces a derived (non-identity-
  adopting) save so the working doc keeps both its identity and its
  private notes (no double-load on reopen).

- **Performance: annotation creation no longer re-anchors the whole doc.**
  `resolveDescriptor` flattens the entire document; the comments column
  used to re-resolve EVERY flashcard / AI thread / note on EVERY
  `learnStore` change (creation did it twice; each reply did it again).
  Fixes:
  - `learn-anchor.ts` exposes `flattenDoc` + `resolveDescriptorIn(flat,
    d)` so a batch resolve flattens once, not per descriptor.
  - `learn-highlight-plugin.ts` gains `upsert` / `remove` range metas
    (`upsertFlashcardRangeTr` / `removeFlashcardRangeTr`) to set or drop a
    single range by id at a KNOWN position — no walk.
  - The store subscription now runs `reconcileAnchors` (incremental):
    resolves a descriptor only for an annotation that's newly anchored
    but absent from the plugin, prunes ranges for deleted ones, and
    short-circuits to a plain render otherwise. Note / AI creation and
    re-ground call `placeLocalAnnotation` to set the range from the live
    selection BEFORE the store mutation, so the reconcile finds it already
    present and never resolves. `activateNote` / `activateAiThread` render
    instead of re-resolving. Full resolution (`refreshFlashcardAnchors`,
    now also flatten-once) is reserved for doc load, column show, pane
    switch, and edit-driven range drops.

- **Save Send Doc command + shortcut.** A new bindable command
  `saveSendDoc` (`ribbon-commands.ts`, default `Mod-Alt-s`, File group,
  palette aliases "send doc" / "export send doc" / "send version") that
  automates the Save As dialog's Send Doc preset: it saves the document
  with comments, analytics, and undertags stripped (full, non-read-mode
  export — same `transformForExport` filter the preset uses) in one
  keystroke, with no dialog. Driven by `runSaveSendDocFlow` (`index.ts`),
  a lossy export that leaves the working doc's identity, dirty state, and
  journal untouched (only a recents entry is added), mirroring the
  preset's non-full-save branch.

  Destination and format come from settings rather than the dialog:
  - `sendDocDestination` (new `sendDocDestination` setting kind — radio
    editor in `settings-ui.ts`, electron-only) chooses between
    `sameFolder` (write beside the source file) and `fixedFolder`.
  - `sendDocFolder` (reuses the existing `folder` setting kind, with the
    `pickDirectory` browse/clear UI) is the fixed-folder target.
  - Format follows `defaultSaveFormat`; the `SEND_` filename prefix
    honors `prefixPresetSaveFilenames`, exactly like the preset.

  The silent write goes through a new Electron host method
  `ElectronHost.saveSendDoc` → IPC `host:save-send-doc` (`main.ts`):
  the renderer resolves the destination (`folder`, or the source's
  `siblingHandle`) plus the final filename, and main joins, `mkdir -p`s,
  and writes. Main returns the literal `'collision'` when the resolved
  target would overwrite the source document (prefix off + same folder +
  same format) so the renderer can fall back to the dialog instead of
  clobbering it. The flow also falls back to `getHost().saveAs` for a
  never-saved doc in same-folder mode, an unset fixed folder, or a
  non-Electron host — so the command always does *something* sensible.

- **Select all instances of a style (right-click a ribbon style button).**
  A `contextmenu` handler on each structural / character style button
  (`index.ts`, `FORMATTING_PANEL_SELECT_ALL`) lights up every instance of
  that style as a shadow selection, reusing the Select Similar Formatting
  machinery so the result is `getOperatingRanges`-visible and the
  existing format commands act across all instances at once. New plugin
  exports in `similar-selection-plugin.ts`:
  - `StyleSelector` — `{ kind: 'block'; nodeType }` (matches a textblock
    type's content runs) or `{ kind: 'mark'; markTypes }` (matches text
    runs carrying any of the marks, contiguous runs merged).
  - `computeStyleMatches(doc, selector, scope?)` — pure matcher, scope-
    clamped.
  - `selectAllOfStyle(selector)` — the command. Scope is **sticky**: a
    fresh non-empty PM selection sets/replaces the scope (bounded match +
    scope tint, via a new `setMatchesScoped` plugin meta that sets
    matches + scope in one idle-mode step); with no fresh selection an
    existing scope is reused, so repeated right-clicks and the format
    operations chained between them stay bounded to the same region
    (format ops already preserve the shadow via `META_OPERATING_ON_SHADOW`
    and the scope rides along in the same plugin state). It collapses a
    live selection so the shadow, not the browser selection, drives bulk
    ops, and returns false (no dispatch) when nothing matches so the
    caller can toast without disturbing the existing shadow.

  The Underline selector deliberately matches only `underline_mark` (the
  named body style), not `underline_direct` — by the schema's body-vs-
  structural invariant the latter is the raw underline used inside tags /
  analytics / other structural blocks, which aren't instances of the
  underline *style*.

- **Cursor-on-style indicator on the ribbon style buttons.** A new
  `refreshFormattingPanelButtonStates()` (`index.ts`) sets `aria-pressed`
  on each formatting-panel button to reflect the cursor's current style,
  wired into `dispatchTransaction` next to the existing font-size / color
  refreshers (plus the view-chrome re-sync and mount paths). Structural
  buttons match the cursor's enclosing textblock type
  (`$from.parent.type.name`); character buttons match its marks via a
  standard `markActive` helper (`isMarkActiveInSelection`). Two guards
  worth noting: it skips the refresh when `$from.parent` isn't a
  textblock — a gap cursor between blocks (or a node selection) otherwise
  blanks every button even though the visible caret hasn't moved into new
  text, so the indicator holds the last real run's style; and Underline
  matches only `underline_mark`, not `underline_direct` (same body-vs-
  structural reasoning as select-all — direct underline in tags /
  analytics isn't the underline style). One CSS rule reuses the standard
  toggle wash: `#ribbon .formatting-panel-btn[aria-pressed="true"]` →
  `--pmd-c-button-active`.

- **Select Similar / select-all decorations reuse the Find palette.** The
  scope band (`.pmd-similar-scope`) now uses the same faint-blue
  within-selection tint as `.pmd-find-scope` (`--pmd-c-drop-*`), and each
  match (`.pmd-similar-match`) uses Find's current-match orange band +
  outline (`--pmd-c-find-match-current*`, kept dashed to read as a shadow
  selection). Previously both were near-identical ambers that blurred
  together. The now-dead `--pmd-c-similar-{scope,match}-*` variables were
  removed from both themes (`--pmd-c-similar-deep-text` stays — still used
  by the manage-cards list).

- **Documentation streamlined** (`README.md`, `ARCHITECTURE.md`,
  `PROJECT.md`, `src/editor/index.ts`). The prior docs were
  agent-generated — long, repetitive, padded with implementation
  narration, and in places inaccurate about what shipped. Rewritten
  against the voice of Verbatim's own published manual (plain, direct,
  task-first): ARCHITECTURE 1651 → ~640 lines (kept the schema,
  round-trip contract, rendering model, and editing-boundary rules; cut
  the changelog-style ribbon catalog and play-by-play; corrected
  overstated status — transclusion, corpus-search indexing, the cleanup
  ribbon family, and collaboration moved to a clearly-marked roadmap, and
  Electron noted as settled). PROJECT reduced to a one-screen orientation
  + accurate shipped/planned/out-of-scope snapshot. README intro and
  updates sections tightened (verbose install steps and acknowledgements
  kept). The in-editor welcome doc (`makeStarterDoc`) trimmed to the same
  voice with every interactive structure demo preserved, plus a new
  "Study your evidence" section for flashcards. ARCHITECTURE §17 gained a
  "Why this design (the evidence)" subsection grounding the
  spaced-repetition choices in the mnemonic-medium research (Quantum
  Country, Orbit, Augmenting Long-term Memory, Matuschak's notes), cited
  by public URL; the dead pointer to the gitignored learn-system spec was
  dropped. CHANGELOG/DETAILED_CHANGELOG untouched except for this note.

## 0.1.0-alpha.8 — 2026-06-01

- **"Show in context" from a flashcard review.** A third action in the
  review session (`learn-session-ui.ts`, button + key `3`, shown only
  when the card has an anchor whose doc has a known path —
  `pickCardSource`, unit-tested) opens the card's source focused on its
  anchored text, without grading the card. The session UI stays
  store-only and reaches the app through a host hook in
  `learn-store-host.ts` (`setShowInContextHandler` /
  `showFlashcardInContext`, passed the session's `cleanup` so the handler
  decides whether to close the review). `index.ts` registers
  `showFlashcardSource`, which routes by context, reusing a shared
  `focusDescriptorInActiveView` (resolveDescriptor → select +
  `preciseScrollIntoView`):
  - **Multi-pane:** delegates to `MultiPaneShell.showInContext` (new
    `enableMultiDocMode` hook) — focuses the slot already holding the doc
    and scrolls, or loads it into the first empty slot (slot 1 if all
    three are occupied; no picker) and scrolls on mount; closes the
    review + home (they cover the whole workspace).
  - **Single-doc, source is the current doc:** closes the review *and the
    home screen* (both overlay the doc) and focuses in place.
  - **Single-doc, open in another window:** new cross-window IPC
    (`host:focus-anchor-in-window` → main focuses the owner window and
    sends it `host:focus-anchor`; every window registers an
    `onFocusAnchor` receiver that scrolls its doc). Review stays up.
  - **Single-doc, not open:** spawns a new window carrying a
    `focusAnchor` on the spawn payload (`SpawnWindowPayload` /
    `InitialDocPayload`), which `mountFromSpawnPayload` focuses on mount.
    Review stays up.
  - **Web / no spawn host:** opens in place + focuses; closes review.
  New host-bridge surface: `focusAnchorInWindow` / `onFocusAnchor` on the
  preload, `ElectronAPI` interface, and `ElectronHost` class (guarded so
  an older preload degrades gracefully).

- **Cursor focus for AI-comment / flashcard cards (consistent with
  comments).** Clicking commented text focuses its thread because
  `threadIdAtCursor` (`index.ts`) reads the `comment_range` mark at the
  cursor and the existing `dispatchTransaction` wiring hands the id to
  `commentsColumn.setActiveThread`. AI threads and flashcards are
  local-only (`learnStore` + an `AnchorDescriptor`) and anchor via
  `learnHighlightPlugin` decorations, not a mark — so they never
  serialize, but a mark lookup missed them and `setActiveThread(null)`
  actually cleared any active card. Fix: new pure
  `flashcardRangeAt(state, pos)` in `learn-highlight-plugin.ts` returns
  the resolved highlight range containing a position (both ends
  inclusive, first match wins); `threadIdAtCursor` falls back to it when
  no comment mark is found and returns the column's prefixed id
  (`AI_PREFIX`/`FC_PREFIX`, now exported from `comments-ui.ts`) by
  `range.kind`. Comment marks still win when text carries both.
  Everything downstream (`setActiveThread`, card expand/scroll, in-doc
  active-range emphasis) already keys on the prefixed id, so AI and
  flashcard cards now focus on cursor exactly like comments and collapse
  when the cursor leaves.

- **Optional live selection word count (`liveSelectionWordCount`, default
  off).** The status-bar read-time counter (`refreshWordCount` in
  `index.ts`) only re-ran inside the debounced, `tx.docChanged`-gated
  `scheduleHeavyUpdate`, so selecting text without editing never updated
  the readout — and the `Selection: …` branch only ever showed on the
  next edit, against whatever selection happened to exist then. Rather
  than make every selection change pay an O(doc) recount (a cursor move
  with no selection recomputes the whole doc), this is now an opt-in
  setting:
  - When on, `dispatchTransaction` has a selection-only branch that
    calls `refreshWordCount({ selectionOnly: true })` — gated on the
    selection actually changing and a range being involved on either
    side, so plain cursor moves (empty → empty) do nothing. A non-empty
    selection counts only its range (`countReadAloudWords(doc, from,
    to)`); a collapse reuses a cached whole-doc count
    (`lastWholeDocWords`) instead of re-walking. The cache is nulled on
    any doc change so a collapse before the debounced recount can't show
    a stale total.
  - When off (default), `refreshWordCount` ignores the selection
    entirely and always shows the whole-doc count, and the
    selection-only branch is skipped — no per-selection work, and no
    stale `Selection: …`. A selection's read time stays available via
    the Word Count button (Σ / Word Count Selection dialog).
  Added the boolean to the `Settings` interface, defaults (false),
  sanitizer, and `SETTING_METADATA` (General, toggle); the existing
  settings subscription re-renders the bar when the toggle flips.

## 0.1.0-alpha.7 — 2026-05-30

- **"Delete Current Heading" bindable command (`deleteCurrentHeading`).**
  Sibling to `selectCurrentHeading` / `copyCurrentHeading` — same
  cursor-only enclosing-structure bounds (`enclosingStructureRange` via
  the shared `speech-doc-send.ts` helpers), but it removes the structure
  instead of selecting it. Importantly it deletes the whole node range
  (`tr.delete(from, to)`) rather than emulating select-then-Delete: a
  text-selection delete over an `isolating` card empties the card but
  keeps its now-blank shell, which this command must not do. New pure,
  testable `buildDeleteStructureTr(state)` returns the delete transaction
  (or null when the cursor isn't in a deletable structure) and re-homes
  the cursor to the nearest valid spot; `deleteCurrentHeadingIn(view)` in
  `index.ts` dispatches it via the same `view`-is-the-focused-pane ctx
  hook the select/copy commands use (works single-doc + multi-pane).
  Registered through the standard path (id union, IDs, label, alias
  "delete card"/"delete heading", unbound default key, View ribbon
  group, `commandFor` case, `RibbonContext` hook).

- **Windows "New → CardMirror Document" context-menu entry (drafted,
  UNVERIFIED on Windows).** Scaffolding for a right-click "New" submenu
  item via the classic ShellNew registry mechanism — no shell-extension
  DLL, just a registry value + a template file. `scripts/gen-new-template.ts`
  (run via `npm run gen:new-template`) serializes a minimal blank doc (a
  single empty paragraph) to `apps/desktop/resources/new-template.cmir`
  through the real `serializeNative`, so it's always a valid current-
  format `.cmir`; the file is committed and shipped via electron-builder
  `extraResources` to `$INSTDIR\resources\new-template.cmir`.
  `apps/desktop/build/installer.nsh` (auto-included by electron-builder)
  writes `SHCTX\Software\Classes\.cmir\ShellNew\FileName` to that path on
  install and removes it on uninstall; SHCTX follows the per-user /
  per-machine install scope, matching where the existing `.cmir`
  `fileAssociations` registration lives (which also supplies the menu
  label "CardMirror Document"). Not yet tested on a real Windows machine
  — left as a ready-to-verify draft; kept out of the user-facing
  changelog until confirmed working.

- **In-file object search matches a tag by its card's cite.** Diving
  into a file (`extractFile` in `file-search.ts`) produced a `tag`
  `FileObject` whose only searchable text was the tag's own words, and
  `searchFileObjects` matched on `label` alone — so an author/date never
  surfaced its tag (unlike Ctrl-F, which can match the card via the
  `cite_paragraph`). `FileObject` gains an optional `cite` field;
  `extractFile` now always collects cite text (`collectHeadings` without
  `skipCite`, so it's available even when the standalone `cite` object
  *kind* is off — that flag still only gates the separate CITE rows) and
  attaches the card's cite to its tag object. `searchFileObjects` matches
  against `label + cite` for tags (label leads, so a label hit still
  outranks a cite-only hit). `fileObjectResult` shows the cite as the
  row's secondary text for tags, so a cite-match reads clearly and tags
  carry their citation like the nav pane. Since a tag is now findable by
  its cite, the standalone `cite` object kind is redundant and now
  defaults OFF (`fileSearchObjectTypes` default + sanitize fallback +
  `DEFAULT_FILE_OBJECT_KINDS` all drop `'cite'`); it stays a configurable
  toggle for anyone who wants separate CITE rows.

- **OS "Open with…" routes into the workspace in multi-pane mode.**
  `openExternalFile` (main) always did `createWindow({ initialDoc })`,
  but the renderer's multi-pane boot never read `getInitialDoc()` (only
  single-doc boot did), so an externally-opened `.docx`/`.cmir` produced
  a blank workspace window. Fix has two halves:
  - Main keeps a `multiPaneWindows` set, populated/cleared by a new
    `host:register-multipane` IPC the renderer calls at boot (true in
    multi-pane boot, false in single-pane boot — so it survives the
    reload a workspace-mode toggle triggers, and is cleared on window
    `closed`). `openExternalFile` now `pickMultiPaneTarget()`s a
    multi-pane window (focused first, else any) and forwards the path
    via `host:external-open` (focusing/restoring it) instead of
    spawning; with no multi-pane window it falls back to the existing
    read-and-`createWindow` path — so single-pane is byte-for-byte
    unchanged, and cold launch still spawns.
  - The renderer (multi-pane boot) registers, subscribes to
    `host:external-open` (→ `openFileByPath` → `routeOpenedFile` → slot
    picker), and runs `routeInitialDocIntoWorkspace()` — reading any
    spawn payload and routing it through `routeOpenedFile` (slot picker)
    rather than booting blank; recovery is skipped when a payload was
    consumed, mirroring single-doc. New bridge methods
    `registerMultipane` / `onExternalOpen` on the preload, `ElectronAPI`
    interface, and `ElectronHost` class (guarded for older preloads).
  - Net behavior (the user's choice): a workspace window already open —
    populated or empty — is reused and shows the slot picker (no new
    window); only when no workspace window exists does it open one and
    show the picker there. Single-pane keeps spawning a window per file.

- **Command-bar file search refreshes the open palette live.** The
  background `.cmir` revalidation in main (`revalidateCmirIndex`,
  `apps/desktop/src/main.ts`) updated its cache but never told the
  renderer, so the comment's "picked up on the next palette open" was
  literally the only way to see fresh results. Now, when the re-scan
  finds the listing changed, main `broadcastCmirIndexUpdated(root,
  entries)` to every window via `host:cmir-files-updated`. The preload
  exposes `onCmirFileIndexUpdated(handler)` (mirroring
  `onDropzoneChanged`), surfaced on the `ElectronAPI` interface +
  `ElectronHost` class (guarded so an older preload degrades to no live
  refresh). `QuickCardSearchUI` subscribes on open / unsubscribes on
  close and handles the event in `onFileIndexUpdated`, designed so an
  in-progress search is never disrupted:
  - filters by `root` (ignores broadcasts for a different search
    folder) and bails if the palette is closed;
  - swaps `this.fileList` to the fresh listing and re-warms pins against
    the new mtimes, but does NOT bump `asyncToken` — so it can't abort
    an in-flight `enterInFile` read (and there's no `loadFileList` race:
    main returns the cached listing before starting the walk that emits
    the event, so the load always resolves first);
  - if the user has Tab'd into a file (`inFile`), leaves the visible
    object results untouched — the fresh listing is just staged for when
    they Esc back;
  - otherwise re-runs the current query (the input text is the source of
    truth, untouched) only when files are actually on screen (prefix `f`
    or a non-empty everything search), and restores the selection by
    identity (`resultKey`) so the cursor doesn't bounce to the top.

- **Edge autoscroll while selecting text.** Dragging a text selection to
  the top/bottom of the viewport now scrolls the document so the
  selection can extend past the originally visible area. Built into
  `word-selection-plugin.ts`, which already owns all mouse text
  selection (it `preventDefault`s the native drag and drives the
  selection via dispatched transactions in `installDragListeners`). The
  drag listeners now also: resolve the nearest scrollable ancestor of
  `view.dom` (`#app` single-doc, `.pmd-pane-body` per pane), track the
  pointer, and run a `requestAnimationFrame` loop while the pointer sits
  in a top/bottom edge band. Each frame scrolls the viewport by
  `edgeAutoscrollDelta(top, bottom, clientY)` (ramped 1px→20px with
  depth into the band, exported + unit-tested) and re-extends the
  selection to `posAtCoords` of the pointer — clamped just inside the
  scroller so a pointer parked past the edge keeps pulling in the
  edge-most line even while held still. The loop self-reschedules only
  while it actually scrolls, so it stops at the scroll limit or when the
  pointer leaves the band; it tears down on mouseup. Works in both
  single-doc and multi-pane because it's keyed off each view's own
  scroller, and needs no new wiring since the plugin is already in
  `buildEditorPlugins`.

- **`findRememberLastQuery` is honored again.** The find bar
  (`find-replace-ui.ts`) reuses one DOM input across open/close and
  never cleared it, so once a query was typed it lingered in the
  element. `open()` only pre-filled "when the input is empty", which was
  never true after the first use — so the remembered query stayed
  visible regardless of the setting (and `close()`'s gated persist was
  irrelevant). Fix: capture `wasClosed = this.root.hidden` before
  un-hiding, and on a fresh open set the input value deterministically —
  `settings.get('findLastQuery')` when `findRememberLastQuery` is on,
  `''` when off — instead of conditionally pre-filling only an
  already-empty field. Guarding on `wasClosed` means re-triggering while
  the bar is open (Ctrl-F → Ctrl-H mode switch) still preserves what's
  typed.

- **"Cycle Theme" ribbon command (`cycleTheme`).** A bindable command
  that rotates the `theme` setting light → dark → system → light. Added
  through the standard registry path: the `RibbonCommandId` union,
  `RIBBON_COMMAND_IDS`, `RIBBON_COMMAND_LABELS` ("Cycle Theme (Light →
  Dark → System)"), `RIBBON_COMMAND_ALIASES` (dark mode / light mode /
  toggle theme / switch theme), `DEFAULT_RIBBON_KEYS` (`''` — unbound),
  the `View` ribbon group (satisfies the drift guard), and a
  `commandFor` case that calls a new `RibbonContext.cycleTheme` hook.
  The hook is implemented in `index.ts` where the context is built: it
  reads `settings.get('theme')`, advances through `['light','dark',
  'system']`, calls `settings.set('theme', next)` (the existing
  subscription re-runs `applyTheme`), and shows a `Theme: <next>` toast.
  Being in the registry, it auto-appears in the keybindings editor, the
  shortcuts reference, and the command palette — no per-surface wiring.

- **Analytic / Undertag document colors: unified the two settings,
  fixed the inert Appearance picker, and made dark-mode behavior
  correct.** Two settings both targeted the same CSS vars and fought.
  `applyDisplayColors` (Appearance → "Style colors", `displayColors`)
  wrote `--pmd-color-analytic` / `--pmd-color-undertag` inline on
  `:root`; `applyCustomColorOverrides` (Accessibility → "Color
  overrides", `customColorOverrides`, whose `CUSTOMIZABLE_COLOR_TOKENS`
  includes those two) ran *last* and, for any token not in the
  overrides blob, called `removeProperty('--pmd-color-analytic')` —
  wiping the displayColors write. Net effect: the Appearance picker did
  nothing unless you also set an Accessibility override.

  Reworked onto a single source of truth (`displayColors`) with a
  CSS-variable indirection so the theme can layer on top:
  - `applyDisplayColors` now writes the user's pick to
    `--pmd-user-color-*` (not `--pmd-color-*`). `style.css` resolves
    the effective `--pmd-color-*` from it: `:root` →
    `var(--pmd-user-color-analytic, #1F3864)` (light = user color);
    `:root[data-theme="dark"]` → the built-in `#8aa9d1` / `#8fb377`
    (chrome/nav, readable on dark — now actually effective because the
    inline write targets a *different* variable);
    `:root[data-theme="dark"]:not([data-theme-doc="dark"]) :is(#editor,
    .pmd-pane-editor)` → back to `var(--pmd-user-color-*, …)` so the
    document keeps the user color while it's on paper; with apply-to-doc
    ON the editor inherits the dark `#8aa9d1` instead. Behavior matrix:
    light = user / user; dark not-applied = light-blue nav / user doc;
    dark applied = light-blue / light-blue.
  - `applyCustomColorOverrides` is now passed `CUSTOM_OVERRIDE_TOKEN_NAMES`
    (the manifest minus the two document-text tokens) so it can no
    longer remove/clobber them.
  - The Accessibility "Document text" rows (`buildColorOverridesEditor`)
    are special-cased via `DISPLAY_COLOR_TOKEN_TO_KEY`: they read/write
    `displayColors`, hide the alpha slider, and reset to
    `DEFAULT_DISPLAY_COLORS` — so they're a linked view of the same
    value the Appearance picker edits.
  - `buildColorsEditor` (Appearance) gains a per-row reset-to-default
    button; "Reset all overrides" also resets `displayColors`.
  - Migration: `sanitizeDisplayColors(raw, rawOverrides)` folds any
    legacy `customColorOverrides['pmd-color-analytic'|'pmd-color-undertag']`
    into `displayColors` (the override wins — it's what actually
    rendered), and `sanitizeCustomColorOverrides` drops those two tokens
    so there's no double source going forward.

- **Command-palette search aliases for settings and commands.** The
  Search-Everything palette matched a query only against a command's
  `RIBBON_COMMAND_LABELS` entry or a setting's `SettingMeta.label`, so
  anything phrased differently than the label simply didn't appear.
  Two new alias registries fix that, matched but never displayed:
  `RIBBON_COMMAND_ALIASES` (a `Partial<Record<RibbonCommandId,
  readonly string[]>>` in `ribbon-commands.ts`) and an optional
  `aliases?: readonly string[]` on `SettingMeta` (`settings.ts`).
  `searchCommandSource` / `searchSettingsSource` in
  `quick-card-search-ui.ts` now build the match haystack from
  `label + ' ' + aliases.join(' ')` while still ranking by first-token
  position *within the label* (an alias-only hit ranks via `Infinity`,
  so label hits always sort ahead). Two recurring motivations: the
  show/hide ⇄ toggle bridge the user asked for (`toggleCommentsVisible`
  ⇄ "toggle comments", `toggleNavPane` ⇄ "toggle navigation pane" /
  "sidebar"), and vague or Word-flavored labels ("Clear" ⇄ "clear
  formatting", "Paste Plain Text" ⇄ "paste without formatting"). The
  Theme setting gains `light mode` / `dark mode` / `toggle theme` /
  `system theme` / `color scheme`; other settings get the obvious
  alternate names (Line spacing ⇄ "line height", Interface font ⇄ "ui
  font", Reduce motion ⇄ "animations", Three-pane workspace ⇄ "split
  view", etc.). Aliases are lowercase because the palette lowercases
  the query before matching.

- **Learn section keeps Manage reachable with zero flashcards.**
  `renderLearn` in `src/editor/home-screen.ts` used to replace the
  whole section with a single muted placeholder card when
  `totalCount({ kind: 'all' }) === 0`. But "Manage flashcards" opens
  the manage UI, which carries the Import button — the only way to
  bring in cards from a file — so the empty state was a dead end for
  anyone trying to import. The empty branch now renders the same
  two-card row as the populated state: a disabled "Review all" card
  (new `{ disabled }` option on `actionCard` — sets `btn.disabled`,
  adds `.pmd-home-action-disabled`, skips the click listener) and a
  live "Manage flashcards" card. The keyboard-shortcut runner for
  Manage lost its `totalCount > 0` guard for the same reason. The
  orphaned `.pmd-home-action-placeholder` CSS was repurposed into
  `.pmd-home-action-disabled` (muted opacity, neutral hover).

## 0.1.0-alpha.6 — 2026-05-30

- **`.cmir` loader stamps fresh ids on id-less headings at parse
  time.** New `stampMissingHeadingIds(doc)` in `src/schema/ids.ts`
  walks the parsed `PMNode` tree and reconstructs any pocket /
  hat / block / tag / analytic whose `id` attr is null with a
  fresh UUID. `parseNative` calls it on the
  `schema.nodeFromJSON(file.doc)` output. Origin of the id-less
  headings: PM's schema fitter, when it bubbled up F2's
  multi-line plain-paste split to the card level, synthesized
  the second-half card's mandatory first-child tag from the
  schema's `headingAttrs.id.default` (= `null`) rather than via
  `newHeadingId()`. That path is closed at the source as of the
  F2 fix earlier in this release, but old docs written before
  the fix carry those id-less tags frozen into the file.
  `setCaretHeading` in `nav-panel.ts` keys the cursor → nav
  highlight on the heading id (skipping null), so an id-less tag
  is functionally invisible to the highlight — the cursor in
  that card appears in the *previous* card's slot. Stamping at
  load repairs the file in place; the next save (in any path
  that writes the doc back through `serializeNative`) makes the
  repair persistent. The walk runs once at parse time, returns
  the original node by identity when nothing needed stamping
  (no-op cost), and preserves indent / spacing / other attrs
  on the stamped heading. A pair of tests in
  `tests/native/native.test.ts` covers the load-time stamp and
  the existing-id no-op; a focused suite in
  `tests/schema/stamp-missing-heading-ids.test.ts` covers the
  helper across the full heading set + edge cases (round-trip
  identity when nothing's null, isolated stamping in mixed docs,
  attr preservation).

- **Fast Debate Paste integration — main-process HTTP bridge +
  renderer-side insertion primitive.** Spec lives at
  `reference-docs/cardmirror-integration-spec.md`. New
  `apps/desktop/src/fast-paste-bridge.ts` boots a Node `http`
  server on `127.0.0.1:17699` (ephemeral fallback on EADDRINUSE)
  in `app.whenReady()`. On start it generates a fresh per-launch
  token via `crypto.randomBytes(24)`, writes the discovery file
  at `app.getPath('userData')/fast-paste-bridge.json` via
  tmp-then-rename, and tears both down on `before-quit`. Both
  routes constant-time-compare `X-FDP-Token`; mismatched / absent
  token → 403. Any request carrying `Origin` or `Referer` is
  also rejected (the DNS-rebinding-from-a-browser-page guard the
  spec calls out). `GET /ping` replies with
  `{ok, app, appVersion, schema, hasActiveDoc}`. `POST /insert`
  forwards `{requestId, text, role, newParagraph, omitted}` to
  the focused window's renderer via `external:insert-text` IPC
  and awaits the renderer's `external:insert-result` reply with
  a hard 1200ms timeout so the client never hangs (it enforces
  1500ms on its end before falling back to keystrokes). Error
  codes map: `no-target-doc` / `doc-readonly` → 200 with
  `ok:false`, `bad-request` → 400, `unauthorized` → 403,
  anything else → 500. Unknown `role` values degrade to `card`.

  Renderer side: new preload channels (`external:insert-text`
  receive, `external:insert-result` send) on the existing
  contextBridge surface — no `executeJavaScript` under
  contextIsolation. `src/editor/external-insert-host.ts`
  subscribes via `installExternalInsertHost`, called from the
  boot block in `index.ts` alongside the dropzone controller.
  When a request arrives it resolves the live `EditorView` (or
  returns `no-target-doc` if none), checks `view.editable` for
  the read-mode gate (returns `doc-readonly` when the flag is
  off — the same gate that swallows F2 keystrokes today), and
  hands `{text, newParagraph}` to
  `src/editor/external-insert.ts`'s
  `buildExternalInsertTransaction`. The primitive splits `text`
  on `/\r\n|\r|\n/`, builds each piece as a `card_body` node
  (or `paragraph` when the cursor has no `card` / `analytic_unit`
  ancestor — i.e. at doc level), assembles a closed-start /
  open-end Slice, and `tr.replaceSelection`. The closed start
  makes the first inserted body a fresh sibling at the cursor
  (mirrors the keystroke bridge's "press Return first"); the
  open end merges the last body's content with whatever was
  after the cursor in the original textblock (mirrors what F2
  paste does after the Return). Because the node types are
  chosen directly, the schema's content expression is satisfied
  in one pass — no contextual fitting, no fitter bubble-up, no
  way for a pasted line to be elevated to a tag (which is the
  same failure mode the F2 fix in this release closes from the
  other direction).

  Tests cover the route layer (`tests/desktop/fast-paste-bridge.test.ts`,
  16 cases — token, ping shape, Origin/Referer rejection, all
  five error codes, payload validation, unknown-role degradation,
  no-focused-window short-circuit, discovery-file lifecycle),
  the primitive (`tests/editor/external-insert.test.ts`, 10
  cases — mid/start/end of card_body, multi-line, the spec's
  §9 acceptance case, doc-level fallback to `paragraph`, empty
  text, trailing newline, inline + leading-space convention),
  and the renderer-side host (`tests/editor/external-insert-host.test.ts`,
  7 cases — happy path with docTitle, inline, no-target-doc,
  doc-readonly, bad-request, docTitle suppression when no
  filename). Vitest's `electron` module is aliased to
  `tests/desktop/_electron-stub.ts` (electron isn't installed at
  the project root) so the bridge can be driven without
  bootstrapping a real Electron process.

- **F2 plain-paste: route through `tryPasteAsCardBodies` like rich
  paste does.** `applyPlainPasteFromText` (the Electron F2 entry
  point) and the armed-paste branch of `handlePaste` (the browser
  F2 entry point) both used to do `tr.replaceSelection(slice)`
  directly with the slice that `buildPlainTextSlice` produces — a
  `Fragment([paragraph(line1), paragraph(line2), …])` with
  `openStart=1 / openEnd=1`. `paragraph` is not in the `card`
  content expression (`tag (card_body | undertag | cite_paragraph
  | analytic | table)*`), so when the slice landed inside a
  `card_body` PM's Fitter could only fit the first and last
  paragraphs via the openings — every middle paragraph then bubbled
  the split up to the card level. The Fitter's second-half
  reconstruction has to start with a `tag` (the card's content rule
  is non-negotiable), so it would either synthesize a phantom
  empty-tag card sibling or, in the configurations the FDP spec
  flagged, convert the first content node it had on hand into a
  tag — which is where the "extra spacing between pasted lines"
  user reports come from (the tag's `margin: 0.75rem 0 0.25rem 0`
  rendering as the gap). The absorb plugin re-claims orphan
  paragraphs into the preceding card, but the brief bubble-up plus
  re-absorption still moves the cursor through an awkward
  trajectory before landing it. The fix is the same one
  `handlePaste` already uses on the rich-paste path
  (`paste-plugin.ts:269-272`): call `tryPasteAsCardBodies` first to
  pre-convert the slice's `paragraph` nodes to `card_body` nodes
  before `tr.replace`, so the Fitter has no fitting problem to
  solve. The cursor now lands at the end of the last pasted line
  (or on the trailing empty body when the text ends in a newline,
  which is the "cursor on a fresh line is fine" case). Slices where
  `tryPasteAsCardBodies` returns null (single-line paste, non-
  card-body cursor, non-paragraph children) keep going through
  `replaceSelection` as before.

- **F12 dissolve + absorb-plugin: cursor preservation for the
  inside-the-replaced-range case.** Two related fixes in one entry.

  (1) `applyClearToNormalDemote` in `ribbon-commands.ts` dissolves a
  card or analytic_unit when F12 lands on its head (tag / analytic):
  it builds a `paragraph(cleanedHeadContent)` plus a lifted version
  of each trailing child (`card_body` / `cite_paragraph` →
  `paragraph`, `undertag` kept, `analytic` → `analytic_unit`-wrapped),
  then `tr.replaceWith(containerStart, containerEnd, lifted)`. PM's
  default `ReplaceStep` selection mapping pushes any position inside
  the replaced range to the END of the replacement (the assoc=1
  right-association convention) — same root cause as the original
  absorb-plugin "viewport rockets to doc end" bug. After the replace
  we now compute the cursor's logical position in the new structure
  via a new `mapPosThroughDissolve` helper (which walks the original
  container's children to find which one held the cursor + the
  intra-child offset, then resolves the corresponding position in
  the lifted-children sequence, accounting for the extra opening
  boundary that the analytic → analytic_unit wrap adds) and call
  `tr.setSelection(TextSelection.between(...))`. Same template as
  `dissolveContainerToHeading` at `ribbon-commands.ts:625-631`,
  which had this fix from the start.

  (2) `absorb-plugin.ts`'s surgical insert+delete preserved cursor
  positions outside the absorbed-orphan range but lost the ones
  inside it: step 2's `tr.delete(orphansStart+insertSize,
  orphansEnd+insertSize)` claims the cursor's range, and PM's
  default assoc=1 mapping pushes the cursor to the end of the
  deletion (which auto-snaps to the last textblock of the now-
  absorbed card). The plugin now captures `newState.selection`'s
  head/anchor before its steps run, flags whether either fell into
  any region's orphan range, and after the steps calls
  `tr.setSelection` with each flagged endpoint mapped to
  `origPos - 1` — the absorbed orphan now lives just before the
  card's closing boundary (one fewer doc-level boundary stands
  between the original orphan position and the new card_body
  position), so the position offset is `-1` regardless of how many
  orphans the region absorbs or how many regions absorb to the
  left.

  Together these handle the F12 → absorb cascade the user hit:
  F12 on Card B's tag (with Card A preceding it) demotes the tag
  to a paragraph at doc level, absorb claims that paragraph plus
  the lifted bodies into Card A, and the cursor follows the
  demoted text into Card A at the original character offset
  instead of landing at the tail of Card A's content. The probe
  test at `tests/editor/paste-viewport-bug.test.ts` (already a
  catalogue of this family of bugs) grows new F12 cases plus
  improved expectations on the pre-existing `H` scenario (cursor
  in an orphan paragraph that absorb claims).

- **Dropzone pill fallback now clears the status bar.** `.pmd-dropzone-
  root`'s CSS fallback `bottom` is now `calc(var(--status-bar-height)
  + 0.5rem)` (was `0.5rem`), and its `z-index` is `220` (was `12`,
  above the status bar's `200`). `positionDropzone` (`index.ts`) still
  reads `#app`'s / the focused pane body's live rect and inlines the
  exact `bottom`, but on some Windows machines that pass landed when
  the target's `getBoundingClientRect()` was 0×0 — the function
  early-returns there, and nothing later was firing to re-run it
  (`ResizeObserver` only fires on size *changes*; the layout-stabilizes-
  to-its-final-size case doesn't trigger a delta). The pill stayed at
  its CSS fallback, ~8px above the viewport bottom, sitting in the
  status bar's vertical band. A second symptom in the same screenshot
  (the pill rendering visibly on top of the status bar rather than
  being clipped by it despite `z-index: 12` losing to the bar's `200`)
  is consistent with a Chromium layer-promotion quirk on Windows,
  rooted in two body-level `position: fixed` elements with `box-
  shadow` ending up on independent composited layers whose paint
  order doesn't always honor the in-spec stacking. The new fallback
  prevents the overlap from happening in the first place; the z-index
  bump keeps the pill visible and clickable if a future layout change
  recreates an overlap.

- **Paste-time unwrap of single-cell layout tables.** `paste-plugin.ts`'s
  `transformPasted` hook now runs a new `unwrapSingleCellTables` pass
  ahead of `freshHeadingIds`. Pasting from sources that use `<table>`
  as a layout primitive (Google Docs published views, news-site article
  bodies, marketing emails, .docx page-frame copies) used to leave the
  wrapping `table` node intact in the parsed clipboard slice — and
  because both `table` and `table_cell` are `isolating: true` in our
  schema (`src/schema/nodes.ts:528, 573`), the surrounding `card_body`
  could neither join across the boundary nor be deleted around it.
  Visible failure modes: (a) an empty 1×1 table between a card's cite
  and its first body paragraph rendered as an apparently-empty line
  that Backspace would refuse to remove, expanding to swallow the
  whole card on retry; (b) a 1×1 with content rendered text inset
  from a real card body, with a small extra vertical gap above,
  because of the cell's default padding + the table's block-level
  margin. New rule: any `table` whose every row contains exactly one
  cell unwraps to the concatenation of its cells' paragraphs. Multi-
  cell-per-row tables (real data tables) pass through unchanged.
  Empty 1×1 tables fall out as the degenerate case (no paragraphs to
  lift). At the slice root we emit generic `paragraph` nodes so PM's
  contextual fitting and our own `tryPasteAsCardBodies` adapt them to
  the cursor's body slot; when the unwrap happens inside a `card` /
  `analytic_unit` already present in the slice (whole-card paste case),
  we emit `card_body` directly so the parent's content rule is
  satisfied without depending on downstream fitting. F2 plain-paste
  is unaffected because that path bypasses the HTML parser and
  builds the slice from `text/plain` via `buildPlainTextSlice`,
  which can only produce `paragraph` and `text` nodes.

## 0.1.0-alpha.5 — 2026-05-29

- **Find ordering: document-order-from-cursor, not proximity.**
  `find-replace-plugin.ts`'s `compareByProximity` (nearest-first in both
  directions) is replaced by `compareFromCursor`: matches at/after the
  anchor come first, then those before it, each side ascending by
  document position — i.e. top-to-bottom from the cursor, wrapping to the
  top. Both sort modes use it: `categorized` (Ctrl-F) as the
  within-category tiebreak (after category priority + the cite sub-rank);
  the former `proximity` mode is renamed **`uncategorized`** (Alt-F) and
  is just `compareFromCursor` over the flat match set. `openFindByProximity`
  keeps its command id (so existing rebinds don't orphan) but its label is
  now "Find Without Category Grouping" and `index.ts` opens it with
  `sortMode: 'uncategorized'`; the find-bar mode chip + tooltips updated.

- **Flashcard export / import (Manage flashcards).** `learn-store.ts`
  gains `exportCards()` → `ExportedCard[]` (per card: content + a
  cardId-less `schedule` + its `{ docId, anchor }[]` groundings) and
  `importCards(entries, today)`, which mints a **fresh cardId per entry**
  so import always ADDs (re-importing duplicates, by design; never
  overwrites), carrying the schedule (cardId reassigned) or a fresh one,
  plus anchors. The Manage GUI's bar gets **Import** / **Export** buttons
  over the host `saveAs` / `openFile` JSON pickers (`{ version: 1, cards }`,
  bare array also accepted). `parseImportedCard` / `parseImportedAnchor`
  defensively coerce each untrusted entry (type ∈ qa|cloze, non-empty
  front, well-formed schedule-or-fresh, valid `AnchorDescriptor`-or-null),
  so older/foreign files import cleanly. The open list refreshes via the
  store subscription; no overwrite confirm needed (import is additive).

- **Settings export / import.** `SettingsStore.exportObject()` returns all
  values minus the transient per-window keys and `anthropicApiKey`;
  `replaceAll(raw)` overwrites through the same
  `sanitize({ ...DEFAULTS, ...raw })` boundary as `load` — so it tolerates
  schema drift (added fields → defaults, removed → dropped, bad values
  coerced/clamped) and preserves the current API key + transient values.
  Settings → General gains a "Back up settings" section
  (`buildSettingsBackupSection`) with Export / Import buttons over the host
  `saveAs` / `openFile` JSON pickers (writes `{ version: 1, settings }`,
  also accepts a bare object). Import confirms, runs `replaceAll`, then
  re-renders the dialog so every control reflects the imported values.

- **Settings tab underline no longer clipped when the tab strip scrolls.**
  The active tab's 2px `border-bottom` is pulled 1px below
  `.pmd-settings-tabs`'s content box via `margin-bottom: -1px` (to overlap
  the bar divider). That strip is a horizontal scroll container
  (`overflow: hidden`); at scrollLeft 0 the negative-margin overflow isn't
  clipped, but once `scrollTabIntoView` nudges a mid-strip tab to a
  non-zero scroll the clip drops the underline — so the middle tabs
  (Keyboard, Comments & AI) lost it while the edge tabs kept it. Added
  `padding-bottom: 1px` to the strip so the underline stays inside the
  clip box at any scroll position.

- **Keyboard macros — bind a key to type a snippet.** New
  `keyboardMacros: KeyboardMacro[]` setting (`{ id, key, text }`;
  sanitized; default `[]`). `keyboard-macros.ts`'s `buildMacroKeymap`
  turns the list into a `keymap()` where each key inserts its text at the
  cursor (`tr.insertText`), installed in `buildEditorPlugins` **before**
  the ribbon keymap so a macro key wins over a same-key command. The
  reconfigure subscriber in `index.ts` rebuilds the plugin stack when
  `keyboardMacros` changes (alongside `ribbonKeyOverrides`), so edits take
  effect live without a reload. UI: a "Keyboard macros" section appended
  below the shortcut list in `keybindings-editor.ts`, reusing the
  shortcuts' visual vocabulary so it reads as the same control — section
  title + description use the settings-row classes
  (`.pmd-settings-row-title` / `-desc`) to match the "Keyboard shortcuts"
  heading; the same boxed `.pmd-keybindings-list` container and
  `.pmd-keybinding-row` rows, with the shortcut shown as a
  `.pmd-keybinding-chip` (empty `—` + "+" until set) and the typed-text
  field in the row's flex "label" slot. Key
  capture reuses `ribbonKeyStringFor` + `validateKey`; the text field
  commits on `change` (not per keystroke, to avoid a focus-stealing
  re-render); per-row delete + an "Add macro" button below the box; an
  empty-state row when there are none. Setting a key clears it from any
  other macro (one key = one macro); macro-vs-command conflicts are
  resolved at runtime by plugin order (macro wins), not dislodged.

- **Home screen: number keys 5-7 for the newer action cards.** Extended
  `actionRunners` + the `onKeyDown` digit map (`home-screen.ts`) from 1-4
  to 1-7: 5 = Bulk convert, 6 = Review all, 7 = Manage flashcards. The
  three new runners guard on the same conditions that render their card
  (`callbacks.bulkConvert` present; `learnStore.totalCount > 0`), so a key
  only fires while its button is on screen.

- **Ribbon: Create-flashcard + Ask-AI buttons in the comments group.**
  Both commands were bindable / palette-only; they now have ribbon
  buttons. The comments ops-panel becomes a 2×2 grid (`ribbon-doc-ops-
  panel-2col`): comments-toggle / add-comment on top, create-flashcard /
  ask-ai below. Clicks `preventDefault` on mousedown (keep the selection
  live) and run the bindable command via `runRibbonCommandById`. The
  **Ask-AI** button is hidden unless `aiFeaturesEnabled`
  (`applyAskAiButtonVisibility`, driven by the central `settings.subscribe`
  + an explicit `#ribbon .ribbon-doc-ops-btn[hidden]` rule, since
  `#ribbon button { display: inline-flex }` otherwise defeats `[hidden]`).
  Two new icons (`flashcard` → graduation-hat-02, `ai` → stars-02) added
  to `gen-icons.mjs` + the `IconName` union. Tooltips use sentence-case
  label overrides (`Create flashcard from selection` / `Ask AI about
  selection`) while the command-palette labels stay title-case.

- **Frozen selection: keep the selection painted while the editor is
  blurred.** A contenteditable's native selection vanishes when focus
  leaves it (the command / search palette input, the find bar, etc.), so
  a user who selected text then opened a palette lost sight of it. New
  `frozen-selection-plugin.ts` tracks focus via `blur`/`focus` listeners
  on `view.dom` (a doc-neutral `addToHistory:false` meta) and, while
  blurred, renders an inline decoration over the current `TextSelection`
  with the same tint as the live `::selection` (`.pmd-frozen-selection`,
  accent 30%); cleared on focus so PM's real selection takes back over.
  Registered in `buildEditorPlugins`, so single-doc, multi-pane, and the
  quick-cards editors all get it. Node selections keep their own
  `ProseMirror-selectednode` styling, so the plugin paints text
  selections only.

- **Comments column: one unified card design (comments / flashcards / AI).**
  The three card types had drifted into three visual vocabularies; this
  unifies them.
  - **Type chip.** Every card leads with a shared chip (`makeCardTypeChip`
    → `.pmd-card-type-chip`): `COMMENT` / `Q&A` · `CLOZE` / `AI`, colored
    to mirror the in-text highlight hue (gold / accent / purple).
    Replaces the flashcard's bespoke `.pmd-flashcard-card-badge` and the
    per-turn `.pmd-ai-chip`.
  - **No left borders.** Per-card identity is now a CSS var
    `--pmd-card-accent` (gold / accent / purple) set on the card, driving
    both the chip and the **active** state — which now takes the card's
    own color (border + a same-hue tinted glow) instead of always-blue.
  - **Avatar only when expanded.** Collapsed previews drop the round
    avatar (chip + excerpt + count); the avatar returns when expanded,
    where it separates the thread-opening turn from replies. AI turns
    keep the purple avatar (`pmd-comment-ai`) + persona name; the
    per-turn AI tag is gone (the card chip carries it).
  - **AI opening question renders as root.** `populateAiThread` renders
    the first turn via `renderAiComment(c, isRoot=true)` → un-indented
    `pmd-comment-root` (it begins the conversation); answers + follow-ups
    are `pmd-comment-reply`. Previously every AI turn was a reply, so the
    opening question looked like a reply to nothing.
  - **Delete affordances split by type.** Comment + AI cards get a
    thread-delete `✕` in a shared card header (`buildThreadHeader`);
    comment replies keep a per-reply `✕`; flashcards keep the two-click
    Delete pill. The AI ghost-pill action row is gone — **Convert to
    Flashcard** is promoted to a filled-blue button (`.pmd-ai-convert-btn`)
    below Reply.
  - **Header row + date; send-key input.** The type chip sits in its own
    header row in every state (collapsed too, via `buildThreadHeader`),
    with the card's date right-aligned beside it (comment = root date, AI
    = thread `createdAt`) — the slot the flashcard's status chip occupies.
    The reply / ask / comment submit is now a compact `send-cursor` icon
    button to the right of the textarea (row layout), not a full-width
    button below.
  - Removed `renderAiHeader` / `renderRootHeader` / `buildAiActions` /
    `aiChip`. Unanchored rows unchanged.

- **AI threads → local annotation layer.** Migrated the "Ask AI about
  selection" explainer off comment threads (round-tripping
  `comment_range` marks) onto the same per-user local layer flashcards
  use (SPEC-learn-system §"one local layer"), so AI questions never
  serialize into a shared `.docx`/`.cmir`. Design (per the user):
  **local-only** (like flashcards) and **going-forward only** (existing
  AI *comments* in documents stay as comments; no auto-migration).
  - **Store.** Wired the previously-unused `AiThread` / `LocalComment`
    scaffolding in `learn-store.ts`: added `getAiThread` and
    `appendAiComment` alongside the existing `addAiThread` /
    `setAiThreadAnchor` / `removeAiThread` / `aiThreadsForDoc`. AI threads
    persist in the same host KV blob (`aiThreads[]`) keyed by `docId`.
  - **Anchoring + highlight.** AI threads ground via the shared
    `AnchorDescriptor` (`buildDescriptor`/`resolveDescriptor`) and paint a
    **purple** decoration. The highlight plugin's `FlashcardRange` gained
    a `kind: 'flashcard' | 'ai'` (mapped through edits + the drop-recovery
    re-resolve); `buildDecos` picks `.pmd-ai-range` vs `.pmd-flashcard-range`.
    `comments-ui`'s `refreshFlashcardAnchors` now resolves AI-thread
    anchors too.
  - **Create.** The `aiAskAboutSelection` command (`index.ts`) now mirrors
    `createFlashcard`: build a descriptor, `ensureActiveDocId` +
    `registerDoc` + `stampActiveFileDocId`, `learnStore.addAiThread`, then
    `commentsColumn.activateAiThread`. **No `comment_range` mark.**
  - **Render.** `comments-ui` render() adds AI threads as a third item
    kind in the sorted column list (purple `pmd-ai-card`): producer
    "ask" input when empty, collapsed preview, active conversation
    (`LocalComment[]`) with reply box + two-click delete, plus a
    re-ground row + Unanchored section (mirroring flashcards). AI turns
    show the persona name with initials derived from it (`aiPersonaName`
    / `aiPersonaInitials`) and an **"AI" chip** (`.pmd-ai-chip`) — the
    round-trip-safe `'AI'` initials + `(AI)` name suffix the comment path
    needs are dropped here, since a local thread never serializes so the
    docx-survival heuristic is moot; the chip carries the AI signal.
  - **Model call.** `askAi` records the user's turn then calls
    `invokeAiLocal`, which mirrors the comment-thread `invokeAi` against
    the store `AiThread`: builds the multi-turn message list from
    `LocalComment[]` (user turns → `user`, `ai: true` turns →
    `assistant`, first user turn wrapped in `formatExplainPrompt`), shows
    the Thinking… placeholder + Clod activity ticker while in-flight, and
    `appendAiComment`s the reply as an `ai: true` turn. Context is cached
    at activation from the original selection (`buildExplainContext`,
    captured before scroll moves the caret), with `contextFromAiThread`
    (resolve the anchor → range → context) as the post-reload fallback.
    Reply turns re-invoke automatically (it's an AI thread).
  - **Convert to Flashcard.** Active AI cards get a **Convert to
    Flashcard** action (beside Delete). It asks the model for one card
    (Q&A or cloze) capturing the thread's line of inquiry, then opens the
    create-flashcard editor pre-populated so the user edits/confirms; the
    new card grounds to the **same** selection as the AI question
    (`setAnchor(cardId, thread.docId, thread.anchor)`). New module
    `ai/flashcard-gen.ts` holds the research-grounded `FLASHCARD_SYSTEM_
    PROMPT`, `formatFlashcardPrompt` (highlight + card context + the
    conversation, with the user's questions called out as the angle
    signal and the AI replies demoted to background), and a tolerant
    `parseFlashcardReply` (extracts the outermost `{...}`, validates type
    / non-empty front / Q&A-needs-back). The prompt is built from the
    `reference-docs/mnemonic-medium/` corpus: it leans on the highlight +
    questions + card tag as the signal of what the user wants reinforced
    ("highlights → interests"), defaults to Q&A over cloze, and names the
    five `probes/` pathologies (shallow / narrow / wordy / lacks-context
    / solicits-multiple-responses) plus the positive attributes as
    explicit constraints — atomicity foregrounded as the top rule (one
    fact per card; no compound "and"/list/fact-plus-reason cards) with
    the binary Remembered/Forgot grading as the rationale; richness goes
    in separate cards. Then self-contained, unambiguous, deep, concise.
  - **Cleanup.** Removed the now-dead comment-based AI creation path:
    `addAiThreadFromSelection` and the `pendingAiFirst` machinery (its
    only writer) — `renderPrimaryInput` / `commitRootText` lose their
    AI-specific branches. The `@AI`-mention-in-a-comment path (a separate
    surface) is unchanged and still uses the comment-thread `invokeAi`.

- **Paste stamps fresh heading ids (nav pane works on pasted sections).**
  The heading nodes (pocket/hat/block/tag/analytic) carry a stable `id`
  that the nav pane keys expand/collapse, jump-to, and the 1/2/3/4 level
  filter off of — but the schema's `parseDOM.getAttrs` reads only
  `indent`, never `data-id`, so PM's clipboard parser returns pasted
  headings with `id: null`. Drag-copy / dropzone / send-to-speech all
  call `rewriteHeadingIds` to keep ids unique, but paste had no
  equivalent, so pasted pockets/hats/blocks/tags were id-less and inert
  in the destination outline (permanently expanded, un-jumpable, ignored
  by the level filter). `rewriteHeadingIds` couldn't be reused as-is — it
  only rewrites *existing* non-null ids — so `drag-controller.ts` now
  factors the slice walk into `mapSliceIds(slice, predicate)` behind two
  exports: `rewriteHeadingIds` (assign when the node already has a
  non-empty id) and the new `freshHeadingIds` (assign to every id-bearing
  node, filling nulls). The paste plugin gains a `transformPasted` prop
  that runs `freshHeadingIds` — it fires inside PM's `parseFromClipboard`
  before `handlePaste` sees the slice, so the tag/analytic split and
  card-body paths get fresh ids too. The `parseHeadFromHTML` fallback
  (which re-parses the raw clipboard HTML and so bypasses
  `transformPasted`) stamps its reconstructed head directly.

- **Drag-and-drop now jumps to the dropped section like a nav-pane
  click.** Before, every drop path in `drag-controller.ts` ended in
  `tr.scrollIntoView()` over a transaction that never set a selection —
  so PM scrolled to the *default mapped selection* (the pre-drag caret,
  shifted by the move's delete+insert), which only coincidentally pointed
  at the moved content. Two parts to the fix: (1) `buildMoveTransaction` /
  `buildCopyTransaction` capture the first-insert position and end with a
  shared `selectTopOfInsert(tr, insertStart)` helper — `tr.setSelection(
  Selection.near(tr.doc.resolve(insertStart), 1))` — putting the caret at
  the top of the dropped content (its first heading); the cross-view /
  virtual-source (dropzone shelf) path applies the same helper to its
  inline insert transaction. (2) After dispatching the drop transaction
  (no more `tr.scrollIntoView()`), `scrollToDroppedTop(view)` resolves the
  DOM element at the new selection and `preciseScrollIntoView`s it — the
  identical primitive `nav-panel.ts`'s `jumpTo` uses, which re-measures /
  converges (handling `content-visibility: auto` undershoot) and pins the
  heading to the top of the viewport, rather than PM's `scrollIntoView`
  which only guarantees the caret lands somewhere on screen at an
  inconsistent offset. The same-view move path also now `focus()`es the
  source view after dispatch (the cross-view path already did) so PM
  syncs the DOM caret to the transaction's selection — otherwise the
  state selection was correct but the *visible* cursor stayed wherever it
  was before the drag. End result: a drop leaves both the viewport and
  the caret exactly where clicking that heading in the outline would.
  `Selection` is now a value import from `prosemirror-state`;
  `drag-controller.ts` now imports `preciseScrollIntoView`.

- **Nav-pane caret highlight re-applies after the debounced rebuild.**
  `dispatchTransaction` calls `navPanel.setCaretHeading(selection.from)`
  synchronously, but that scans `liEntries`' *cached* positions — which
  only refresh in the debounced `scheduleHeavyUpdate` → `navPanel.update`
  (~200ms). For small edits the drift is harmless (the comment on
  `setCaretHeading` already notes this), but a structural change like a
  drag-move leaves the wrong heading highlighted, and `update()` never
  re-ran the highlight, so it stayed wrong until the next caret movement.
  The heavy-update callback now calls `setCaretHeading(selection.from)`
  immediately after `navPanel.update`, against the freshly-rebuilt
  positions, so the highlight self-corrects. Single-doc path only; the
  multi-pane per-pane nav doesn't track the caret highlight at all.

- **Nav-pane double-click (collapse toggle) no longer relies on the
  native `dblclick`.** A plain nav click's `jumpTo` dispatches a
  selection-only transaction; `dispatchTransaction` then scheduled the
  debounced `scheduleHeavyUpdate` → `navPanel.update()` → `render()`,
  which does `listEl.innerHTML = ''` and rebuilds every `<li>`. Because
  `scheduleIdle` (requestIdleCallback) fires in the idle gap *between*
  the two clicks of a double, the clicked `<li>` was usually gone before
  the second click — and `dblclick` only fires when both clicks share a
  target node, so the collapse toggle silently dropped. (A regression
  since the heavy flush moved from a fixed 200ms `setTimeout` to idle
  dispatch in alpha.1; the multi-pane code even had a comment warning a
  per-keystroke rebuild "would invalidate any dblclick in progress".)
  Two-part fix: (1) the nav pane detects double-clicks itself in
  `onDragUp` — `handlePlainClickDouble(entry)` matches `entry.id` +
  timestamp (`NAV_DOUBLE_CLICK_MS`, 500ms) across two plain clicks and
  toggles via `toggleCollapsed` when the id is in a per-render
  `collapsibleIds` set; keying on the stable id rather than the DOM node
  makes it immune to the `<li>` being recreated between clicks. (2) Both
  `dispatchTransaction`s (single-doc and the multi-pane per-pane view)
  now gate the heavy flush on `tx.docChanged`, so a selection-only jump
  doesn't rebuild the outline at all — killing the mid-gesture re-render
  (and an O(doc) nav rebuild on every cursor move). The native `dblclick`
  listener is removed.

- **Comments column: Docs-like reflow layout.** `comments-ui.ts`'s
  `render()` no longer wipes + rebuilds the card DOM each pass — it
  reconciles a persistent `Map<threadId, element>` (and `fc:<cardId>`
  for flashcards), gated by a content signature so a card is
  re-populated only when its content / active state actually changed
  (the active reply textarea keeps focus + value across unrelated
  renders). A per-card `ResizeObserver` reflows the whole stack whenever
  any card's height changes (expand/collapse, AI text streaming in,
  reply box), and `top` animates (`transition`, suppressed on first
  placement via `pmd-card-settled`) so cards glide around each other
  rather than snapping. Fixes the previous one-shot layout that froze
  positions until the next debounced render. This is the shared layout
  the flashcard cards plug into.

- **Learn: create→review loop over a local annotation layer.** First
  user-facing slice of the spaced-repetition system (SPEC-learn-system).
  Flashcards never enter the document — they live in a per-user
  `LearnStore` (`learn-store.ts`) persisted as a single host KV blob
  (`learn-store-host.ts` → `read/writeLearnStore`), keyed by a stable
  per-document id.
  - **Identity.** A document carries a hidden `cmirDocId`: a `.cmir`
    field and, for `.docx`, a custom document property
    (`docProps/custom.xml`) that survives a real Word round-trip. The
    store splits identity so file-copies share one logical card + one
    schedule while each file keeps its own grounding: `CardDef` +
    `ScheduleEntry` per `cardId`; `CardAnchor` per (`cardId`,`docId`).
    Create Flashcard also stamps the id straight into the on-disk file
    (`stampActiveFileDocId` — reads the file, `stampDocId`, writes back),
    so a card made in a file CardMirror didn't author re-associates on
    reload without a manual save (no-op on web / never-saved docs / files
    that already carry an id).
    The docId is resolved mode-agnostically so single-doc and multi-pane
    behave identically: `index.ts` keeps `activeDocIdentity()` (focused
    `DocRecord`'s `{docId, uid}` or the single-doc globals),
    `ensureActiveDocId()` (mint + rekey the session uid), and
    `setActiveDocId()` (write back, in multi-pane via the
    `setFocusedDocId` shell hook). It's read from the file on open,
    backfilled on save, persisted on every save / autosave / journal
    write (so an autosave never strips identity), restored through crash
    recovery, and forked on a full Save As (`copyDocAnnotations`).
  - **Create Flashcard.** New ribbon command (`createFlashcard`, in the
    Learn group; reachable from the command palette) anchors a card to
    the selection: `buildDescriptor` (`learn-anchor.ts`, Hypothesis-style
    quote+context+position) captures the grounding, `learn-create-ui.ts`
    collects Q&A or cloze content, and the store gets a `CardDef` +
    due-today `ScheduleEntry` + `CardAnchor` keyed to
    `activeAnnotationDocId()`.
  - **Review.** `learn-session-ui.ts` is a full-screen overlay driven by
    `learnStore.queue(scope, today)`. Front → reveal → binary grade;
    grading goes through the Orbit-style scheduler (`learn-scheduler.ts`,
    binary interval ladder, no ease factor) which reports
    `retryInSession`, so a forgotten card is re-queued for later in the
    same session while its schedule is updated and persisted per grade.
    Cloze cards blank `{{deletion}}` on the front and highlight it on the
    reveal.
  - **Home Learn section.** `home-screen.ts` rebuilds from the store (on
    change + each show): "Review all due" + "Manage cards" cards plus a
    per-file / per-deck breakdown of scopes with cards due today, each
    opening a scoped session.
  - **Manage flashcards.** `learn-manage-ui.ts` (the `manageFlashcards`
    command, or the Home button) lists every card grouped by the file
    it's anchored to — built from new store reads `listCards()` /
    `listAnchors()` — with a text filter, a show-suspended toggle, and
    per-card edit (reuses `openCardEditor` with an `initial`),
    suspend/resume (`setSuspended`), and a two-click delete
    (`deleteCard`; native confirm is unavailable in Electron). A **New
    card** action creates a standalone card with no `CardAnchor` (still
    scheduled + reviewable under the 'all' scope). Cards shared across
    files are flagged; an "Unanchored" group collects standalone cards
    and any whose anchor is gone. Each unanchored card has a **link**
    button (new `link` icon): pick a file, and the card gets a
    file-level `CardAnchor` (null text anchor — grounded to text later
    from inside the file). Reading/assigning the file's identity uses
    new package helpers `readDocIdFromBytes` / `stampDocId`
    (`src/docid.ts`) — for a file with no id, one is minted and stamped
    in losslessly (`.docx` via `Docx.load → writeDocId → toBuffer`, no
    content re-render; `.cmir` via a minimal JSON field edit) and written
    back with `saveExisting`, so a future open re-associates. `openCreateFlashcard` was generalized to
    `openCardEditor({ selectedText? , initial? })` to serve both create
    and edit.
  - **In-context (comments column).** Anchored flashcards render in the
    comments column alongside genuine comments. The in-doc highlight is a
    **view-only decoration** (`learn-highlight-plugin.ts`,
    `.pmd-flashcard-range`), never a `comment_range` mark — so a card's
    grounding can't leak into a shared file by construction (no
    serialize-strip needed at any of the ~4 save sites). The plugin maps
    ranges through edits (bias from→right / to→left, matching
    `inclusive:false`) and drops a fully-deleted span. `comments-ui.ts`
    resolves each card's descriptor against the live doc lazily — on
    column open (SPEC §4.2), doc load (`mountView` rAF), multi-pane focus
    switch (`focusSlot`), and any store change while open — via
    `refreshFlashcardAnchors`, hands resolved ranges to the plugin
    (`setFlashcardRangesTr`), and renders flashcard cards positioned by
    those ranges (synthetic `fc:<cardId>` ids merged into the layout
    map). Unresolved cards (foreign edit / linked-but-not-grounded) go to
    a collapsible **"Unanchored (n)"** section pinned at the pane bottom
    (`positionUnanchored`) showing `anchor.quote` + a **Re-ground** button
    (`buildDescriptor` from the current selection → `setAnchor`). Each
    card has Edit / Suspend / Delete. A broken anchor never touches the
    card's schedule or file association (the store is never mutated by
    edit-tracking; "unanchored" is derived from non-resolution).
    Resolution gates on context, not just the quote: `resolveDescriptor`
    scores every quote hit (even a lone one) by how much its surroundings
    overlap the stored prefix/suffix and **rejects** the best (→ null →
    Unanchored) unless it clears `MIN_CONTEXT_FRACTION` (⅓) of the
    available context (`avail = min(prefix,CONTEXT)+min(suffix,CONTEXT)`),
    so a card whose anchored text was deleted unanchors instead of
    grounding onto a coincidental same-words hit elsewhere; one intact
    side clears the bar, and quotes near a doc boundary aren't
    over-penalized. `CONTEXT` is 60 chars each side.
  - Deferred: refreshing a descriptor from its live range on save (§4.2 —
    editing the *quoted text* unanchors on reload; re-resolution covers
    moves, re-ground covers the rest), deck management, and migrating
    Ask-AI threads into the local layer.

- **Command palette: file search (`f` prefix) — a first slice of corpus
  search.** Two on-demand stages, no persistent index yet (see
  ARCHITECTURE.md §11):
  - **File stage.** `f <query>` lists `.cmir` files under the new
    `fileSearchRoot` folder setting via `host:list-cmir-files` (cached —
    see the file-index note below), matched on filename with the same
    token-substring ranking the rest of the palette uses. The listing is
    held for the palette session; an `asyncToken` guards against stale
    list/read results from a prior query or a closed palette. Enter opens
    the file through `openFileByPath` → `routeOpenedFile` (extracted from
    `runOpenFlow`): the cross-window dup guard, then spawn-a-new-window
    (single-doc) or the slot picker (multi-pane), so it never overwrites
    the current window's doc.
  - **Within-file stage.** Tab on a highlighted file reads + `parseNative`s
    it once, runs `extractFile` (new `file-search.ts`), and enters a
    sticky in-file mode (the bar clears, prefix parsing is bypassed, Esc
    restores the prior file query). `extractFile` returns both an
    `outline` (the full pocket→hat→block→tag hierarchy with levels) and
    flat searchable `objects` (the enabled kinds + cites), reusing
    `collectHeadings` + `computeHeadingRange`. An **empty** query browses
    the outline — rendered indented, nav-pane style, in full (no 50-cap),
    cites excluded since they aren't headings; a non-empty query runs the
    flat object search. Insert granularity is whatever
    `computeHeadingRange` gives: tag/cite → the card, block/hat/pocket →
    the heading + its section, analytic → its unit. The parsed doc is
    kept on the in-file state and slices are taken **lazily** on insert
    (`doc.slice(from, to)`, same schema — no eager per-heading slicing or
    JSON round-trip), which also keeps the dive cheap. Inserts go through
    `insertSpeechSlice`, like quick cards.
  - **Collapsible outline.** The browse is collapsible: each pocket/hat/
    block carries a chevron (and the row's right-click toggles), hiding
    its subtree via a single-boundary visibility walk over the flat
    outline. The initial collapsed set is seeded from a new
    `fileSearchOutlineDepth` setting (default 3 = blocks shown, tags
    collapsed), mirroring the nav pane's `navMaxLevel`; collapse state
    lives on the in-file state and survives toggling between browse and
    search within a dive.
  - **Settings.** `fileSearchRoot` (folder), `fileSearchObjectTypes`
    (checklist; default block/tag/cite), and `fileSearchOutlineDepth`
    (Pocket/Hat/Block/Tag segmented control; default Block) under
    General, all Electron-only.
  - **Multi-grab.** Inserting a within-file object keeps the palette open
    and the parsed file in memory, so you can pull several blocks in a
    row (the parse cost is paid once per Tab, not per insert). Toast +
    bar refocus happen in the `afterInsert` hook (after the deferred
    insert's own `speechView.focus()`), and Ctrl/Cmd+Z / Shift+Z / Y are
    routed to the editor's `undo`/`redo` from the bar so a misfire can be
    taken back without leaving it. Other sources still close on insert.
  - **Pinned files — a warm working set.** A small curated set of files
    is kept "warm" (parsed `doc` + extracted objects/outline held in a
    module-level `warmCache` in the renderer) so dives into them skip the
    read+parse and are instant. Two kinds of pins:
    - *Manual* (★ on a file row / **Alt+P** on the selected one): shown
      with a solid star and floated to the top of `f`. Stored in a new
      `pins-store.ts` (localStorage, like `recents-store` — durable +
      cross-window without IPC).
    - *Auto* (silent): recents (top 6) ∪ frequents (used ≥ 2×, top 10),
      capped at 10 total; manual pins are exempt from the cap. Gated by
      the `pinAutoEnabled` setting (default on) for memory-sensitive users.
    The warm cache is keyed by path + `mtimeMs` (carried on `FileEntry`
    from `host:list-cmir-files`) with an `enabledSig` so a change to the
    searchable-object set re-extracts from the cached doc without
    re-parsing. The warm pass — `runWarmPass()`, a module-level function
    shared by the open palette and a proactive boot-time pre-warm — walks
    the effective set sequentially, **yielding to an idle slot
    (`scheduleIdle`) before each synchronous `parseNative`** so a `.docx`
    parse never lands on a keystroke (the renderer defers idle callbacks
    until the user pauses). It runs two ways: `prewarmQuickCardFiles()`
    fires once at boot (scheduled on idle), listing + warming the set
    before the palette is ever opened — so the first search finds files
    already cached rather than parsing on the first keystroke; and the
    open palette re-runs it when its file list loads (with a `keepGoing`
    guard so it bails if the palette closes). Both skip already-fresh
    files and prune rotated-out pins. A dive uses a warm hit when the
    mtime matches, else reads/parses and warms it if pinned. Usage is
    recorded on open + dive (feeds frequents). All renderer-side — no
    main-process store, no parser refactor (see
    reference-docs/SPEC-pinned-files.md).

  - **Cached file index (main process).** `host:list-cmir-files` caches
    the recursive `.cmir` listing — with per-file mtime + size — in
    memory and on disk (`{userData}/cmir-file-index.json`), returning
    instantly and revalidating the tree in the background (coalesced
    per root, rewritten only when it changed). Replaces the per-palette
    directory walk; the stored mtimes set up the future content index's
    reparse-only-what-changed pass. Files now also join the no-prefix
    "search everything" (the scan is kicked off lazily and folded in
    once ready).

- **Fix: palette commands that open a prompt (e.g. New Speech Document)
  did nothing.** The Enter that ran the command bubbled to `document`,
  where the just-opened `promptForText` modal had synchronously
  registered its keydown listener — which caught that same Enter and
  instantly submitted itself with an empty value. The palette's Enter
  now `stopPropagation()`s, so it can't leak into a modal the command
  spawns. (Ribbon buttons were unaffected — a click has no Enter to
  bleed.)

- **Search palette: a settings source (`s` prefix).** The command
  palette gains a fourth source alongside quick cards (`q`), the
  dropzone (`d`), and commands (`c`): settings (`s`), also folded into
  the no-prefix "search everything". `searchSettingsSource` surfaces
  two kinds of rows — the top-level tabs from `CATEGORY_TABS` (opening
  the tab) and every individual setting from `SETTING_METADATA` (opening
  its tab and scrolling to it), ranked by where the query hits the
  label and respecting `electronOnly` so web never offers a row that
  won't render. Selecting a settings row calls a new
  `openSettings(target)` overload; `SettingsModal.open` then activates
  the target tab and `revealSetting` scrolls the row (now tagged with
  `data-setting-key`) into view and runs a one-shot highlight
  animation. Rows carry a `SET` badge.

- **Fix: the save button's icon vanished after the saved-✓ flash.**
  `flashSavedGlyph` swapped the button's `textContent` to `✓` and back,
  which worked when the glyph was text but wiped the new icon `<span>`
  for good once the chrome moved to masked icons. It now snapshots and
  restores the button's inner markup (via a `flashOrigHtml` WeakMap),
  so the floppy-disk icon returns after the flash in both icon modes.

- **Icon system: Untitled UI line icons with a Modern/Classic toggle.**
  The app chrome's glyphs (ribbon buttons, the speech-doc banner,
  dialog close/reset/reorder buttons, status-bar zoom, nav-tree
  chevrons, etc.) were a mix of emoji and Unicode symbols that rendered
  inconsistently across platforms and ignored the theme. They're now a
  single line-icon set drawn from the Untitled UI free icons.
  - **Mechanism.** Each icon is a `<span class="pmd-icon pmd-icon-NAME">`
    painted in `currentColor` via a CSS `mask` whose image is a
    data-URL SVG (so the icon inherits text color and theme for free).
    `scripts/gen-icons.mjs` reads the source SVGs from the gitignored
    `reference-docs/untitled-ui-icons` clone and generates the
    committed `src/editor/icons.css` (the app ships self-contained — no
    SVG files at runtime). The generator's `MAP` pairs each pmd icon
    name with its Untitled UI filename and a classic-fallback glyph.
    `src/editor/icons.ts` exposes `icon(name)` / `setIcon(el, name)` for
    JS-created buttons; static markup uses the span directly.
  - **Toggle.** A new `iconSet: 'modern' | 'classic'` setting (default
    `'modern'`) resolves to a `data-icons` attribute on the document
    root, applied at boot and on change (`applyIconSet` in index.ts,
    alongside the theme/motion appliers). `icons.css` masks the SVG
    under `[data-icons="modern"]`; under `"classic"` it drops the mask
    and renders the original emoji/text glyph via `::before`, releasing
    the fixed 1em box so wide emoji size and center exactly as the old
    text nodes did. The setting lives under Appearance as a two-button
    segmented control parallel to the theme picker.
  - **Licensing.** Untitled UI's free icons are © Untitled UI, used
    under their free license (not MIT, despite the upstream package's
    metadata). Attribution and the license terms are recorded in a new
    `THIRD-PARTY-NOTICES.md`, referenced from `LICENSE` and the README;
    the generator/CSS headers point there too. The upstream `.svg`
    files and the set as a whole stay in the gitignored reference clone
    and are not committed — only the specific glyphs the app uses are
    baked into `icons.css`.

- **Dropzone moved to the editor's bottom-left corner.** It used to be
  pinned at the bottom of the nav pane, where dragging onto it landed
  in the outline list's auto-scroll zone and scrolled the outline.
  Now a SINGLE `DropzoneController` is mounted at boot (index.ts) into
  `document.body`, `position: fixed`, with `positionDropzone()`
  anchoring it to the editor element's live rect — `#app` in
  single-doc (so it tracks nav-width / status-bar / nav-hidden), the
  leftmost visible `.pmd-pane-body` in multi-pane. Repositioned on
  window resize + a `ResizeObserver` on `#app` + after the multi-pane
  shell mounts. `getFocusedView` now resolves via `getActiveView()`.
  Removed the per-nav-panel `installDropzone` (was one pill per
  nav-pane) and the nav-list's bottom-padding reserve.
  - **Scroll runway under the pill.** The pill floats over the editor's
    bottom-left, covering content there with no way to scroll it clear at
    the doc's end. The fix is a fixed `padding-bottom: 4.5rem` on the
    editable (`#editor .ProseMirror`), gated on
    `html:not(.pmd-dropzone-pill-hidden)` (single-doc) — this extends the
    doc content's own height, the same thing that drives `#app`'s scroll
    for any long doc, so the last line scrolls clear of the pill. (Earlier
    attempts — padding the flex item `.pmd-editor-row`, a JS-measured
    `--pmd-dropzone-runway`, and a dedicated spacer flex child of `#app` —
    didn't reliably extend the scroll area; padding the content does.)
  - **Palette gating.** The command palette's dropzone source (`d`
    prefix, its empty-state hint, and inclusion in "search everything")
    now appears only when the dropzone is on (`showDropzonePill`); typing
    `d ` while it's off shows an "it's off" hint instead.

- **Bulk convert utility (desktop).** Home-screen button in its own
  labeled "Convert" group beside the Quick Cards group (shown only when
  `getHost().kind === 'electron'`), opening `bulk-convert-ui.ts`'s
  modal. Two toggles — direction (`.docx`→`.cmir` / reverse) and output
  (loose files vs a single `.zip`) — both written into a chosen
  destination folder. Separate input (file / folder) + destination
  pickers, with the chosen paths shown and a Convert button enabled
  once both are set; changing direction clears the picked input.
  - Conversion (`convertBytes`): docx→cmir = `fromDocxFull` →
    `serializeNative`; cmir→docx = `parseNative` → `toDocx`. Threads
    (comments) preserved.
  - Both output forms write into the destination via `writeFileAtPath`:
    loose files keep the input's relative subfolder structure (swapped
    extension); a zip is written as `<inputName>.zip`. File input uses
    `host.openFile` (scoped to the source ext); folder input is recursed
    via the new `host.listFilesRecursive(dir, ext)`, each file read,
    converted, then written / added to a JSZip; failures counted, not
    fatal.
  - New main IPC + host methods: `host:list-files-recursive` (recursive
    `readdir` by extension) and `host:write-file-at-path` (now mkdir-ps
    the parent so nested + destination writes work).
  - The modal's Escape handler (a capture-phase `document` keydown)
    `stopPropagation()`s so closing the dialog doesn't also reach the
    home screen's bubble-phase keydown and dismiss Home underneath it.

- **Quick Cards — store foundation (no UI yet).** First slice of the
  Quick Cards feature (see `reference-docs/SPEC-quick-cards.md`): a
  persistent, cross-window library of reusable rich-text snippets.
  - `src/editor/quick-cards-store.ts` — dual-backend reactive store
    (`quickCardsStore`) mirroring `dropzone-store.ts` but persistent.
    `QuickCard` shape: id (UUID), name, tags, `contentJson`
    (`Slice.toJSON()`), denormalized search keys
    (`nameLower`/`tagsLower`/`textLower`), `sourceName` provenance,
    created/updated (epoch ms). API: `init` / `list` / `byId` /
    `upsert` / `importMany` / `remove` / `clear` / `subscribe`, plus
    `normalizeTag` + `tagSetKey` helpers for the (forthcoming)
    duplicate-name-only-if-tags-differ rule. Electron backend reads
    main + subscribes to `quick-cards:changed`; web backend uses
    `localStorage` (persists across sessions, unlike the dropzone's
    sessionStorage) + a `storage` listener.
  - Host layer: `quickCardsList/Upsert/BulkUpsert/Remove/Clear` +
    `onQuickCardsChanged` on `ElectronHost` (+ a local `QuickCardIpc`
    type) and the preload bridge.
  - Main process (`apps/desktop/src/main.ts`): authoritative
    `quickCards` array persisted to `{userData}/quick-cards.json`
    (lazy load, atomic tmp→rename writes serialized on a write-tail,
    same discipline as the journal) and broadcast to every window on
    mutation. New IPC: `host:quick-cards-list/upsert/bulk-upsert/
    remove/clear`.
  - Boot: `quickCardsStore.init()` runs at renderer startup so every
    surface reads one cache.

- **Quick Cards — Add surface.** Second slice: capture the current
  selection as a named, tagged quick card.
  - New `addQuickCard` ribbon command (unbound by default; in the new
    "Quick Cards" `RIBBON_GROUPS` entry, so bindable via Settings →
    Keybindings). Registered through the full pipeline (union, ids,
    label, empty default key, `RibbonContext` + stub, `commandFor`).
  - `runAddQuickCard` (index.ts): requires a non-empty selection
    (toast otherwise); pre-fills the name with the **smallest enclosing
    heading** via `smallestEnclosingHeadingText` (nearest preceding
    block → hat → pocket — that nearest heading IS the smallest
    enclosing one); opens the dialog; on confirm builds the card from
    the selection slice (`slice.toJSON()` + plain-text key) and
    `upsert`s it. `sourceName` = the active filename (provenance).
  - `quick-card-add-ui.ts`: promise-based modal (Save As scaffolding)
    with a name field + a tag chip-input (commit on Enter/comma,
    remove via × / Backspace, suggestions drawn from existing tags).
    Enforces the **(name, identical tag-set)** uniqueness rule through
    an inline validator (`findDuplicate`); a name may repeat only if
    its tags differ.
  - Store helpers added: `buildQuickCard`, `distinctTags`,
    `findDuplicate`. CSS: `.pmd-qc-add-*`.

- **Quick Cards — Manage overlay.** Third slice: a full-window
  master/detail surface (`quick-cards-manage-ui.ts`, `quickCardsManageUI`).
  - List (left): every card with name, tags, source file; filter box
    (multi-token substring over name/tags/text), sort (recently
    updated / name / source), per-row checkbox for multi-select →
    bulk Export / Delete.
  - Detail (right): edit name + tags (chip input reusing the Add
    dialog's `.pmd-qc-add-*` classes) and content in an **embedded
    `EditorView`** (shared `schema` + `buildEditorPlugins()`,
    dynamic-imported from index.js to dodge the import cycle). The
    editor is seeded by inserting the stored slice into an empty doc
    (`replaceSelection`, robust for open/inline slices); Save extracts
    it back via `slice.toJSON()` + a trailing-empty-paragraph trim,
    re-checks the (name, tag-set) uniqueness rule (`findDuplicate`,
    excluding self), and `upsert`s. Delete removes.
  - Export (selected or all) / Import via the host file pickers as
    **plain JSON** (`{version,cards}`); import re-mints ids ("import as
    new", never overwrites). No custom extension.
  - Live-syncs from the store while open, but **preserves an
    in-progress edit** — an external library change re-renders the
    list but only rebuilds the detail editor when nothing is unsaved
    (and resets only if the open card was deleted).
  - Entry points: the 🗂️ Manage ribbon button (was a stub) and a new
    **Quick Cards** section on the Home screen (below Recent, above
    the forthcoming Learn section). CSS: `.pmd-qc-manage-*`.
  - Known v1 limitation: the embedded editor uses base ProseMirror
    styling (it's not under `#editor`, so per-style size/font
    variables don't cascade) — content is fully editable, just not a
    pixel match for the main editor.
  - Re-entrancy fix: every Electron mutation fires the store
    subscription twice (optimistic + main broadcast echo); with the
    detail's editor mount being async (dynamic import), two renders
    interleaved and double-appended the footer (and left stale DOM).
    `renderDetail` now appends all DOM (incl. footer) synchronously and
    guards the async editor mount with a `renderSeq` token, so stale
    mounts are discarded.
  - The Add dialog now offers **"Open it"** on a duplicate (same name +
    identical tags): `openQuickCardAdd` takes `findConflict` +
    `onOpenConflict`, the latter opening the Manage overlay at that card
    (`quickCardsManageUI.open({ selectId })`).
  - Ribbon: a 2×2 Quick Cards cluster (`#quickcards-stack`) between the
    speech stack and the formatting panel, shown in both single- and
    multi-doc (unlike the speech stack). Buttons: 🔍 Search · 🏷️ Tag
    Picker (top), 🗂️ Manage · ➕ Add (bottom). `mousedown`
    preventDefault on all four preserves the editor selection. CSS
    `.ribbon-quickcards-stack` mirrors the speech stack.

- **Quick Cards — Search palette + Tag Picker (feature complete).**
  - `quick-cards-match.ts`: pure Block-Search matcher
    (`searchQuickCards`) — order-independent multi-token substring AND,
    scoped by the active-tags filter (`isInScope`: empty filter = all;
    else ≥1 active tag; untagged always in scope), two-tier (name
    matches, then content-only matches with a ~40-char snippet of the
    matched region). Name tier ordered by first-token position then
    recency; content tier by recency.
  - `quick-card-search-ui.ts`: the floating palette (`quickCardSearchUI`)
    — centered over the target pane, pinned bottom, results ABOVE the
    bar; input focused synchronously; one-shot blue pulse
    (`pmd-qcs-pulse`, auto-suppressed by the reduce-motion rule);
    live search; ↑/↓ nav, Enter = insert at cursor, Alt+Enter = at
    end, Tab = inline tag filter, Esc/click-away to close; keyboard
    hints footer; no-editable-target → toast, no insert. Insert
    reuses `insertSpeechSlice` with the new mid-text-confirm option
    gated on `quickCardSkipMidTextInsertConfirm`. Also exports
    `openQuickCardTagPicker` (the ribbon 🏷️ dropdown) — both it and
    the inline Tab filter edit the global `quickCardActiveTags` setting.
  - `insertSpeechSlice` gained a 5th `midTextConfirm: { enabled,
    message? }` param (defaults preserve speech-doc behavior).
  - Command `openQuickCardSearch` (`Mod-Shift-Space`), registered +
    view-less (opens browse-only with no doc). 🔍 and 🏷️ ribbon
    buttons wired (were stubs); ➕ Add unchanged.
  - Settings: `quickCardActiveTags` (the global tag filter; edited via
    the Tag Picker, not a settings row) and
    `quickCardSkipMidTextInsertConfirm` (Editing tab, default off).
  - Prefix system (first slice of the eventual full set): `parsePrefix`
    splits a leading `q `/`d `/`c ` off the query. `q ` searches quick
    cards, `d ` the dropzone, `c ` **commands** (`searchCommandSource`
    — multi-token substring over `RIBBON_COMMAND_LABELS`, showing the
    command's current keybinding; activating runs it via the new
    `runRibbonCommandById` passed in as `opts.runCommand`, which is
    view-less-aware). No prefix searches EVERYTHING (cards + dropzone +
    commands) but shows nothing until the user types. Results are a
    unified `PaletteResult` (source badge QC/DZ/CMD); quickcard/dropzone
    insert their `sliceJson`, commands run their `commandId`.
  - Re-triggering the open hotkey while open toggles the palette
    closed. The bar sits higher (`bottom: 6rem`) and its width clamps
    to the target pane (`min(540, paneWidth − 24)`, floor 240) so it
    shrinks gracefully in narrow / multi-pane windows; hints wrap.
  - The tag picker (inline + ribbon popover) is keyboard-navigable:
    auto-selects the best match, ↑/↓ move, Enter toggles, Tab /
    Shift-Tab / Esc return to the query.

- **Select Current Heading / Copy Current Heading commands.** Two new
  ribbon commands (`selectCurrentHeading`, `copyCurrentHeading`) that
  reuse the send-to-speech / send-to-dropzone cursor→bounds logic.
  Refactored that logic in `speech-doc-send.ts` into a shared
  `enclosingStructureRange(doc, $pos)` (the enclosing `card` /
  `analytic_unit` / heading + everything up to the next
  equal-or-shallower heading), with two callers:
  `resolveSendRange` (selection if non-empty, else the enclosing
  structure — unchanged send-to-* behavior; `resolveSendSlice` slices
  over it) and `resolveCursorStructureRange` (always the cursor's
  structure, **ignoring any selection**, keyed off `selection.$head`).
  Select/copy use the latter — a pre-existing selection is irrelevant
  to them (re-selecting it is a no-op, and Ctrl+C copies it). Select
  dispatches a `TextSelection.between(from, to)` (+ `scrollIntoView`,
  refocus); Copy serializes the range's slice to HTML + plain text and
  writes the clipboard without disturbing the selection (same
  serialization the nav pane's copy-heading uses). Source-only
  operations on the focused `view`, so no multi-doc routing. Registered
  through the full pipeline (id union, `RIBBON_COMMAND_IDS`, labels,
  `DEFAULT_RIBBON_KEYS` empty = unbound, `RibbonContext` + stub,
  `commandFor`, `RIBBON_GROUPS` "Editing utilities"); rebindable via
  Settings → Keybindings.

- **Fixed: large `.docx` files failing to import with "Entity
  expansion limit exceeded: N > 1000".** `src/ooxml/parse.ts`
  configures `fast-xml-parser`, whose entity-expansion guard (added
  in the 4.5.x security hardening) defaults to
  `maxTotalExpansions: 1000`. That counter increments per match for
  *every* entity replaced — including the standard XML entities
  (`&amp; &lt; &gt; &quot; &apos;`) — cumulatively across the whole
  `document.xml`, reset only per parse. Large debate docs blow past
  1000 standard entities easily, so the parse threw before the
  importer ever ran (no ProseMirror involvement — this is upstream
  of the editor entirely). Fix: pass `processEntities` as an object
  with `maxTotalExpansions: Infinity` / `maxExpandedLength: Infinity`.
  Safe because (a) standard entities and numeric char-refs are 1:1,
  non-recursive — no exponential blow-up — and (b) the real
  billion-laughs vector is DOCTYPE-declared nested custom entities,
  which OOXML never emits (and the depth / size / count guards for
  those remain at their defaults). We also only ever open trusted
  local files.

- **Save As dialog reorganized around presets.** The dialog body
  now reads top-to-bottom: a **Name** section
  (`buildFileNameSection`) → a **Format** section
  (`buildFormatSection`) → a **Save** heading → preset buttons → a
  divider → the **Custom Save** section → a divider → Cancel
  (right-aligned).

  - Three presets — a three-column grid (`.pmd-save-as-presets`),
    each cell (`.pmd-save-as-preset`) a primary (blue) button
    (`.pmd-save-as-preset-btn`) over a caption
    (`.pmd-save-as-preset-sub`) — each call `confirmWith(opts)` with
    a fixed content configuration and save immediately using the
    name + format above: **As-Is**
    `{comments:true, analytics:true, undertags:true}`, **Send Doc**
    `{comments:false, analytics:false, undertags:false}`, **Read
    Doc** `{…false, readMode:true}`.
  - The previous read-mode checkbox (and its mutual-exclusivity
    logic that disabled the other boxes when checked) is removed;
    `readModeBox` is gone. Read-mode export is now reachable only
    via the Save Read Doc preset.
  - The Custom Save section keeps the comments / analytics /
    undertags checkboxes and gains a left-aligned **Save Custom**
    submit button (`.pmd-save-as-custom-save`) directly below them;
    the form's submit handler routes through `confirmWith` with the
    live checkbox state and `readMode:false`.
  - `SaveAsResult` is unchanged, so the save pipeline downstream
    needed no edits — only how the four flags get chosen.
  - Preset filename prefixes: the Send Doc / Read Doc presets pass a
    `SEND_` / `READ_` prefix to `confirmWith(opts, prefix)`, which
    prepends it to the (extension-normalized) file name when the new
    `prefixPresetSaveFilenames` setting is on (default; General tab).
    As-Is and the Save Custom submit pass no prefix. The prefix lands
    in `SaveAsResult.filename` like any other name, so nothing
    downstream special-cases it.
  - Derived exports don't rebind the working doc's identity:
    `runSaveAsFlow` now computes `isFullSave = includeComments &&
    includeAnalytics && includeUndertags && !readMode`. Only a full
    save calls `commitSaveResult` (name/handle/format adopt) +
    `markCurrentDocClean` + `multiDocNotifyFocusedSaved` +
    `clearJournalForActiveDoc`. A content-dropping save (Send/Read
    presets, partial Custom) instead just `recordRecent`s the
    exported file and leaves the working doc's name, dirty flag, and
    journal intact — fixing the bug where the open doc adopted the
    `SEND_`/`READ_` name and the duplicate-open guard then refused to
    reopen the export. The crash-recovery Save-As path
    (`reserializeJournalAs`) was already full-fidelity-only and
    doesn't rebind identity, so it's unaffected.

- **Home / start screen (single-doc mode).** A full-window hub
  shown on launch-with-no-file, on closing the current doc
  (Ctrl+W), and via a new Home button (🏠) at the left of the
  ribbon. Offers New document / New speech document / Open and a
  recently-opened-files list.

  Architecture:
  - `home-screen.ts` — the overlay view. Toggled via the
    `pmd-home-active` class on documentElement, which CSS uses to
    hide the ribbon / nav / editor / status bar and reveal
    `.pmd-home-screen`. The editor stays mounted underneath
    (home is an overlay, not a separate route), so showing /
    hiding is a pure visibility flip. When opened over a live
    doc (Home button) a "Back to document" affordance + Esc
    dismiss it; on launch / close-doc there's a fresh blank
    behind it and no back affordance.
  - `recents-store.ts` — localStorage-backed recent-files list
    (newest first, capped at 12, de-duped by path). Persists
    across restarts; shared across same-session Electron windows.
    Each entry stores the path handle (a string on Electron),
    filename, format, timestamp. Recorded on every in-place
    open and on save (so Save-As of a new doc registers it).
  - New `host:read-file-at-path` IPC (+ preload + electron-host
    wrappers) reads a file at a known path without a picker, for
    the "open recent" flow. Returns null on missing / unreadable
    so the home screen prunes the stale entry.
  - `index.ts` wiring: home actions load IN-PLACE (this window),
    distinct from the ribbon's New/Open which spawn windows.
    `loadFileInPlace`, `pickAndLoadInPlace`, `openRecentInPlace`,
    `createSpeechDocInPlace`, and `mountFreshBlankDoc` share the
    mount + state-reset + recents-record + home-hide steps.
    `initSingleDocBoot` shows home (over the blank starter) when
    it's the first window with no file; recovery + open + the
    spawn-payload path all hide home when they mount real content.
  - Close behavior: the `closeDocOrWindow` command (Ctrl+W) in
    single-doc now routes to `handleCloseDocToHome` — confirm
    unsaved, then mount a fresh blank + show home — instead of
    closing the window. The OS close button (`onCloseRequest`)
    still calls `handleUserCloseRequest` and actually closes, so
    quitting is unaffected; Ctrl+W from home (no doc) also falls
    through to the real close.
  - Web: recents render but `handle` is null (FileSystemFileHandle
    isn't JSON-serializable), so those rows are disabled with a
    tooltip. A future pass could persist handles via IndexedDB.

- **Formatting panel grid columns now share equal width.**
  `.ribbon-formatting-panel` had `grid-template-columns:
  repeat(3, auto)`, which sized each column to its widest
  occupant. With column-major DOM order
  (Pocket-Tag / Hat-Block / Analytic-Undertag), the three
  columns ended up roughly 56px / 49px / 70px wide. When
  style-preview was off (every button has the same 1px gray
  border), the eye picked up the column-width asymmetry as
  inconsistent gaps even though the CSS column-gap was a
  uniform 3px throughout. (Style-preview on hides the
  asymmetry visually by giving Pocket a heavy colored border
  that dominates the eye's reference points.)

  Fix: switch to `repeat(3, 1fr)` — equal-width columns sized
  to the widest occupant's max-content. All buttons now sit at
  the same width, so Pocket → Hat and Hat → Analytic
  center-to-center distances are identical regardless of
  `formattingPanelMode` (labels / shortcuts / both) or
  `formattingPanelPreview`.

- **Ribbon panel column gaps normalized to 3px across the
  board.** An audit found two outliers among the ~10 ribbon
  panels: `.ribbon-color-panel` used `gap: 2px 4px` (claimed
  intentional for split-button readability) and
  `.ribbon-format-menu-panel` used a uniform `gap: 2px`, while
  every other panel used `gap: 2px 3px`. Both are now `gap: 2px
  3px` so adjacent buttons sit at the same visual rhythm
  regardless of which panel they live in. Row gaps were
  already a uniform 2px and are unchanged. The ribbon overflow
  buffer (which measures `column-gap` from a sample panel)
  picks up the new value automatically.

- **Application menu bar restructured + accelerators tracked
  to live keybindings.** `buildMenu()` in `apps/desktop/src/main.ts`
  used to emit a static template with hardcoded `CmdOrCtrl+O`,
  `CmdOrCtrl+S`, etc. The Help menu had three diagnostics-only
  entries; the Window menu was Electron's default `role:
  'windowMenu'`; the View menu's Zoom In / Out / Reset used
  Electron's native `role: 'zoomIn'` etc., which triggered
  Chromium's page-zoom rather than CardMirror's `chromeScale*`
  ribbon commands. The File menu's New Document carried a
  hardcoded `CmdOrCtrl+Alt+N` even though the ribbon command's
  default key is `Mod-n` on Electron.

  Restructure:
  - File → Open, New, Save, Save As, separator, Toggle
    Autosave, separator, Close, Quit (Linux / Windows only).
  - New **Speech** submenu between File and Edit: New Speech
    Document, Mark / Unmark Active as Speech Doc, separator,
    Send to Speech (At Cursor), Send to Speech (At End),
    separator, Select Speech Doc….
  - Edit: explicit submenu instead of `role: 'editMenu'` so we
    can override Redo's accelerator to `CmdOrCtrl+Y` (Electron's
    default is `CmdOrCtrl+Shift+Z`). Both chords still fire
    redo via the renderer's `keymap({ 'Mod-y': redo, 'Mod-Shift-z':
    redo })`.
  - View: reload / forceReload / toggleDevTools kept; the three
    Zoom items now dispatch our `chromeScaleReset / Up / Down`
    ribbon commands with accelerators sourced from the
    renderer-pushed binding map; togglefullscreen kept.
  - Window: removed entirely.
  - Help: Settings, Keyboard Shortcuts, separator, Check for
    Updates, Open Crash Dumps Folder, Copy GPU Info.

  Accelerator sync: new `host:set-menu-bindings` IPC. Renderer
  collects `primaryKeyFor(id, ribbonKeyOverrides)` for every
  menu-bound command in a `NATIVE_MENU_COMMANDS` array and pushes
  the map after every settings change (alongside applyBodyFont /
  applyUiFont in applyAll). Main stores the map in a
  `menuBindings: Record<string, string | null>` module variable
  and re-runs `Menu.setApplicationMenu(buildMenu())`. The
  template helper `menuAccelerator(commandId)` converts the
  PM-keymap string ("Mod-o", "Shift-Mod-s", "Ctrl-ArrowLeft")
  to Electron's accelerator form ("CmdOrCtrl+O",
  "Shift+CmdOrCtrl+S", "Ctrl+Left") via the new
  `pmKeyToAccelerator(key)` translator.

  Menu-command routing: the renderer's `onMenuCommand` switch
  in `index.ts` learned a default branch that runs any
  recognized `RibbonCommandId` through `runRibbon(...)`. Means
  the Speech / View / Help / Toggle-Autosave menu items don't
  need bespoke cases — they all flow through the same single
  implementation as ribbon-button clicks and keyboard shortcuts.

- **Select Speech Doc modal.** New
  `src/editor/select-speech-doc-ui.ts` opens a centered overlay
  that lists every open document across every CardMirror
  window. Each row shows the filename (or "Untitled"), the
  owning window's title (or "this window" when in the caller's
  own window), and a "current speech doc" tag with a microphone
  glyph when applicable. Clicking a row that's NOT the current
  speech doc calls `host.speechSet(uid)`; clicking the current
  speech doc clears it (`speechSet(null)`). Both paths close
  the modal. A dedicated "Clear speech doc designation" footer
  button surfaces the unset path more discoverably (greyed out
  when no speech doc is set). Esc and click-outside close.

  Cross-window data path:
  - New `host:doc-info-update(uid, info)` IPC — renderer pushes
    `{ filename }` for a registered uid. Called from
    `updateWindowTitle` (single-doc) and from
    `setFocusedFilename` / `setFocusedFile` plus the
    `registerView` site (multi-pane shell), so the map stays
    fresh as docs mount, save, save-as, rename.
  - New `host:list-docs()` IPC — returns every entry in the
    main-process `docOwners` map, enriched with the cached
    filename, the owning window's id + title, whether it's the
    current speech doc, and convenience flags for "is this the
    caller's own window" / "is its window focused."
  - Existing `host:speech-set` / `speech:changed` infrastructure
    drives the actual designation flip. The modal doesn't
    refocus the picked doc's window — picking is a designation-
    only operation per the user spec.

  Theming: `--pmd-c-speech-bg / -border / -text` tokens drive
  the header and the current-speech-doc row so the gold theming
  stays consistent with the speech banner and other speech-
  flavored UI elements.

  Command wiring: new `selectSpeechDoc` ribbon command (added
  to RibbonCommandId, RIBBON_COMMAND_IDS, RIBBON_COMMAND_LABELS,
  DEFAULT_RIBBON_KEYS with empty default, RibbonContext, and
  the ribbon-groups Speech section). `commandFor` routes it
  through `ctx.selectSpeechDoc()`; `index.ts` binds that to
  `openSelectSpeechDocModal()`.

- **Dropzone shelf — cross-window scratch space for dragged
  content.** Floating bubble pinned to the bottom of every nav
  pane; absorbs any drag from the existing `drag-controller`
  (nav-pane headings, editor surface card/analytic drags) and
  exposes the absorbed items via a click-to-open popover where
  each row is draggable back out into the editor or nav pane.
  Items are shared across every CardMirror window in the same
  session.

  Architecture:
  - **Store** (`src/editor/dropzone-store.ts`) — backend-agnostic
    cross-window state. In Electron, mutations flow through new
    `host:dropzone-{list,add,remove,clear}` IPCs; main holds the
    list in a module variable and broadcasts `dropzone:changed`
    on every change. In web, the store falls back to
    `sessionStorage` (single-window but survives the in-tab
    reload that the multi-pane mode toggle triggers).
  - **Drag-controller extension** (`drag-controller.ts`) —
    `DragItem.prebuilt?: Slice` lets a session carry a slice
    that wasn't sliced from any view's doc; `DragSession.virtual`
    marks the session as having no real source location; new
    `DropTarget.absorb?` callback lets a surface act as a shelf-
    style sink instead of inserting into a view. `commit()`
    routes through `absorb` first when present, falls through to
    the standard cross-view insert path otherwise.
  - **UI** (`src/editor/dropzone-ui.ts`) — one
    `DropzoneController` per nav-pane (so each multi-pane slot
    has its own bubble; they all share state via the store).
    Registers a `DragSurface` whose hitTest returns the bubble's
    bounding rect and whose `absorb` extracts each session
    item's slice (or uses `item.prebuilt` for virtual sessions),
    derives a label, and pushes to the store. The popover's
    rows watch pointerdown + threshold-crossing pointermove to
    start a `virtual` drag session via
    `dragController.begin({...virtual: true})`; the existing
    controller pipeline routes the drop through the normal
    surfaces.
  - **Styling** uses `--pmd-c-drop`, `--pmd-c-drop-outline`,
    `--pmd-c-drop-tint` — the same blue accent the nav drop
    indicator and editor drop indicator use — so the
    accept-state highlight matches the rest of the drag UI.
    Resting state is a muted grey bubble with the
    `--pmd-c-surface-soft` / `--pmd-c-border-soft` tokens to
    blend into the nav-pane chrome.

  Notes:
  - When the nav pane is hidden via `toggleNavPane`, the bubble
    hides with it — accessible again by re-showing the nav.
  - Drag-out always copies (the source isn't a real view
    location), regardless of whether the user holds the
    copy modifier.
  - Drag-out targeting: the virtual `DragItem`'s level is derived from
    the item's stored `type` (`dropzoneDragLevel`: headings via
    `TYPE_TO_LEVEL`; card / analytic_unit at tag level 4; generic content
    anywhere at 4), so the editor / nav surfaces gate drop indicators the
    same way the native drag does — a block lands only at pocket/hat/block
    boundaries, not inside another block. (At the earlier `level: 0` the
    surfaces gated *all* indicators out, so the drag had no target and
    appeared to vanish; a blanket `level: 4` fixed that but wrongly let a
    block drop inside another block.) The shelf's own `hitTest` returns
    null while a `virtual` session is active, so dropping a shelf item
    back onto the shelf is a no-op rather than duplicating it. (Indicators
    are heading-based, so a doc with no headings only offers the doc-end
    target — click-to-insert still covers that case.)
  - No drag-out-to-other-app yet; the controller's surfaces
    only know about nav-pane and editor-surface drops.

- **Ribbon tooltip system unified behind a controller +
  `ribbonTooltipMode` setting.** Previously, ribbon button
  tooltips were a patchwork: the formatting / cite panel buttons
  re-derived their title from `primaryKeyFor` in
  `applyFormattingPanel` (so they tracked rebinds), the autosave
  and plain-paste buttons set their titles imperatively with the
  shortcut hardcoded into the string, and most other ribbon
  buttons had a static `title="..."` in `index.html` that never
  updated. Dropdown menu items (Doc / Card / Table) had no
  tooltips at all.

  New `src/editor/ribbon-tooltips.ts` exports a
  `registerRibbonTooltip({ el, commandId?, label?, kind? })`
  function. The controller stores targets in an array; every
  call to `reapplyAllRibbonTooltips()` walks the array and
  recomputes each title from
  `(settings.ribbonTooltipMode, settings.ribbonKeyOverrides)`.
  Compose rules:

  | mode       | button                        | menu item        |
  | ---------- | ----------------------------- | ---------------- |
  | `none`     | (no title)                    | (no title)       |
  | `tooltip`  | `Label`                       | (no title)       |
  | `shortcut` | `Shortcut` or empty           | `Shortcut` or empty |
  | `both`     | `Label (Shortcut)` or `Label` | `Shortcut` or empty |

  Menu items never repeat their visible menu-row label; only
  the current shortcut shows up on hover (per user spec).

  Wiring: `index.ts` registers every top-level ribbon button by
  id in one block near the end of init, using
  `RIBBON_COMMAND_LABELS` + the command id to derive the label
  by default and an optional explicit label override for state-
  aware buttons (autosave, plain-paste explainer). The
  formatting-panel loop registers its 10 buttons inline.
  `doc-menu-ui.ts` accepts an optional `commandId` field on
  `DocMenuItem` and registers each matching menu button with
  `kind: 'menuItem'`; the close path unregisters them so the
  controller's array doesn't accumulate stale refs across
  many open / close cycles. `applyFormattingPanel` keeps
  ownership of the visible textContent (label vs shortcut vs
  both, driven by `formattingPanelMode`), but no longer sets
  `title` — the controller handles that. Same for the autosave
  and plain-paste state callbacks (they call
  `registerRibbonTooltip` with the updated state-derived
  label).

  Subscriber hookup: `reapplyAllRibbonTooltips()` is called
  from the settings subscriber's `applyAll` so any change to
  `ribbonTooltipMode` or `ribbonKeyOverrides` flows through
  every registered target in one pass.

  Setting metadata: `ribbonTooltipMode` lives at the top of
  Appearance with `kind: 'ribbonTooltipMode'`, a new
  `buildRibbonTooltipModeEditor` in `settings-ui.ts` (a plain
  `<select>` with four options, default `both`), and
  `sanitizeRibbonTooltipMode` in `settings.ts` to validate
  persisted values.

- **UI font is now configurable via Settings → Accessibility →
  "Interface font."** The chrome was previously pinned to
  `'Calibri', 'Helvetica Neue', sans-serif` in every surface that
  used a font-family override (`body`, plus ~14 redundant
  restatements across `.pmd-settings-dialog`, `.pmd-nav-panel`,
  `.pmd-comments-column`, `.pmd-ai-cite-tooltip`,
  `.pmd-prompt-dialog`, `.pmd-clod-dialog`, `.pmd-recovery-sidebar`,
  `.pmd-save-as-dialog`, `.pmd-reference-dialog`,
  `.pmd-doc-switcher`, `.pmd-timer-panel`, `.pmd-doc-menu`,
  `.pmd-nav-context-menu`, `.pmd-nav-pickup-pill`,
  `#ribbon .formatting-panel-btn`).

  Refactor:
  1. New `--pmd-ui-font` CSS variable on `:root` defaulting to a
     platform system-UI stack (`-apple-system, BlinkMacSystemFont,
     'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`).
  2. Every Calibri-stack `font-family` declaration in `style.css`
     swapped for `var(--pmd-ui-font)`. The font-color glyph
     (`#fontcolor-glyph`'s `'Calibri', serif`) and the four
     monospace stacks (keybinding chips, delimiter samples, code
     blocks, AI prompt) are left alone — those are intentional
     per-element design choices.
  3. New `uiFont` setting (string; `''` = use the CSS default,
     non-empty = override) added to the `Settings` interface with
     `kind: 'uiFont'` and category `accessibility`.
     `sanitizeUiFont` mirrors `sanitizeBodyFont`'s quote / comma
     stripping but allows empty.
  4. `applyUiFont(font)` in `index.ts`: empty value removes the
     inline override on `documentElement` (CSS default applies);
     non-empty sets `--pmd-ui-font` to `"<font>", sans-serif`
     (quoted unless `font` is one of the generic keywords).
     Mirrors `applyBodyFont`'s shape; called from both the
     settings subscriber and the initial-load pass.
  5. New `buildUiFontEditor` in `settings-ui.ts` reuses
     `FONT_GROUPS` and `isFontAvailable` but prepends a "System
     default" sentinel option that resolves to `''`.

- **Settings dialog tab strip now scrolls behind arrow buttons
  instead of overflowing the dialog.** The previous
  `.pmd-settings-tabs` was a plain flex row with no overflow
  handling — labels just spilled past the dialog's right edge
  when the dialog was narrower than the strip's natural width.

  New shape: wrap the existing `<nav class="pmd-settings-tabs">`
  in a `.pmd-settings-tabs-bar` flex container that also holds
  left and right `.pmd-settings-tabs-scroll` arrow buttons.
  The nav itself is `flex: 1 1 auto; min-width: 0; overflow-x:
  hidden; scroll-behavior: smooth` — no native scrollbar, only
  the JS-driven arrows scroll it. The border-bottom and
  horizontal padding moved from the nav to the bar so the
  active-tab border overlay still works and the arrows sit
  flush against the divider line.

  Arrow visibility is driven by a per-render `ResizeObserver`
  on the nav: when `nav.scrollWidth > nav.clientWidth + 1`,
  both arrows show; otherwise both hide via `[hidden]`. Each
  arrow's `disabled` flag toggles based on `nav.scrollLeft`
  (left at 0, right at end). A scroll-event listener on the
  nav re-runs the same updater so the disabled state stays in
  sync as the user scrolls. Click handler calls `scrollBy(±step,
  smooth)` where step is `max(60, clientWidth * 0.6)` — about
  half the visible width, with a 60px floor so it still
  advances at very narrow widths. Observer is held on the
  modal instance and disconnected in `close()` and on each
  new `render()`.

- **Ribbon resizer reserves a column-gap-sized buffer before the
  overflow trigger fires.** `initRibbonResizer` in `index.ts`
  previously used `scrollWidth > clientWidth + 1` as its overflow
  predicate, hiding a panel only after the ribbon's content had
  literally exceeded its available width. The visible artifact:
  just before the next panel hid, the rightmost panel button
  collided with the right-pinned timer button (no visible gap).

  Naïvely subtracting a buffer from `clientWidth` in that
  predicate doesn't work — `.ribbon-center` is `flex: 1 1 auto`,
  so when the ribbon isn't actually overflowing the center grows
  to fill remaining space and `scrollWidth === clientWidth`. The
  buffered predicate would therefore fire unconditionally and
  hide every panel.

  Instead, measure the actual visual gap: take
  `ribbon-right.left − ribbon-left.right`, subtract any visible
  center-section content (the doc-name chip, when shown), and
  trigger when that remaining free space drops below the buffer.
  The buffer itself is read once at init from a sample panel's
  computed `column-gap` (cite-panel / formatting-panel / color-
  panel — all use 3-4px gaps; fallback 4). The un-hide branch
  uses the same predicate, so the trigger is symmetric — panels
  wait one extra gap of growing room before reappearing,
  preventing flicker right at the threshold.

- **Layer 3 trailing-space trim no longer eats a whitespace-only
  selection.** The `trimRangesForFormatting` in
  `ribbon-commands.ts` used to shave one trailing space from
  every range whose last char was a space, regardless of what
  else was in the range. For an explicitly-selected single space
  (or any whitespace-only run), the shave produced an empty
  range and F9 / F10 / F11 / cite / underline / shading all
  no-op'd silently — there was no way to format a deliberately-
  selected trailing space.

  New rule (the spec calls it Rule 3): trim the trailing space
  iff `[from, to - 1]` contains at least one non-space text
  character. Monotonic — when there's word content, exactly one
  trailing space is always shaved; when the range is whitespace
  only, nothing is shaved. New `hasNonSpaceChar(doc, from, to)`
  helper walks text leaves between the positions and short-
  circuits on the first non-space char (per `classifyChar` from
  `word-break.ts`). Considered Rule 2 ("trim iff the char at
  `to - 2` isn't a space"), which lets the user deliberately
  format multi-trailing-space tails after a word — rejected for
  the surprising toggle (adding one more trailing space to your
  selection flips whether the others get formatted). Rule 3 is
  predictable; the rare multi-trailing-space case can be worked
  around by selecting one char past the spaces or by selecting
  just the spaces.

- **AI cite creator now guarantees the cite stands alone in its
  own paragraph.** Refactor of `applyCiteToSelection` in
  `ai/cite-creator.ts` into a (testable) `buildCiteTransaction`
  helper. The existing pipeline still runs first — `tr.insertText`
  to replace the selection, `tr.removeMark` to strip inherited
  boundary marks, per-token `tr.addMark` to apply `cite_mark` to
  the leading "Lastname Date" pieces. After that, two new
  defensive splits: if the surrounding textblock has inline
  content AFTER the cite end (the common bug case — selection
  spanned a paragraph break and the trailing text from the last
  selected paragraph is now joined onto the cite), `tr.split(end)`
  to break out the tail. Symmetric `tr.split(start)` when there's
  pre-cite content in the same textblock. The after-split runs
  first so the start position doesn't need remapping. Both
  wrapped in try/catch — schema-illegal splits (e.g., a second
  tag inside one card) fall back to the inline-cite shape rather
  than crashing. `applyCiteToSelection` now just calls the
  builder and dispatches.

- **Highlight Acronym (Alt+F11) added; Emphasize Acronym
  rebound from Ctrl+F10 to Alt+F10.** New
  `highlightAcronym(activeColor)` in `ribbon-commands.ts`
  mirrors `emphasizeAcronym`'s per-word-first-letter walk: for
  each textblock the selection touches, build a word-class map
  (`isWordChar` from `word-break.ts`), expand the selection
  range to whole-word boundaries, then emit the start position
  of each word inside that expanded range. The selection-expand
  rule and word definition are identical to Emphasize Acronym
  (so `U.S.A.` is three words per the spec, and the command
  marks `U`, `S`, `A` individually).

  Two deliberate deviations from Emphasize Acronym, parallel to
  the differences between `applyHighlight` and `applyEmphasis`:
  (1) no `NAMED_STYLE_SKIP_BLOCKS` gate — highlight is allowed
  in structural textblocks (tags, analytics, pockets, hat,
  block, undertag), matching the F11 toggle's reach; (2) no
  `stripDirectFormattingOnApply` — highlight is additive and
  shouldn't change the marked character's other formatting. The
  apply uses `tr.removeMark(...highlight) + tr.addMark(...
  highlight.create({color}))` per first-letter slot so a new
  active color wins over any existing highlight on those slots
  (parallel to `applyHighlight`'s apply-branch behavior).

  Bindings: `Mod-F10` → `Alt-F10` for Emphasize Acronym, plus
  new `Alt-F11` → Highlight Acronym in `DEFAULT_RIBBON_KEYS`.
  Both stay rebindable via Settings → Keybindings. The Ctrl-F10
  rebinding choice keeps Mod-F10 (which on Win/Linux is
  Ctrl-F10) available for future use; symmetric to Mod-F11
  (Ctrl-F11, Apply Shading) and F11 (Apply Highlight) already
  occupying the highlight column. `ribbon-groups.ts` lists
  Highlight Acronym next to Apply Highlight in the Character
  Styles group so the settings UI surfaces it near its
  conceptual sibling.

- **Viewport-rockets-to-doc-end on paste / F7 fixed by
  changing the absorb-plugin from a wholesale doc replace to
  per-region surgical edits.** Two community reports surfaced
  the same underlying bug: (1) Cumdog: pasting multi-line text
  with an F7-styled tag somewhere above sends the cursor to the
  very end of the doc; (2) Buntin: pressing F7 on a paragraph
  that has any doc-level paragraphs below it does the same.
  Both reduce to the same root cause — the card-body
  absorption rule (an `appendTransaction` plugin that absorbs
  doc-level paragraphs / cite_paragraphs / undertags after a
  card or analytic_unit) was doing the rewrite in a single
  `tr.replaceWith(0, doc.content.size, rebuilt)`. PM's default
  selection mapping treats the deleted range as fully replaced
  and pushes the cursor (with association-right) to the END of
  the inserted content, which for the absorb tr is the end of
  the last absorbed orphan-now-card-body.

  The new shape: walk the doc to find each contiguous
  absorption region (a `card` / `analytic_unit` followed by
  one or more absorbable doc-level siblings), then for each
  region, in a single transaction, perform two surgical steps
  right-to-left so position arithmetic stays valid: (a)
  `tr.insert(cardContentEnd, absorbedBodiesFragment)` to put
  the new bodies inside the card just before its closing
  boundary, and (b) `tr.delete(orphansStart + insertedSize,
  orphansEnd + insertedSize)` to remove the originals from doc
  level. The cursor (typically NOT inside the moved orphans —
  it's in the absorbing card's tag, or somewhere unrelated)
  stays exactly where it was. The existing
  `absorbedDocChildren` helper is retained for tests that
  probe absorb behavior directly. New `findAbsorbRegions`
  function returns the per-region `{ absorbingPos,
  absorbingNodeSize, orphansStart, orphansEnd, bodiesContent }`
  shape that the new appendTransaction consumes.

- **Phantom-empty-tag card on multi-paragraph paste fixed by
  pre-fitting the slice in the paste handler.** Pasting two or
  more paragraphs into a `card_body` that has sibling
  `card_body`s used to bubble PM's slice fit up to the card
  level: the original card split into two cards with the
  second one carrying an empty `tag` and the original
  trailing card_bodies absorbed into it. Root cause: PM's
  `replace`-with-slice fitting can't insert a multi-paragraph
  slice into a `card_body` (whose content rule is `inline*`)
  without splitting, so it lifts the split up until the slice
  fits as siblings — which at the card level requires opening
  a new card, which requires a tag (= empty placeholder tag).

  New `tryPasteAsCardBodies(state, slice)` in
  `paste-plugin.ts` runs after the existing head-detection
  branch in `handlePaste`. When the slice is 2+ top-level
  paragraphs and the cursor's parent is a `card_body` inside
  a `card` or `analytic_unit`, it converts each paragraph into
  a `card_body` of the same content (preserving inline marks)
  and dispatches the replace with the new slice. The cursor's
  containing card now naturally accepts multiple `card_body`s
  as siblings, so the split stays inside the card.
  `openStart` / `openEnd` carry through from the original
  slice so the first body still joins inline with the
  pre-cursor text and the last body still joins inline with
  the post-cursor text — same UX as a single-paragraph paste,
  just with the multi-line break preserved at the card_body
  boundary. Falls through to PM's default for single-paragraph
  slices, slices with non-paragraph top-level children
  (carries / wholesale-card pastes go through the existing
  head-detection branch), and cursors outside the card_body
  context.

- **Copy Last Cite at offset 0 of a paragraph now inserts the
  cite BEFORE that paragraph instead of after.** Community
  report (Cumdog): in a multi-paragraph card with a tag but no
  cite, putting the cursor at the start of the card and
  pressing the Copy Last Cite hotkey lands the cite at the
  start of the SECOND body, not between the tag and the first
  body. Cursor at the END of the tag worked correctly. Root
  cause was in `computeCitePasteLocation` in
  `ribbon-commands.ts`: outside the empty-paragraph branch the
  code always returned `$from.after(paraDepth)` — the position
  AFTER the cursor's containing paragraph. For a cursor at
  offset 0 of the first body, "after the first body" is
  visually where the second body begins, which is where the
  cite ended up.

  Added a new branch: when the cursor sits at `parentOffset
  === 0` of a `REPLACE_IF_EMPTY` paragraph (`card_body`,
  `cite_paragraph`, `undertag`, `paragraph`) that has content,
  return `$from.before(paraDepth)` — the position BEFORE the
  paragraph — so the cite lands at the visual cursor position
  (above that paragraph in the parent's child list). Cursor
  mid-paragraph and end-of-paragraph still fall through to the
  existing `$from.after(paraDepth)` branch. The empty-paragraph
  branch (replace-the-paragraph-with-the-cite) is unchanged
  and still runs first.

- **Ctrl+Up / Ctrl+Down with an active selection no longer
  carries the caret into the adjacent paragraph.** The plain
  (no-Shift) variants now collapse the selection by snapping to
  the start (Up) or end (Down) of the paragraph that contains
  the corresponding selection edge (`$from` for Up, `$to` for
  Down), instead of computing the destination from
  `selection.$head`. Previously, with a selection where the
  head was at the bottom edge, Ctrl+Down ran
  `destNextParaStart` and moved to the NEXT paragraph's start;
  symmetric for Ctrl+Up with head at the top edge running
  `destPrevParaStart`. New `verticalCommandPair` in
  `word-selection-keymap.ts` mirrors the existing
  `horizontalCommandPair` (which handled the Ctrl+Left/Right
  collapse case): when `selection.empty` is false and Shift is
  not held, the move command snaps to the paragraph edge of
  the relevant selection corner and stops. Shift-extend
  variants (`Ctrl-Shift-ArrowUp / -ArrowDown`) keep the
  existing extend semantics by passing through to the base
  command pair.

  Down-side asymmetry: after `Ctrl-Shift-ArrowDown`,
  `selection.$to` lands at `parentOffset === 0` of the
  paragraph BELOW the last visually-selected paragraph
  (`destNextParaStart` walks to the next paragraph's START,
  not the current one's end). A naïve `$to.end()` snap there
  would carry the cursor to the end of a paragraph the user
  never saw as part of the selection. When the down-side
  corner is at `parentOffset === 0`, the fix falls back to
  `prevTextblock(doc, corner.start()).end` — the end of the
  last *visibly* selected paragraph. The symmetric Up case
  doesn't arise via `Ctrl-Shift-ArrowUp` because
  `destPrevParaStart` lands inside the upper textblock (at its
  content-start, not past it), so `selection.$from` is always
  inside the visual selection.

- **Ctrl+Left / Ctrl+Right with a selection now snap to the
  word edge of the corner, not just collapse.** Refines the
  earlier "collapse to selection.from / .to" behavior of
  `horizontalCommandPair` so it matches `verticalCommandPair`'s
  paragraph-edge snap, one notch finer. With a non-empty
  selection and Shift NOT held: take the corner (`$from` for
  Ctrl+Left, `$to` for Ctrl+Right); if the corner is INSIDE a
  word/punct run (left and right flanking chars are the same
  word/punct class), snap to that run's edge via the same
  `prevUnitStart` / `nextUnitStart` iterator the no-selection
  variants use (including the spec's trailing-space absorption
  on the right side); otherwise collapse to the corner. The
  "otherwise" branch is the analog of `verticalCommandPair`'s
  `$to.parentOffset === 0` fallback — when the corner already
  sits at a unit boundary (textblock edge, adjacent to
  space/tab, or at a word↔punct transition), end-of-prev-unit
  and start-of-next-unit are the same position, so the snap is
  a no-op and we just collapse.

  Concrete: select "The" inside "Therefore" → Ctrl+Right lands
  the cursor at the end of "Therefore" (with trailing-space
  absorption if the word has one). After a Ctrl+Shift+Right
  that absorbed past a word's trailing space (head at start of
  the next word), plain Ctrl+Right just collapses there — does
  NOT push further into the next word, matching the analogous
  Ctrl+Shift+Down → Ctrl+Down behavior. Helper
  `isInsideWordOrPunctUnit(map, offset)` does the boundary
  check.

## 0.1.0-alpha.4 — 2026-05-22

- **Layer 2 (keyboard navigation keymap) from the Word-selection
  spec.** New `src/editor/word-selection-keymap.ts` adds bindings
  that override the browser's regex-style word iteration:

  - `Ctrl-ArrowLeft / Ctrl-ArrowRight` (`Alt-` variants for Mac)
    → start of previous / next unit. Walks the textblock's
    per-position class map using `classifyChar` from
    `word-break.ts`, so `don't` is one unit, `U.S.A.` is three.
    Cross-textblock: at offset 0 jumps to the start of the
    previous textblock's LAST unit; at offset == content.size
    jumps to the next textblock's first unit start.
  - `Ctrl-ArrowUp / Ctrl-ArrowDown` (`Alt-` variants on Mac) →
    start of current / next paragraph. Asymmetric: Ctrl+Up has
    an intermediate stop at the current paragraph's start
    (matching Word); Ctrl+Down skips straight to the next
    paragraph with no equivalent stop at the current
    paragraph's end.
  - `PageUp / PageDown` → previous / next heading marker. Same
    shape as Ctrl+Up/Down but using `collectHeadings`'s set
    (pocket / hat / block / tag / analytic from
    `headings.ts:TYPE_TO_LEVEL`). PageUp is asymmetric the same
    way Ctrl+Up is — first stop at the current heading's
    start, then the previous heading on a subsequent press.
  - `Shift-` variants of every move command extend the
    selection (anchor pinned, head moves) so the keymap
    naturally pairs with the mouse state machine.

  The keymap sits ABOVE `baseKeymap` in the plugin list so its
  Ctrl+Arrow / PageUp/Down bindings take precedence. `Home`,
  `End`, `Ctrl+Home`, `Ctrl+End` are deliberately left on the
  browser default — visual-line and doc start/end already match
  the spec.

- **Layer 2 (mouse-selection state machine) from the Word-
  selection spec.** New `src/editor/word-selection-plugin.ts`
  implements the click + drag + shift+click contract:

  - **Single click.** Anchor = a point (the click position).
    Granularity = character, dynamic. Dragging within the
    click's enclosing unit (W0) keeps character granularity
    and the selection is exactly `point..activeEnd`. Dragging
    PAST W0's boundary upgrades to word granularity and pulls
    the rest of W0 into the selection (anchor unit becomes W0
    in full); subsequent extension proceeds by full units.
    Reversing back inside W0 downgrades to character granularity
    and snaps back to `point..activeEnd`.
  - **Double click.** Anchor = the Layer 1 query unit (with
    trailing-space absorption). Granularity = word, fixed.
    Drag extends by bare units (only the initiating click
    absorbs trailing space; subsequent units do NOT). The
    anchor unit stays fully selected even when the drag
    reverses direction.
  - **Shift+click.** Same operation as drag: moves the active
    end under the current anchor + granularity. After a
    double-click, shift+click extends by word. After a single
    click, follows the dynamic single-click rule. Shift+
    double-click and shift+triple-click are no-ops per spec.
  - **Triple click.** Anchor = the containing textblock range,
    granularity = paragraph (fixed). Drag extends one whole
    paragraph at a time; the anchor paragraph stays fully
    selected when the drag reverses. Shift+click after a
    triple-click extends paragraph-by-paragraph — same
    mechanism as the drag.

  The earlier `triple-click-drag-plugin.ts` has been removed —
  its drag-extension logic is folded into the unified state
  machine, and dispatches now carry the
  `pmd:word-selection-plugin` meta so the `apply` hook doesn't
  treat them as external selection changes (which would have
  invalidated the freshly-set paragraph anchor before the next
  shift+click could read it).

  The plugin tracks a module-level `currentAnchor` so shift+
  click after a gesture remembers granularity. An external
  selection-changing transaction (typing, arrow keys,
  programmatic dispatch) marks the anchor stale via a
  `selectionSet`-watching `apply` hook; the next shift+click
  rebuilds a fresh point anchor from PM's
  `selection.anchor`. Dispatches set a
  `pmd:word-selection-plugin` meta on each transaction so we
  can tell ours apart from external ones.

  Atom inline-nodes (images) skip the plugin so PM's default
  NodeSelection still fires on image clicks. `event.preventDefault()`
  on mousedown blocks the browser's default focus transfer in
  the no-op-selection case (single-click at an existing caret
  spot); `view.focus()` is called explicitly to compensate.

- **Layer 1 (word-break iterator) + Layer 3 (formatting trim)
  from the Word-selection spec.** Spec lives at
  `~/Downloads/word-selection-behavior.md`; this commit lands
  the first two of three layers (Layer 2 — custom mouse +
  keyboard selection gestures — comes later).

  New `src/editor/word-break.ts` is the single source of truth
  for what counts as a word. Three-class scheme: word-character
  (letters, digits, `'` U+0027, `'` U+2019), space (U+0020 +
  Unicode whitespace, excluding tab), tab (atomic, never
  groups), punctuation (everything else, including `'` U+2018,
  `_`, `-`, em / en dashes, `.`, `,`, `:`, `;`, `…`). Four base
  units (word, punctuation, space, tab) with asymmetric
  trailing-space absorption: querying a word OR punctuation
  unit extends to include any immediately-following space unit,
  but querying a space unit does NOT reach backward. Tab never
  absorbs. Implementation uses Unicode-aware character classes
  (`\p{L}\p{N}`) so non-ASCII letters and digits are word
  characters; surrogate pairs fall through whichever class
  their first code unit suggests.

  Both pre-existing word-iterators have been replaced:
  `wordRangeAtCursor` in `ribbon-commands.ts` (used by the F7
  Emphasis, F8 Cite, F10 Emphasize Acronym word-expansion
  fallback) and `isWordChar` in `find-replace-plugin.ts` (used
  by the whole-word Find toggle) both call into the new
  iterator. Behavioral consequences: whole-word Find treats `_`
  as a boundary now (`\w`-style regex matched it as a word
  char), F10 Emphasize Acronym on "U.S.C.P." emphasizes
  U / S / C / P instead of just the leading U, and so on.

  Layer 3 lands as a `trimRangesForFormatting(doc, ranges)`
  helper in `ribbon-commands.ts` and a
  `getOperatingRangesForFormatting(state)` wrapper around the
  similar-selection-plugin's `getOperatingRanges` — every
  formatting command's call-site swapped to the wrapper.
  Commands that bypass `getOperatingRanges` (the non-shadow
  branches in `adjustFontSize` / `setFontSize` / `runUniColor`
  / `highlightToShading` / `shadingToHighlight` / strip-mark in
  `color-panel.ts`) trim inline against `sel.from / sel.to`.
  `shadowAwareToggleMark` was previously falling through to
  PM's `toggleMark` on the non-shadow path; it now unifies
  through the trimmed-ranges path so the keyboard Ctrl+B /
  Ctrl+I / Ctrl+U bindings get the trim too.

- **Duplicate-open guard on the file-open path.** The workspace
  doesn't currently support having multiple copies of the same
  doc open — opening a duplicate would create a second
  `DocRecord` with its own undo history, journal, and dirty
  state, which is a confusing UX. The two entry points now
  check before loading:

  - Single-pane (`runOpenFlow`): compares `opened.handle`
    against `currentDocHandle`.
  - Multi-pane shell (`onFileOpen` ribbon path +
    `openFileIntoSlot` per-slot button): a new
    `findOpenRecordByHandle` walks every slot's stack. On
    match, the existing copy is brought to its slot's visible
    record and the slot is focused, so the user lands on the
    doc they "tried to open."

  Handle equality goes through a new
  `isSameOpenHandle(a, b)` helper in `host/index.ts` — string
  comparison on Electron paths, `FileSystemFileHandle
  .isSameEntry()` on the browser. Never-saved docs (handle
  null) aren't deduped — we have no identity to compare yet.

  Cross-window duplicates are also covered on Electron via a
  main-process path map (`Map<canonical-path, windowId>`).
  Three new IPC handlers in `apps/desktop/src/main.ts`:

  - `host:open-path-check(path)` is the read-only pre-load
    probe. If another window owns the path, main focuses that
    window (restoring it if minimized) and returns
    `{ takenByOther: true }` so the caller can toast + abort.
  - `host:open-path-register(path)` claims a path for the
    caller window once a doc has finished mounting.
  - `host:open-path-release(path)` drops the claim on
    unmount / Save-As to a new path.

  Window-close auto-cleanup runs in the existing `browser-
  window-created → closed` listener so a force-quit can't
  leave stale entries blocking re-opens. The `host:spawn-
  window` handler also claims the new window's path
  atomically at spawn time so a concurrent open from a third
  window can't sneak in between spawn and the new window's
  mount. Renderers wire through a centralized
  `setCurrentDocHandle` helper (single-pane) /
  `syncDocPathClaim` helper (multi-pane shell) — each is
  called at every handle-assignment site (open, recovery,
  spawn-target initial mount, Save-As, close) so the
  registration map stays in sync. Browser host has no
  multi-window concept and no-ops these methods.

- **Comments column ported to multi-pane as a shell-row
  sibling.** Previously the column was hidden whenever
  `multiDocWorkspace` was on and the Add Comment / Ask AI ribbon
  commands refused to run. The shell now adopts the shared
  `#comments-column` as a sibling of `.pmd-multi-row` —
  `.pmd-multi-shell` is `flex-direction: row` so the multi-row
  takes `flex: 1` and the column takes its persisted width via
  `--pmd-comments-width`. Visually it reads as a narrow fourth
  slot that shrinks the three doc panes equally instead of
  cutting into the focused pane only.

  Threads follow focus: `focusSlot` calls
  `commentsColumn.render()` so cards rebuild against the newly
  active view (the column's `getView` already returns
  `setActiveView`'s tracked view). Because the column lives
  outside every pane's scroll container, scrolling the focused
  doc would otherwise leave cards stranded at the wrong Y —
  `attachFocusedScrollSync` installs a rAF-throttled scroll
  listener on the focused `.pmd-pane-body` that calls
  `CommentsColumn.relayoutCards()`. The listener tears down and
  re-installs on every focus change; `handleSlotEmptied`
  detaches it when the last doc closes.

  Per-record `dispatchTransaction` now calls
  `notifyCommentsForActiveTransaction` (a new helper exported
  from `editor/index.ts`); it short-circuits unless the
  transaction belongs to the active view, so background-stack
  edits in non-focused panes don't paint over the focused doc's
  column. `buildDocRecord` now accepts an optional `threads`
  array and dispatches `loadThreads` after `record` is
  initialized (a `dispatchTransaction` closing over `record`
  meant earlier dispatch placement hit a TDZ);
  `loadOpenedIntoSlot` (docx + cmir) and `onRecoveredDoc` pass
  threads through so docs land in multi-pane with their
  comments already in plugin state.

  Layout-pinning cleanups carried over from the single-pane
  fix: `desiredTop` no longer clamps at 0 — a heading scrolled
  above the editor's top gives a negative diff in multi-pane
  (column is decoupled from the scroll container), and cards
  should slide off the top symmetrically with the bottom rather
  than pile against `top: 0`. `actualTop` packing math
  similarly allows negative values. Single-pane is unaffected
  because column and editor share a scroll container — the
  diff stays positive in that mode.

- **AI-comment identification moved from `kind: 'ai'` to a
  round-trip-safe shape: fixed `'AI'` initials + a `(AI)` suffix
  on the author name.** The `kind` field doesn't survive a docx
  round-trip — Word has no concept of AI vs human, so when a doc
  is saved as docx and re-imported, every comment comes back as
  `kind: 'human'`. AI comments lost their purple-badge styling
  in the process. New AI comments now carry the AI marker in
  fields that DO round-trip: `initials: 'AI'` (regardless of
  persona) and an author name like `Clod (AI)` (or just `'AI'`
  when no custom persona is set — no double-suffix). A new
  `isAiComment(comment)` helper recognizes either signal and
  drives the existing `.pmd-comment-ai` purple styling path.
  The helper also honors legacy `kind: 'ai'` so comments saved
  before this change keep their styling. New AI comments are
  written with `kind: 'human'`. The small inline "AI" tag that
  used to sit next to the author name has been removed —
  redundant with the `(AI)` suffix that's now baked into the
  name. CSS class `.pmd-comment-kind-tag` deleted.

- **Multi-pane workspace shortcuts moved into the ribbon
  registry; all rebindable via Settings → Keybindings.** Eight
  new `RibbonCommandId`s with defaults matching what shipped
  earlier in this Unreleased cycle:

  - `focusSlot1` / `focusSlot2` / `focusSlot3` → `Mod-1/2/3`
  - `sendDocToSlot1` / `sendDocToSlot2` / `sendDocToSlot3` →
    `Mod-Shift-1/2/3`
  - `toggleSlotExpand` → `Mod-Shift-f`
  - `closeDocOrWindow` → `Mod-w`

  Each gets a label, default-key entry, group placement (new
  "Multi-pane workspace" section in `ribbon-groups.ts`), a
  no-op `Command` case in `commandFor` (the keymap matcher
  doesn't need to do anything — these are view-less actions),
  and an entry in `VIEWLESS_RIBBON_COMMANDS`. The global
  window keydown handler in `editor/index.ts` dispatches them
  via `runViewlessRibbon`, which now calls into a small new
  `runMultiPane` helper that dynamic-imports the shell module
  and invokes one of three new exports:

  - `focusSlotByIndex(idx)`
  - `sendVisibleToSlotByIndex(idx)`
  - `toggleFocusedSlotExpand()`

  These are thin wrappers around new `MultiPaneShell` methods
  (`focusSlotByIndex`, `sendVisibleToSlotByIndex`,
  `toggleFocusedSlotExpand`). `closeDocOrWindow` uses the
  existing `tryCloseVisibleInFocusedSlot` + fallback to
  `handleUserCloseRequest`.

  Two standalone `window` keydown listeners removed
  (`onSlotShortcutKey` and `onExpandToggleKey`) — the work
  flows through the global ribbon-keymap path now. The
  Electron menu's `CmdOrCtrl+W` accelerator stays hardcoded
  as a discoverability cue; if the user rebinds
  `closeDocOrWindow`, both paths fire the same action.

  Ribbon keymap matcher (`ribbonKeyStringFor`) now normalizes
  digit keys via `e.code` (e.g., `Digit1` → `1`) so
  `Mod-Shift-1` matches even though Shift+1 produces
  `e.key === '!'` on US keyboards (and layout-specific shifted
  digits elsewhere). Without the fix, the new `sendDocToSlotN`
  bindings wouldn't fire from the global handler. Letters and
  symbol keys still use `e.key`.

  The Ctrl+Tab doc-cycling overlay is the lone exception —
  its hold-and-press semantics (modifier held, Tab pressed
  repeatedly, modifier released to commit) don't fit the
  discrete-press ribbon-command model. The
  `onDocCycleKey` / `onDocCycleKeyUp` listeners stay on
  `window` with hardcoded `Tab` matching.

- **Multi-pane: Ctrl+Tab / Ctrl+Shift+Tab cycle docs within the
  focused slot.** New `Slot.cycleVisible(delta)` advances the
  visible doc index in a slot's stack with wrap-around. Wired
  via a new `onDocCycleKey` window keydown listener (mounted
  alongside the existing `onSlotShortcutKey` for Mod-N slot
  focus). Routes through the existing `showRecord` so the
  shared-chrome / focusSlot dance fires the same way as a
  click on the stack-dropdown menu would.

  Desktop (Electron) accepts plain Mod+Tab — Electron windows
  have no native tabs to cycle, so the keydown passes through
  to the renderer's JS unmodified. Web reserves the plain
  Mod+Tab chord for the browser's own tab cycling, so the
  renderer never sees the keydown there. The handler also
  accepts Mod+Alt+Tab as the web-edition fallback (and on
  desktop, which makes Mod+Alt+Tab a universal alias).
  Shift toggles direction.

- **Multi-pane: Ctrl+Shift+1 / 2 / 3 send the focused slot's
  visible doc to slot N.** Mirror of the Mod-N slot-focus
  chord. New `Slot.releaseVisible()` is closeVisible without
  the view destroy / journal drop: detaches the visible
  record's DOM, removes it from the stack, mounts the next
  visible doc (or empties the slot), and returns the released
  `DocRecord` so the shell can re-push it into the target
  slot's stack. The view stays live across the move, so the
  doc keeps its cursor, selection, undo history, autosave
  state, and any other view-attached state.

  Extended `onSlotShortcutKey` to differentiate the Mod-only
  chord (focus) from the Mod-Shift chord (send-to). The
  digit-match uses `e.code === 'Digit1'/'Digit2'/'Digit3'`
  rather than `e.key === '1'/'2'/'3'` because Shift-modified
  digits render as `!`/`@`/`#` (or layout-specific characters)
  in `e.key`; `e.code` is the physical-key identifier and
  works for both shifted and unshifted chords.

  Expand-mode edges handled via the existing notification
  callbacks: source emptying in expand mode drops expand
  mode; target receiving a doc while a different slot is
  expanded keeps the doc hidden until expand mode exits.

- **Exported .docx is Verbatim-recognized on open.** Verbatim's
  per-doc ribbon-visibility callback
  (`Ribbon.GetRibbonVisibility`, registered on every `<group>`
  in Debate.dotm's `customUI14.xml`) decides activation by
  reading `ActiveDocument.AttachedTemplate.Name`. To make our
  exports activate the Debate ribbon without the user clicking
  Verbatimize first, `Docx.empty()` in `src/ooxml/docx.ts` now
  emits:

  - `word/settings.xml` containing
    `<w:attachedTemplate r:id="rId1"/>`.
  - `word/_rels/settings.xml.rels` containing the rel with
    `Type=".../attachedTemplate"`,
    `Target="file:///Debate.dotm"`,
    `TargetMode="External"`.
  - The matching `<Override>` for the settings part in
    `[Content_Types].xml`.
  - A `<Relationship>` linking `document.xml` →
    `settings.xml` in `word/_rels/document.xml.rels` (added in
    `exporter.ts`'s `buildRelsXml`, claiming `rId2`; dynamic
    rels now start at `rId3`).

  Methodology: extracted Debate.dotm and the VBA strings dump
  pointed at `AttachedTemplate` + `InstallCheckTemplateName` as
  the recognition predicate. First experiment (the docVar
  hypothesis — setting `VerbatimVersion` in `<w:docVars>` to
  various values) was falsified — none of v2 / v3 / v4 / v5
  activated the ribbon. Second experiment
  (`<w:attachedTemplate>` with the rel in `document.xml.rels`)
  also failed; the diff against a doc that the Verbatimize
  macro itself produced showed the rel belongs in
  `settings.xml.rels`, not `document.xml.rels`. Third
  experiment landed it:

  - v8 (`Target="Debate.dotm"`, bare filename): failed.
  - v9 (full Windows path the Verbatimize macro wrote on the
    author's machine): worked on two different Windows
    installs, even though the path was hardcoded to the
    original user's folder — confirming Word doesn't validate
    the stored path file-system-exists, just reads the
    basename of the URI.
  - v10 / v11 / v12 (URI shapes with no / fake-Unix /
    fake-Windows path components): all three worked on
    Windows. v10 / v11 also worked on Mac Verbatim (a separate
    Mac Word notification-daemon hang was diagnosed via the
    crash report's call stack and confirmed unrelated).

  Picked v10 (`file:///Debate.dotm`) as the shippable Target —
  shortest URI that activates recognition; Word doesn't care
  whether the path is reachable.

  Round-trip safety: today's exporter doesn't preserve the
  input docx's `word/settings.xml`; `toDocx` always starts
  from `Docx.empty()`. So no merge logic is needed — every
  export ships with the recognition surface, whether the
  source was fresh or imported. Users who don't have Verbatim
  installed see no impact: the stored attached-template
  Target is unresolvable to them, Word falls back to
  Normal.dotm, no prompt, no UI shift.

  The experiment script
  (`reference-docs/experiment-verbatimize.mjs`, gitignored)
  stays around as a local diagnostic if Verbatim's
  recognition mechanism ever shifts in a future release.

- **Emphasize Acronym (Mod-F10).** New ribbon command for
  marking the source letters of an acronym. Algorithm:
  1. Bail if the selection is empty.
  2. For each textblock that overlaps the selection (skipping
     structural blocks via the existing `NAMED_STYLE_SKIP_BLOCKS`
     set — emphasis_mark is body-only), find the leftmost and
     rightmost non-whitespace character indices within the
     selection's clip range. If neither exists (selection is
     entirely whitespace), skip the block.
  3. Expand leftward and rightward through non-whitespace to
     reach whole-word boundaries (same word definition as
     `wordRangeAtCursor` — maximal run of non-whitespace within
     the textblock, inline leaves break words, mark boundaries
     don't).
  4. Walk the expanded range and emit a 1-character mark range
     for every word-start position (WS-to-non-WS transitions
     plus the initial position if non-WS).
  5. Apply `emphasis_mark` to each range plus the same direct-
     formatting strip `applyEmphasis` uses.

  Wired the standard ribbon-command surface — type union,
  registry array, label ("Emphasize Acronym"), default key
  (`Mod-F10` → "Ctrl+F10" on Win/Linux, "⌘F10" on Mac),
  dispatcher case, and `ribbon-groups.ts` placement next to
  `applyEmphasis` in the Character styles group so both the
  cheat sheet and the keybindings editor inherit the
  grouping.

- **Keybindings editor grouped by thematic section.** Lifted
  the `GROUPS` taxonomy out of `reference-ui.ts` into a new
  shared `ribbon-groups.ts` module as `RIBBON_GROUPS`. The
  drift-guard assertion (every `RibbonCommandId` lands in
  exactly one group, no duplicates, no orphans) moved with it
  and now protects BOTH surfaces — adding a new command
  without categorizing it throws at module load.

  Settings → Keybindings used to call
  `[...RIBBON_COMMAND_IDS].sort((a, b) => labelA.localeCompare(labelB))`
  and render every row in one alphabetical flat list (~70
  rows). Now iterates `RIBBON_GROUPS` instead: each group
  becomes a `<section>` with an uppercase muted `<h3>` heading
  + that group's commands in the order the group defines them
  (matching the cheat sheet's ergonomic clustering, not raw
  alphabetical). Group headings are `position: sticky; top:
  0` inside the scrollable list so users keep their place as
  they scroll through long sections like "Table" (10 rows).

  Single source of truth: editing `ribbon-groups.ts` updates
  both the cheat sheet and the rebinding editor. No more
  "remembered to update both" failure mode for future
  command additions.

- **Round-trip: hyperlink rel Targets are XML-attribute-escaped.**
  `exporter.ts`'s `buildRelsXml` was interpolating `rel.target`
  raw into the `Target="..."` attribute of each hyperlink
  `<Relationship>`. URLs containing `&` (the standard
  query-string parameter separator — extremely common in cite
  links) ended up as raw `&` in the XML, which is malformed.
  Word's loader uses a recovery-mode parser that pulls the
  document body through anyway, but flags the file as
  corrupted on open. User-reported symptom: round-trip of a
  doc with many cite hyperlinks opened on another machine as
  "we found a problem with some content" and images failed to
  display (likely because the rels XML failure cascaded into
  the relationship resolver giving up partway).

  Fix: pipe `rel.target` through the existing `escAttr` helper
  (`src/ooxml/xml.ts`) for both the hyperlink and image rel
  emission paths. `escAttr` escapes `&`, `<`, `>`, and `"` —
  the four chars that can break an attribute value. Image
  Targets are internally generated and currently safe, but
  symmetry / defense in depth justifies the escape there too
  (a future media filename with a special char would have the
  same problem).

  Detected via diff of a doc round-tripped through CardMirror
  against the same doc untouched: both opened in Word, but the
  round-tripped one reported corrupted on open. `xmllint
  --noout document.xml.rels` returned `EntityRef: expecting
  ';'` errors at exactly the unescaped `&` positions.

- **Plain-paste no longer splits cards on a trailing newline.**
  Long-standing user-reported bug ("skipping around on paste"
  / "viewport shoots to the bottom") had a narrow trigger:
  copy-and-plain-paste of text containing a line break into a
  tag (or other single-line block). A common real-world
  occurrence is triple-clicking an article title in the
  browser; most browsers grab a trailing `\n` alongside the
  visible text.

  `buildPlainTextSlice("Article Title\n")` produced a
  two-paragraph slice (`Slice([paragraph("Article Title"),
  paragraph("")], 1, 1)`). When `replaceSelection`'d into a
  `tag` (which our schema constrains to a single textblock
  inside a `card`), PM split the surrounding card at the
  paragraph boundary to accommodate the multi-paragraph
  slice — the existing tag/cite ended up separated with a
  floating card-boundary separator at the newline position,
  and the post-paste `scrollIntoView()` landed at the new
  doc-end (since the structural mutation moved the cursor
  to the synthesized split point's end-of-doc cascade).

  Fix: new `normalizeClipboardTextForPaste(text, parentTypeName)`
  helper in `paste-plugin.ts`. In single-line contexts
  (`tag`, `cite_paragraph`, `undertag`, `analytic`) it
  collapses whitespace runs (`\s+`) to single spaces and
  trims edges before the text reaches `buildPlainTextSlice`.
  In multi-paragraph contexts (`card_body`, `paragraph`, etc.)
  it returns the text unchanged so intentional paragraph
  splits in the clipboard still produce multi-paragraph
  slices.

  Wired into both plain-paste entry points: the browser
  `handlePaste` handler (when `plainPasteArmed` is set, e.g.
  F2 in the web edition) and the Electron-host
  `applyPlainPasteFromText` function (called from the
  desktop menu's "Paste as plain text" / native F2 mapping).

- **Nav pane: highlight follows the editor caret.** Previously
  the `.pmd-nav-item-selected` blue highlight was driven purely
  by click events on the nav-pane (`selectSingle` / shift-click
  range / ctrl-click toggle); editor caret movements didn't
  update it. New `NavigationPanel.setCaretHeading(pos)` finds
  the heading whose section contains the caret (= largest
  `entry.pos <= pos` from the rendered `liEntries`) and calls
  `selectSingle` on it. Wired from `index.ts`'s
  `dispatchTransaction`, gated on `prevState.selection.from !==
  next.selection.from` so doc-only transactions away from the
  cursor don't pay the find-heading walk.

  Caret-tracking always produces a single selection — explicit
  multi-select via Ctrl/Shift-click still works for drag-and-
  drop and similar workflows, but collapses on the next caret
  movement. Matches the user mental model that the nav-pane
  reflects "where the cursor is."

  Doesn't auto-scroll the nav pane to bring the highlight into
  view — explicit decision; auto-scrolling on every cursor move
  would dominate the user's scroll behavior on long docs. Worth
  revisiting if it turns out users want it for outline-following
  workflows.

  Edge cases:
  - Caret before the first heading → `clearSelection()`, no
    highlight.
  - Caret inside a heading whose nav entry is hidden under a
    collapsed parent → the closest ancestor in `liEntries` gets
    highlighted (we iterate only rendered items).
  - Position drift between a doc edit and the next debounced
    `update()` (~200ms): the highlight may briefly point at a
    stale neighbor. Acceptable for a visual indicator.

- **Comments column: user-draggable width with resize handle.**
  Mirror of the nav-pane resize-handle pattern. New
  `commentsColumnWidth` setting (default 320, range 240–560)
  persists the width across sessions. CSS custom property
  `--pmd-comments-width` drives `.pmd-comments-column { width }`;
  the resize handle on the column's LEFT edge (the
  `right`-anchored opposite of the nav-pane's right-edge
  handle) updates the custom property during drag. Mouseup
  writes the final value to `settings`.

  Range chosen by squint: 240 px is the threshold below which
  thread cards start feeling cramped; 560 px is where the
  column starts eating too much of the editor width on a
  laptop. Same clamp in the settings sanitizer + the JS drag
  handler so persisted out-of-range values get pulled back in.

  The handle's bg is transparent at rest; tints on hover
  (`--pmd-c-accent-soft`) and during drag. Mirrors the
  nav-pane handle exactly — col-resize cursor on hover is the
  discovery cue, no permanent visible affordance. (An earlier
  iteration added a grip-dot indicator; removed when the user
  preferred the cleaner pattern of the nav-pane.)

- **Comments column: resize handle survives render() wipes.**
  Initial implementation appended the handle as a direct child
  of `#comments-column`. The column's `render()` method (fired
  from `dispatchTransaction` on every keystroke that affects
  comments state) does `this.root.innerHTML = ''` to rebuild
  threads from scratch, which wiped the handle along with
  everything else. User reported "can't see the resize handle"
  after typing — exactly the post-wipe state.

  Fix: introduce an inner `.pmd-comments-content` wrapper
  inside the column. `render()` now wipes that inner wrapper
  rather than the column root. The resize handle stays as a
  sibling of the wrapper (installed in the constructor BEFORE
  the wrapper, so DOM order is handle-then-content). Sticky
  positioning context for any column children remains the
  column itself (via `position: relative`); the inner wrapper
  is `height: 100%; width: 100%` so containment doesn't shift.

- **Comments column: full-scroll-extent layout via inner grid
  wrapper.** Same family of post-path-A regression as the
  multi-doc top-shift and recovery-sidebar offset that landed
  in alpha.3. With `#app` migrated to `position: fixed` +
  `overflow-y: auto` (the bounded scroller), the inner flex
  layout's cross-axis was viewport-bounded — items stretched
  to viewport, not to content height. The comments column's
  background only rendered at the top of the page and didn't
  cover the full scroll strip.

  Two-stage fix:
  1. `<div class="pmd-editor-row">` wrapper added inside `#app`
     in `index.html`, holding `#editor` + `#comments-column`.
     The flex / grid layout lives on this inner wrapper rather
     than `#app` itself.
  2. The wrapper uses `display: grid; grid-template-columns:
     1fr auto`. Initial attempt was flex with `min-height:
     100%`, but flex's cross-size determination floors at
     `min-height` and doesn't grow with overflowing items
     (measured: wrapper box 807px while `#editor.scrollHeight`
     was 5971px). Grid track sizing is content-based and
     handles this case cleanly — items end up content-tall
     (≈ 5982px on a long doc), the column's background covers
     the full scroll strip.

  Short / empty document case (separate issue surfaced in
  testing): with `grid-auto-rows: max-content`, an empty doc
  produced a short track and the column rendered as a small
  strip at the top of the visible area with empty space below.
  Fixed by NOT setting an explicit `grid-template-rows`
  initially, then trying `minmax(100%, max-content)` (collapsed
  to 100% per CSS Grid spec's "treat percentages as auto when
  the container's size depends on its tracks" rule, regressing
  the long-doc fix). Final shape: no explicit `grid-template-
  rows`; track auto-sizes. Combined with `min-height: 100%` on
  the wrapper, this gives items max(viewport, content) cross-
  size in both cases.

  Hidden in multi-doc layout via
  `body.pmd-multi-doc .pmd-editor-row { display: none }` —
  multi-pane's per-pane shell sits as a sibling of the wrapper
  and uses its own internal layout.

- **Comments column: bottom-left collapse/expand toggle removed.**
  The `.pmd-comments-toggle-active` button (▾/▴ circle pinned
  with `position: sticky; bottom: 0.5rem`) is gone. Removed:
  the `renderToggle` method, its call site in `render()`, the
  "skip click on toggle" branch in the sticky-dismiss handler,
  the `lastActiveThreadId` field + assignments (only the
  toggle button used it for "re-expand most recent thread"),
  and the three CSS rules for the button.

  Active-comment collapse still works — the sticky-dismiss
  global mousedown handler still dismisses when the user
  clicks outside the active card. The lost affordance is the
  "explicitly re-expand the most recently active thread"
  button-click; users now click the card they want to re-open.

## 0.1.0-alpha.3 — 2026-05-21

- **Auto-update check on launch (opt-in).** New setting
  `checkForUpdatesOnLaunch`, off by default in this release.
  When on, the first window of an app session triggers a silent
  update check during boot (gated on `host.isFirstWindow()`,
  same pattern as the doc-recovery UI — subsequent windows in
  the same session skip the check). If `update-available` fires,
  the same modal the manual Help → Check for Updates path uses
  pops up with "Open release page" + "Close" buttons; the
  "Open release page" button calls `shell.openExternal` to deep-
  link to `https://github.com/ant981228/cardmirror/releases/tag/v$VERSION`
  in the user's default browser. Errors and "you're current"
  outcomes stay silent on this path — the wishlist explicitly
  flagged that surfacing them every launch would be obnoxious
  for users who happen to be offline at boot.

  Implementation:
  - Renderer-driven trigger: a new
    `host:trigger-auto-update-check` IPC handler in `main.ts`
    calls a shared `runUpdateCheck(opts)` function with
    `{ alertOnLatest: false, alertOnError: false }`. The same
    function backs the manual Help-menu path with
    `{ alertOnLatest: true, alertOnError: true }`.
  - Shared `showUpdateAvailableDialog(info)` helper holds the
    modal definition, so the available-update dialog is
    byte-identical between manual and auto-launch paths.
  - Single `updateCheckInFlight` guard prevents the manual and
    auto paths from racing if they happen to overlap (e.g.,
    user clicks Help menu before the boot check completes).
  - `startAutoUpdate` no longer calls `checkForUpdates()`
    itself — the renderer owns the at-launch trigger now,
    gated on the setting + `isFirstWindow()`. The persistent
    `update-downloaded` handler stays in `startAutoUpdate` so
    the "Update ready, restart now?" dialog still fires when
    the background download completes (regardless of whether
    the trigger came from manual, auto-launch, or the Settings-
    panel button).
  - Setting toggle lives in `buildInstallInfoSection` (Settings
    → General → "About this install") via a plain checkbox
    above the existing Check-for-updates / Open-crash-dumps
    action buttons. Electron-only (web edition has no update
    mechanism).

- **Manual update check: three-dialog feedback.** The Help →
  Check for Updates click handler in `apps/desktop/src/main.ts`
  used to register only an `update-not-available` handler;
  `update-available` and `error` paths were silent (auto-update
  proceeded in the background, errors went to `console.warn`).
  Replaced the inline click handler with a `runManualUpdateCheck()`
  function that registers `.once` handlers for all three events
  plus a `catch` on the `checkForUpdates()` promise, with a
  mutual-cleanup pattern so exactly one dialog fires per check.
  Dialogs:
  - **Not available**: "You're on the latest version." + version.
  - **Available**: "Update available: vX.Y.Z." With buttons
    "Open release page" (deep-links to the tag's release page via
    `shell.openExternal`) and "Close." The download still proceeds
    in the background via the persistent `startAutoUpdate`
    handlers, which will show the existing "Update ready,
    restart now?" dialog when finished.
  - **Error**: "Couldn't check for updates: <message>" with the
    Releases URL as a manual-download fallback.
  Re-entrancy guard (`manualCheckInFlight`) prevents rapid double-
  clicks from registering duplicate handler sets. Auto-check
  errors on launch still go to `console.warn` per the wishlist —
  popping a dialog on every offline boot would be obnoxious.

- **`getFocusedWindow()` null guard via `dialogParentWindow()`.**
  Both the manual update-check dialogs above and the existing
  startAutoUpdate `update-downloaded` handler look up the dialog
  parent via `BrowserWindow.getFocusedWindow()`. If the user
  alt-tabs away between clicking "Check for Updates" and the
  response arriving, that returns `null` and the previous code
  silently early-returned, dropping the dialog on the floor.
  Centralized the lookup in `dialogParentWindow()` which falls
  back to `BrowserWindow.getAllWindows()[0]` — worst case the
  dialog attaches to "some" CardMirror window instead of the
  focused one, which is far better than the dialog never
  appearing.

- **About panel surfaces Chromium and Electron versions.**
  `src/editor/install-info.ts` parses `Chrome/X.Y.Z` and
  `Electron/A.B.C` out of `navigator.userAgent` and lists them
  as their own labelled rows above the full UA string. The
  underlying versions were already discoverable by reading the
  UA, but separate rows make "is the user actually running the
  version they think they are?" a one-line check during bug
  triage. Web edition shows Chromium but no Electron row.

  Context for this: a user-reported "Linux build shows version
  0.1.0-alpha.1 on alpha.2 install" bug whose code-path
  investigation came back clean — `pkg.version` is Vite-inlined
  from the root `package.json` at build time, the alpha.2 tag's
  `package.json` was `0.1.0-alpha.2`, the AppImage filename
  itself is `cardmirror-0.1.0-alpha.2.AppImage`. The most plausible
  explanation is the user had an earlier alpha.1 AppImage still
  installed (AppImages don't auto-update). Adding the separate
  version rows is the defensive measure that makes future
  version-mismatch confusion easier to diagnose.

- **Release workflow: two-stage to avoid the matrix-race.**
  alpha.2's release produced two separate drafts because the
  three OS matrix jobs concurrently saw "no release for this tag"
  and each created its own — Mac + Windows assets ended up on
  one draft and Linux's on another, requiring manual
  reconciliation. New `prepare-release` job runs first on a
  single Ubuntu runner, idempotently creates a draft release via
  `gh release create $TAG --draft --title $TAG --generate-notes`
  (no-op if a release for the tag already exists), and the
  `build` matrix job `needs: prepare-release` so it never starts
  until the draft is in place. electron-builder's GitHub
  provider then finds the existing draft and uploads to it
  instead of racing to create one.

- **Single-doc scroll container migrated from `body` to `#app`.**
  Diagnosis: a multi-trace investigation (Mac Electron, Mac Chrome,
  Linux Chrome, with and without `--enable-skia-graphite`) plus a
  layer-tree audit on macOS pinned single-doc's continuous heavy
  `UpdateLayer` cost during scrolling to the document being the
  rootScroller. The DevTools Layers panel showed `#document` at
  2206 × 558272 px, ~4.9 GB nominal memory, compositing reason
  *"Is the document.rootScroller. Is a scrollable overflow element
  using accelerated scrolling."* Every scroll position change
  triggered a recomposition of that giant layer. Trace-data
  signature: 10 big (>100 ms) `UpdateLayer` events spread across
  a 13 s scroll session in single-doc vs. zero in multi-pane
  (which already used the bounded `.pmd-pane-body` scroller).

  Fix: scope a new `body:not(.pmd-multi-doc) #app` rule that pins
  `#app` to the chrome-clipped viewport rectangle via
  `position: fixed` (top/left/right/bottom set from the existing
  `--ribbon-height` / `--nav-width` / `--status-bar-height`
  tokens) and gives it `overflow-y: auto` + `overscroll-behavior:
  contain`. The editor + comments column scroll *inside* `#app`;
  `body` stops being the rootScroller; the composited scrollable
  layer is bounded by `#app`'s viewport-sized box instead of the
  doc-content height. Multi-doc layout is untouched — it has its
  own `body.pmd-multi-doc #app` rule that already pins height and
  manages overflow via per-pane `.pmd-pane-body` scrollers.

  Companion changes:
  - `body.pmd-speech-banner-visible:not(.pmd-multi-doc) #app` now
    adjusts `top:` instead of `margin-top:` (multi-doc never
    surfaces the banner, so this is single-doc-only).
  - The dark-chrome-light-document background paint extends to
    `#app` (was `.pmd-pane-editor` + `.pmd-pane-body` previously) —
    container backgrounds in `overflow: auto` cover the full
    scrollable extent at every scroll position, so any gap below
    the editor's content extent now reads as light rather than
    dark.
  - `index.ts` reset path: `appEl.scrollTop = 0` replaces
    `window.scrollTo(0, 0)` in the doc-open scroll-to-top sequence.
  - `precise-scroll.ts` `desiredTop` now reads from the nearest
    scrolling-overflow ancestor's `getBoundingClientRect()` instead
    of `window.innerHeight`. Falls back to viewport bounds when
    no scroller is found (tests, detached nodes). This keeps the
    convergence math working across single-doc (`#app`), multi-pane
    (`.pmd-pane-body`), and any future container.

  Verified end-to-end: typecheck + 683 tests pass. Most scroll-
  path call sites needed no changes — `tr.scrollIntoView()` (the
  PM Transaction method) walks up from the selection's DOM to
  find the nearest scrolling ancestor; element-level `scrollIntoView`
  does the same; `drag-editor-surface.ts`'s host-relative math
  was already 0 in single-doc and stays so.

  Standalone, this fix narrowed but didn't close the macOS gap
  (see Electron bump entry below for the second half of the
  story).

- **Electron bumped from 33 (Chromium 130) to 42 (Chromium 148).**
  Second half of the macOS scroll-perf fix. The path A
  architectural change above eliminated the doc-as-rootScroller
  giant layer in single-doc, but the residual gap to the same
  content rendered in the user's installed Chrome 148 remained —
  measured most acutely as click-jump tail latency
  (electron-multi p99 frame interval 974ms vs chrome-multi 343ms
  on identical content + hardware) and per-event `UpdateLayer`
  cost magnitude (electron-single avg 472ms vs chrome-single
  78ms). Trace data attributed the gap to Chromium 130's
  compositor pipeline being more tightly coupled to main-thread
  work than 148's — Chrome did similar total work per scroll but
  produced frames smoothly through it, while Electron 130
  blocked frame production on the heavy work.

  GPU-feature-status diff between the two builds on the same Mac
  landed cleanly on one line:
  `skia_graphite: disabled_off` (Electron 33) vs `Enabled`
  (Chrome 148). Skia Graphite is the newer Dawn-on-Metal Skia
  backend that ships the relevant compositor decoupling. The
  `--enable-skia-graphite` switch we added to `main.ts` engaged
  the feature in Electron 33 (verified by re-running the GPU diff
  post-switch) but the M130 iteration of Graphite is two cycles
  pre-default-on; engaging the flag helped substantially but
  didn't reach Chrome 148's behavior. The actual cure was
  upgrading to a Chromium build that ships the mature Graphite
  implementation.

  Electron 42's bundled Chromium is `148.0.7778.96`, effectively
  matching the user's installed Chrome 148.0.7778.168 — maximum
  apples-to-apples perf parity. Bumps:
  - `electron`: `^33.2.0` → `^42.2.0` (9 major version jump)
  - `electron-builder`: `^25.1.8` → `^26.8.1`
  - `electron-updater`: `^6.3.9` → `^6.8.3`
  - `electronVersion` in build config: `33.2.0` → `42.2.0`

  Migration was uneventful: full `rm -rf node_modules
  package-lock.json && npm install`, `npm run build:main` clean
  against Electron 42 types (no main-process API breakages
  caught by tsc against the 9-major delta), renderer typecheck +
  683 vitest tests still pass. End-user verification on the Mac
  confirmed the perf gap closed — scrolling, typing, and
  nav-pane click latency now feel parity with the in-browser
  experience.

  The `--enable-skia-graphite` switch we added during the
  investigation is now a no-op on Electron 42 (Graphite is
  default-on for Apple in Chromium 148) but stays in place as
  belt-and-suspenders. The "Copy GPU Info" menu item that was
  added as a temporary diagnostic stays as a permanent
  bug-report aid — one click, zero runtime cost.

- **Keyboard Shortcuts cheat sheet caught up with the keybindings
  registry.** The `GROUPS` array in `src/editor/reference-ui.ts`
  was hand-maintained and had drifted behind the registry — alpha.2
  added twenty-some new bindable commands (the twelve previously
  click-only ribbon actions plus `zoomIn` / `zoomOut` / `zoomReset` /
  `chromeScaleUp` / `chromeScaleDown` / `chromeScaleReset` /
  `togglePaintbrushHighlight` / `togglePaintbrushShading` /
  `openFind` / `openFindReplace` / `openFindByProximity` /
  `toggleNavPane`) and none of them appeared in the cheat sheet.
  Two changes:

  1. **Expanded GROUPS to cover every `RIBBON_COMMAND_ID`.** Added
     three new categories — `Color pickers & menus`, `Find`,
     `Zoom & scale` — and slotted the missing commands into
     existing categories (`save` and `toggleAutosave` into File,
     `insertImage` into Editing utilities, paintbrush toggles into
     Highlight tools, the picker openers into the new Color pickers
     & menus group, etc.).
  2. **Module-init drift guard** asserts every `RIBBON_COMMAND_ID`
     appears in exactly one group. Throws on load if anyone adds a
     new command to the registry and forgets the cheat-sheet
     update, or accidentally lists the same command in two groups.
     Error message names the missing / duplicated / extra ids so
     the fix is obvious from the stack trace.

  Verified end-to-end via CDP: 86 rows across 17 groups (was 14
  groups and a smaller subset before; the previous version was
  missing ~26 commands). Module init returned `ok` rather than
  throwing, confirming the assertion accepts the current registry.
  Unbound commands continue to display `—` (we briefly shipped
  `(no shortcut)` instead; reverted at user request because it was
  too noisy with ~46 unbound commands).

- **New setting: Format nav pane entries by type** (Settings →
  Appearance, default on). Wishlist follow-up to the dark-mode
  nav-pane flatten-to-white tweak: some users find the per-level
  font weight cascade (700 → 600 → 500 → normal) and the analytic-
  blue label accent noisy and prefer a uniform list keyed only on
  indentation. Implementation:
  - New `formatNavPaneByType: boolean` field on `Settings`,
    default `true`, sanitized in `loadSettings` so missing-or-
    truthy is treated as on and explicit-`false` as off.
  - `SETTING_METADATA` entry under category `appearance` next to
    `showDocNameChip`, so it lands in Settings → Appearance with
    the other nav / chrome toggles.
  - `applyFormatNavPaneByType(on)` in `index.ts` toggles
    `html.pmd-nav-flat` (class present when the toggle is OFF;
    parallels `pmd-doc-name-chip-on` / `pmd-nav-hidden`). Called
    at module init and from the settings subscriber so live
    toggling works.
  - CSS rules in `style.css` near the existing per-level rules:
    when `html.pmd-nav-flat` is set, `.pmd-nav-level-{1,2,3,4}`
    collapse to `font-weight: normal`, `font-size: 0.85rem`,
    `color: var(--pmd-c-text)`, and
    `.pmd-nav-type-analytic .pmd-nav-label` inherits instead of
    forcing the analytic-blue accent. Padding-left rules are
    untouched — indentation is the surviving hierarchy cue.
  - The dark-mode nav-pane-flatten-to-white rule still wins
    inside dark mode because it carries the higher-specificity
    `:root[data-theme="dark"] :is(.pmd-nav-panel, .pmd-multi-nav)`
    chain — both rules want uniform color anyway, so the cascade
    interaction is by design.
  Verified end-to-end via CDP on the 1NC v. Dartmouth doc: with
  `pmd-nav-flat` set, level-1 / 2 / 3 entries all report
  `font-weight: 400`, `font-size: 13.6px`; default state has 700 /
  600 / 500.

- **Scroll chaining from the nav pane no longer bleeds into the
  editor.** With the pointer over the nav pane, scrolling past its
  top or bottom limit would propagate the leftover wheel delta to
  the body's scroll container (single-doc) or the multi-pane row.
  Once the browser picked the editor as the gesture's scroll
  target, reversing direction kept scrolling the editor until the
  user paused fully and started a new gesture. Fix: add
  `overscroll-behavior: contain` on the two `overflow-y: auto`
  containers that own the nav and pane scrolls — `.pmd-nav-list`
  and `.pmd-pane-body` (multi-pane). `contain` cuts the scroll
  chain at the element's boundary, which also kills the "sticky
  target" follow-up because the chain never starts. Single-doc
  editor scrolls on the body / html, which has no ancestor scroll
  container to chain into, so no symmetric change needed there.
  Verified: `getComputedStyle(.pmd-nav-list).overscrollBehaviorY ===
  "contain"` post-fix.

- **Dark mode: end-to-end readability guarantee on imported docs.**
  Reported against the Health Care Topic Area Paper and 1NC v.
  Dartmouth CG docxs: with Settings → Appearance → Theme: Dark
  and "Apply theme to the document area" enabled, large swaths
  of body text were invisible (literal black on dark), shading-
  background text was invisible (themed white on yellow shading
  from Verbatim's `HighlightToBackgroundColor` macro), and
  hyperlinks were either browser-default `#0000EE` blue or
  Word's `#0563C1` — neither readable on `#1a1a1a`. Four
  coordinated changes in `src/schema/marks.ts` and
  `src/editor/style.css`:

  1. **`font_color="000000"` skip-inline-style.** The
     `000000` sentinel emits only `data-color="000000"` (no
     `style="color: #000000"`). The run inherits the
     surrounding text color: near-black via `--pmd-c-text` in
     light mode, `#e6e6e6` in dark mode, whatever the user
     picked in the per-token-override panel.

  2. **`colorBand(hex)` helper + `data-color-band` /
     `data-shading-band` attributes.** New exported helper
     classifies a 6-hex RGB into `dark` (perceived luminance
     `(0.299r + 0.587g + 0.114b) / 255 < 0.4`) or `light`.
     `font_color` and `shading` `toDOM` each emit a band
     attribute on the rendered span. Threshold tuned so the
     common Word sentinels — `000000` (lum 0), `0563C1`
     hyperlink blue (~0.32), dark grays / reds — land in
     `dark`, and mid-gray (`888888` ~0.53) onward stays
     `light` (user-intentional choices preserved).

  3. **Shading mandates contrast like highlight does.** CSS:
     `.ProseMirror [data-shading-band="light"] { color: #000; }`
     and the dark counterpart. Mirrors the per-named-color
     rules on `.pmd-highlight` for arbitrary hex shading.
     Always-on (not dark-mode-gated) because shading is doc
     data and needs contrast in any theme.

  4. **`--pmd-c-link` token + dark-band override + container
     scoping.** Light mode `#0563C1` (matches Word); dark
     mode `#7AB0FF` (bright sky blue, ~0.71 luminance).
     `.ProseMirror a` uses the token with `!important` so it
     beats the canonical Word-blue `font_color` marks Word
     stamps onto hyperlink runs. In dark mode + apply-to-doc,
     `[data-color-band="dark"]` falls back to `--pmd-c-text`
     via `!important`, catching dark-band font_color marks
     anywhere in the doc. Three higher-specificity rules
     reverse the override inside `.pmd-highlight`,
     `[data-shading-band]`, and `<a>` so those containers'
     mandated colors win (otherwise the override would make
     yellow-shaded text white-on-yellow, etc.).

  Round-trip unchanged: exporter reads `attrs.color`,
  importer / `parseDOM` read `data-color` / `data-shading`,
  neither touches inline style or `data-*-band`.

  Verified end-to-end via CDP on the 1NC v. Dartmouth doc:
  108/108 shading runs compute high-contrast (`color: #000` on
  the yellow shading), all 503 highlight runs compute
  high-contrast per their named highlight, 9/16 link runs
  render in sky blue and 7 render black because they sit
  inside `.pmd-highlight` spans where black-on-yellow contrast
  takes priority over link visibility (acceptable — the
  highlight rule already preserves readability and the link
  is still clickable). Six new test cases in
  `tests/schema/schema.test.ts` lock the contracts: the
  `000000` style skip, the `data-color-band` luminance buckets
  (`000000`/`0563C1`/`FF0000` → `dark`; `888888`/`FFFFFF`/
  `FFFF00` → `light`), and the shading band attribute on
  `toDOM`.

- **Underline color matches text color inside highlights and
  shading.** Follow-up to the dark-mode-readability work above.
  `.pmd-underline` / `.pmd-emphasis` are outer to highlight /
  shading in the mark stack (underline_mark at schema position 117,
  highlight at 311, shading at 271 — earlier-defined marks render
  outermost in the DOM). The text-decoration line is painted by the
  outermost element, and its `text-decoration-color` defaults to
  that element's `color` — which in dark mode is the themed light
  body text. So an underlined-highlighted run renders as black text
  on yellow (correct), with a white underline cutting through it
  (wrong). Added two `:has()` rule sets in `style.css` that set
  `text-decoration-color` on `.pmd-underline` / `.pmd-emphasis` (and
  `.pmd-cite` under the `citeUnderlined` flag) when they contain a
  highlight or shading band: black for light-band containers
  (yellow / green / cyan / magenta / red / lightGray highlight,
  `data-shading-band="light"`), white for dark-band containers
  (blue / darkBlue / darkCyan / darkGreen / darkMagenta / darkRed
  / darkYellow / darkGray / black highlight, `data-shading-band="dark"`).
  Verified on 1NC v. Dartmouth: 232 underline-inside-highlight/shading
  spans now paint `rgb(0, 0, 0)` underlines (correct against the
  yellow backgrounds in that doc); plain underlines outside any
  band still paint with themed body color so they read as light on
  the dark surface.

- **Native form controls render in dark mode.** The body-font
  dropdown in Settings → Appearance was painting its `<select>`
  with `var(--pmd-c-bg)` (dark in dark mode) but had no explicit
  text `color`, and the dropdown popup was being drawn by the
  browser in its OS-default light style — black option text on
  white in a UI surrounded by dark chrome. Two fixes: (1) set
  `color: var(--pmd-c-text)` on `.pmd-body-font-select` so the
  collapsed value is readable; (2) declare `color-scheme: dark`
  on `:root[data-theme="dark"]` so the browser draws every
  native form control (popup option lists, scrollbars, native
  date/color pickers, etc.) in its dark variant. Not gated on
  apply-to-document — native form controls only appear in chrome
  surfaces, never inside the ProseMirror editor, so the
  doc-area-stays-light mode doesn't need a light counterpart.
  Verified: `getComputedStyle(html).colorScheme === "dark"` and
  the select reports `color: rgb(230, 230, 230)` /
  `background: rgb(26, 26, 26)` in dark mode.

- **Sky-blue hyperlink color is now gated on apply-to-document.**
  Follow-up to the readability-guarantee work: the dark-mode
  `--pmd-c-link: #7AB0FF` override was set at `:root[data-theme=
  "dark"]` scope and so applied to the editor whenever the theme
  was dark — including when "Apply theme to the document area" was
  OFF and the document was rendering as light paper. Word's
  canonical hyperlink blue (`#0563C1`) is the right color against
  a white doc, so the sky-blue override leaked the wrong palette.
  Fix: add `--pmd-c-link: #0563C1` to the existing
  `:root[data-theme="dark"]:not([data-theme-doc="dark"]) :is(#editor,
  .pmd-pane-editor)` rule that already re-declares the other light-
  mode tokens for the editor scope when apply-to-doc is off. The
  chrome scope keeps `#7AB0FF` in dark mode (no chrome surface
  actually uses the token, but the symmetry is correct). Verified
  via CDP: dark + off → editor link computes `rgb(5, 99, 193)`;
  dark + on → editor link computes `rgb(122, 176, 255)`.

- **"Dark chrome, light document" mode actually paints the document
  area white, across the full scroll, in both single-doc and
  multi-pane.** The CSS rule that scopes light-mode-token
  redeclarations inside `:is(#editor, .pmd-pane-editor)` under
  `:root[data-theme="dark"]:not([data-theme-doc="dark"])` redefined
  `--pmd-c-bg: #fff` at the editor scope, but nothing in that rule
  applied the token to the editor's own paint — `#editor` /
  `.pmd-pane-editor` carry no `background` declaration of their own,
  so they inherited body's `background: var(--pmd-c-bg)` which
  resolves to `#1a1a1a` in dark mode. The editor read as black-on-
  dark even though the user explicitly opted OUT of "Apply theme to
  the document area." Two coordinated paints land the fix:

  1. **`background: var(--pmd-c-bg)` on `:is(#editor, .pmd-pane-editor)`**
     within the same scoped rule, so the scoped `--pmd-c-bg: #fff`
     actually applies to the editor's box. This covers single-doc
     entirely — `body` is its scroller, `#editor` sits inside the
     flex layout, and `#editor`'s painted box extends with the
     content.

  2. **`background: #fff` on `.pmd-pane-body`** in the same scoped
     rule. Multi-pane's per-pane editor surface (`.pmd-pane-editor`)
     is sized `height: 100%` of its parent `.pmd-pane-body` — which
     is the `overflow-y: auto` scroller bounded to the pane's
     viewport. So `.pmd-pane-editor`'s painted white box only
     covered the visible viewport portion; ProseMirror content
     overflows past that box and the dark `.pmd-pane-body` showed
     through under the overflowed content as the user scrolled.
     Painting `.pmd-pane-body` itself covers the full scrollable
     extent (container backgrounds in `overflow: auto` paint behind
     the visible viewport at every scroll position).

  The body / ribbon / nav / status-bar chrome around the editor
  stays dark because their backgrounds resolve `--pmd-c-bg` from
  the root scope (`#1a1a1a`) — the redeclare only escapes into the
  editor scope. Per-token Accessibility-panel overrides of
  `--pmd-c-bg` still win for single-doc because the `#editor`
  paint uses the token, not a literal hex.

- **Nav pane reads in solid white in dark mode.** The per-level grey
  cascade (level-4 → `--pmd-c-text-muted`, level-1/2/3 → inherited
  body text) and the analytic-blue label (`--pmd-color-analytic`)
  rendered as inconsistent dim entries against the dark chrome
  surface, and the "No headings." empty-state message disappeared
  into the background at `--pmd-c-text-faint` (#7a7a7a in dark
  mode). Added a dark-mode-scoped block that sets `color:
  var(--pmd-c-text-strong)` on the nav-panel container, the empty
  state, the level-4 entries, and the analytic label / hover —
  covering both single-doc (`.pmd-nav-panel`) and multi-pane
  (`.pmd-multi-nav`) layouts. Light mode is unchanged. The
  in-flight wishlist item "Setting: disable nav-pane formatting"
  will let users opt out of the per-type formatting in light mode
  too when shipped; this fix is the dark-mode-specific tactical
  flatten.

- **Web-edition Open button: selection no longer silently dropped.**
  Clicking the 📂 button on the web edition would open the OS
  file picker, let the user pick a file, then do nothing. `Ctrl-O`
  worked on the same page. Root cause: `BrowserHost.openOnce` had
  a focus-event-plus-200ms-setTimeout heuristic to detect
  cancellation — when the dialog closed and the window regained
  focus, the timer fired 200ms later and checked `input.files`.
  If the browser hadn't populated `input.files` by then (which
  varies with the previously-focused element — the button vs.
  editor — and with OS dialog implementation), the timer
  resolved the promise to `null`, then the actual `change` event
  fired but ran into `settled=true` and dropped on the floor.
  Keyboard `Mod-O` happened to win the race; mouse-button click
  reliably lost it on Chrome 148+ on Linux and on Zen (Firefox
  fork). Fix: replace the focus-and-timeout polling with the
  native `cancel` event (Chrome 113+, Firefox 91+, Safari 16.4+),
  which fires only when the user actually dismisses the picker
  without picking. No race. The byte-identical code in alpha.1
  was already buggy; nothing changed in this file between
  releases — what likely shifted was timing pressure elsewhere
  on the page (timer UI mount, dark-mode boot, find-replace
  decorations) that pushed the focus event past the
  `input.files` population threshold often enough that the
  symptom started manifesting reliably.

## 0.1.0-alpha.2 — 2026-05-20

- **Nav-pane navigation: dramatically faster on big docs.**
  Clicking a heading in the nav pane used to pay a full-doc
  layout pass on every click — about 2 seconds on a 2000-card
  debate file, paid regardless of whether the destination was
  already on screen. The scroll algorithm now does an optimistic
  `scrollIntoView` against whatever layout state already exists,
  then iteratively refines (up to 10 frames) when cv:auto's
  placeholder heights caused the first try to land imprecisely.
  Result: clicks where the target heading is already visible
  cost a few ms; clicks into fresh regions of the doc pay only
  what cv:auto would have charged anyway for materializing the
  destination, instead of re-laying-out the entire doc each
  time. The per-keystroke editing-perf win from cv:auto is
  preserved end-to-end (we no longer flip it off at all).
- **Chrome scale — Mod-Alt-= / Mod-Alt-- / Mod-Alt-0.** Three
  new keybindable commands (`chromeScaleUp` / `chromeScaleDown`
  / `chromeScaleReset`) that scale the whole window — chrome
  AND doc content together — the same way the browser's built-
  in Ctrl-+ chord does. On Electron this drives Chromium's
  `webFrame.setZoomFactor`, so layout reflows at the new
  factor rather than just resizing pixels. Helpful on high-DPI
  displays where the chrome reads too small, or low-DPI where
  it crowds the editor. No-op on the web edition (use the
  browser's own page-zoom). No ribbon button — keyboard-only
  (the chord is shown in Settings → Keybindings and can be
  rebound). The editor's existing `Mod--` / `Mod-=` zoom stays
  separate, so you can dial doc content size up or down on top
  of the page-zoom factor.
- **Bug fix — Nav-pane drag drop-back precision.** When you grab
  a heading in the nav pane, the pane inserts thin drop-indicator
  bars between every entry to show valid drop slots. The cursor
  still followed the pickup pill, but the pile-of-indicators
  above the source heading pushed the source's slot down out from
  under the cursor — so releasing without moving (a "drop it back
  where it came from" gesture) landed the heading in a sibling
  slot instead. The source `<li>` now anchors at its original
  screen-Y for the duration of the drag, so a no-move release
  reliably drops back into the original slot. Other entries
  still shift down by the full indicator stack, so the nav pane
  still visibly expands at drag-start (the affordance you'd
  expect).
- **Bug fix — Multi-pane → single-window switch was losing open
  docs.** Toggling from the three-pane workspace back to one-doc-
  per-window only restored the active pane; the others were
  silently dropped. Root cause was a journal-write race: two IPC
  writes to the same crash-recovery file could land at once,
  producing a valid-JSON-then-garbage file that the post-reload
  reader threw out as corrupt. Writes are now serialized per uid
  and committed via an atomic rename, so journals stay valid even
  under concurrent edit-debounce + mode-switch traffic.
- **Accessibility — Reduce motion.** Settings → Accessibility →
  Reduce motion: System / On / Off. System (default) follows the
  OS `prefers-reduced-motion` preference. On flattens all
  animations and transitions in the UI (drag-pickup vacuum,
  popover slides, save-flash pulse, smooth scrolls) to effectively
  instant. Off forces full motion even when the OS asks for
  reduced — useful for users on an OS where the setting is
  always-on but they prefer animations in this app.
- **Accessibility — Body-font readability presets.** The Settings
  → Appearance → Body font dropdown now groups options by
  category, with "Recommended for readability" leading. Three
  bundled SIL OFL fonts ship with the app so every install has
  a readability-tuned choice regardless of what's on the host OS:
  **Atkinson Hyperlegible** (Braille Institute; designed for low
  vision, disambiguated letter pairs), **Lexend** (Font Bureau;
  the readability-tuned sans-serif with the strongest positive
  reading-speed evidence among "dyslexia fonts"), and
  **OpenDyslexic** (weighted-bottom shapes; preferred by some
  dyslexic readers — independent studies have NOT shown
  reading-speed improvements vs. Arial, but the option is
  popular). The British Dyslexia Association's 2023 endorsed
  system sans-serifs (Verdana, Tahoma, Comic Sans MS) follow
  when installed; remaining groups are "Microsoft Office
  defaults", "Apple defaults", "Open-source / cross-platform",
  and "Generic". Groups whose fonts aren't available are hidden.
- **"Open with CardMirror" actually opens the file on desktop.**
  `.docx` and `.cmir` are now registered file associations in the
  electron-builder config, so the installers wire up CardMirror
  as a right-click "Open with…" target (and as the default-app
  candidate for both extensions). The main process gained a
  single-instance lock plus open-file / second-instance / argv
  handling so double-clicking a registered file in Finder /
  Explorer / a file manager opens that file in CardMirror —
  spawning a new window when the app is already running, or
  launching directly into the file if the app wasn't open. Web
  edition unchanged.
- **Built-in countdown timer.** Native replacement for Verbatim's
  bundled timer. New ⏱ button in the right side of the ribbon
  (next to ⚙) toggles a timer panel into the ribbon's left edge.
  The panel has a big speech-timer display, Start/Pause, three
  speech-duration presets (default 9/6/3 minutes), Aff and Neg
  prep clocks (default 10 minutes each, blue and red), and a
  Reset column that re-fills the prep balances. Click a preset
  to load it (paused — hit ▶ to start). Click Aff or Neg to make
  that side's prep clock the active countdown. Type into the big
  display while paused to set a custom duration. Prep balances
  persist across closes; speech timer doesn't. Cross-window
  sync via BroadcastChannel — open the timer in two windows
  AND the visibility toggle in lockstep too: arming the panel
  in one window opens it in every CardMirror window. New
  Settings → Appearance entries:
  **Timer profile** (High school 3/5/8 + 8 min prep, College
  3/6/9 + 10 min prep, Pomodoro 25/15/5). Each profile's
  three preset durations and prep length are independently
  editable in Settings — pick a profile, then dial the four
  numbers to whatever your league actually uses. Switching
  profiles refills the prep clocks to that profile's total.
  **Compact timer layout** (drops the preset buttons, tucks
  Reset under Start). **Flash timer when countdown is low**
  (flashes the display red as remaining drops below 5 / 3 / 1
  seconds; the flash thresholds are editable too). **Prep
  side label** (Both / Text / Color) — controls how the Aff /
  Neg sides are labeled, with a color-only mode for a quieter
  panel.
- **"About this install" block at the bottom of Settings →
  General.** A read-only diagnostic section below a divider
  showing app version, host (Desktop / Web), operating system,
  and the full user-agent string — easy to copy-paste into a bug
  report. On desktop, two action buttons live underneath:
  **Check for updates** (mirrors Help → Check for Updates…,
  toast surfaces the result) and **Open crash dumps folder**
  (mirrors the Help-menu item) so both actions are now reachable
  from Settings.
- **Every ribbon action is now bindable.** Twelve previously
  click-only ribbon actions are now registered commands in the
  keybinding registry, available in Settings → Keybindings. None
  ship with a default binding — they're all already reachable via
  the ribbon, so a default chord would just be noise. The new
  bindable commands: increase / decrease font size by 1 pt,
  apply font color, open settings, toggle paragraph integrity,
  open each color picker dropdown (highlight / shading / font
  color), open the font-size picker, and open the doc / card /
  table tools menus.
- **Active doc filename in a ribbon pill (opt-in).** New Settings
  → Appearance → "Show doc name in ribbon" toggle (default off).
  When on, the active doc's filename appears as a pill centered in
  the ribbon between the comments toggle and the settings button.
  Useful on platforms / layouts where the OS title bar isn't
  visible: tiling window managers without decorations,
  hidden-title-bar themes, web edition embedded in another page,
  etc. Long filenames ellipsis-truncate with the full name in the
  tooltip. The chip hides when there's no filename yet
  (untitled / fresh doc before Save-As), in multi-pane mode (each
  per-pane chip already shows the slot's doc), and falls out of
  the ribbon's progressive-hide cascade between paragraph styles
  and the format-menu cluster when the ribbon runs out of room.
- **Multi-pane window title summarizes all open slots.** The OS
  window title in multi-pane mode used to show just the focused
  doc's filename. It now shows every non-empty slot's filename
  joined by `·` — e.g. "Foo · Bar — CardMirror" — so the title
  bar conveys the whole workspace at a glance rather than
  changing with every focus shift. Single-doc mode unchanged.
- **Fixed: Copy Last Cite now finds cite_mark text you just
  applied.** Adding the cite mark to a word in a body paragraph
  is supposed to promote that paragraph to a `cite_paragraph`
  (the cite classifier plugin does this automatically). But the
  classifier was gated on a "did the doc change?" range that
  excluded mark-only transactions — `AddMarkStep` doesn't shift
  any positions, so its step-map was empty and the classifier
  bailed early. Result: the paragraph stayed a regular
  `paragraph`, and Copy Last Cite fell through to whatever older
  `cite_paragraph` it could find further up the doc. The same
  silent-skip affected the named-style normalizer (it would
  miss underline/cite/emphasis conflicts created via mark-add
  transactions). Both now see mark-only transactions.
- **F8 / Apply Cite Style now expands to the word at the cursor**
  when there's no selection — matching the behavior F10 / Apply
  Emphasis Style already had. Previously pressing F8 with the
  cursor in a word silently did nothing; users had to double-click
  to select the word first.
- **Fixed: Underline / Emphasis font-size settings were dead.**
  Settings → Styles → font size for the Underline and Emphasis
  styles did write a CSS variable, but no CSS rule consumed it, so
  the change was silently dropped. The marks now pick up
  `--pmd-size-underline` / `--pmd-size-emphasis` and behave like the
  other per-style size knobs.
- **Image alt text is now editable and round-trips through Word.**
  Three changes that ship together:
  - Right-clicking an image shows a new **Edit alt text…** menu item
    (above the AI options, always enabled). Opens a multi-line dialog
    pre-filled with the current alt text; saving writes the new value
    back to the image node and survives docx export.
  - The OOXML importer now reads `wp:docPr@descr` (with `pic:cNvPr@descr`
    as a fallback for older producers) into `image.attrs.alt`. Previously
    the importer dropped alt text on the floor; exporting was the only
    half of the round-trip that worked.
  - The AI alt-text generator now updates `image.attrs.alt` as well as
    inserting the visible `[ALT TEXT: …]` bracket. If the image already
    has alt text on its attribute, the AI command pops a dialog
    showing the existing alt text and offers **Keep current** (copy it
    to a bracket below the image, no API call) or **Regenerate with
    AI** (overwrite both the attribute and the bracket).
- **Dark mode.** Settings → Appearance → Theme: Light / Dark /
  System (default). System mode tracks the OS-level
  `prefers-color-scheme` and switches live when the user changes
  their system appearance. Sibling toggle, **Apply theme to the
  document area**, defaults off — the chrome (ribbon, nav, status
  bar, settings panels) follows the dark theme but the document
  itself stays light / paper-like. Flip on for full dark. User
  per-token color overrides win over either theme via inline
  style on `<html>`.
- **Accessibility settings section** (new tab, far right of the
  Settings dialog).
  - Highlight + shading display overrides moved here from
    Appearance. Replaced the single-color picker with **1–3
    ordered slots** that map to source colors by usage
    frequency. Slot 1 → most-common color in the doc, slot 2 →
    second-most-common, last slot = catch-all for everything
    else. Frequency ranking is incremental + debounced, and
    inactive when only one slot is set, so big docs don't pay
    perf cost unless they're using the multi-color feature.
  - **Per-token color overrides** panel: every UI color in the
    interface (background, borders, accent, hover, status, find
    decorations, table chrome, etc.) is overridable with a
    color picker + alpha slider. Reset-per-row + reset-all
    affordances. Overrides win over the active theme and any
    future preset (high-contrast, colorblind-friendly, etc.).
- **Cursor-position color readout** on the status bar. Visible
  only when an override is on. Shows the ACTUAL stored colors on
  the run at the cursor ("Hl: Yellow · Sh: Protected Grey") so
  you don't lose awareness of what's encoded in the doc while
  the override hides it from view.
- New setting: **default file format for new docs**. Pick `.docx`
  (default — Word- / Verbatim-compatible) or `.cmir` (CardMirror's
  native format, enables autosave); the Save-As dialog defaults to
  that format for any doc that doesn't yet have an on-disk handle.
  Existing files on disk still re-save in whatever format they were
  opened from.
- New setting: **jump to doc top when read mode toggles**. Off by
  default (today's stay-put behavior). When on, toggling read mode
  in either direction scrolls to the top of the doc and places the
  cursor at the start.
- Zoom in / out / reset and the highlight / shading paint-mode
  toggles are now registered ribbon commands, so users can bind
  them to keys via Settings → Keybindings. Default bindings:
  `Mod-=` for zoom in, `Mod--` for zoom out; `zoomReset` and the
  paintbrush toggles ship unbound (`Mod-0` is a browser-level
  reset that Chromium won't always let the page intercept, so the
  status-bar reset button remains the discoverable affordance).
- Keyboard-shortcut command labels (Settings → Keybindings) now
  use consistent title casing across the board.
- **Find and Replace** (Ctrl-F / Ctrl-H / Alt-F). Floating bar in
  the upper-right with case-sensitive and whole-word toggles,
  next / prev navigation, a match count, Replace, and Replace
  All. Every match is highlighted in light yellow; the
  currently-active one gets a stronger orange band. Escape
  closes and restores editor focus.

  Result ordering:
  - **Ctrl-F** (categorized): hits in headings come first, then
    tags, then cites, then everything else. Within each group,
    the closest match to your cursor ranks first (cursor counts
    as the top — matches after wrap around to matches before).
    The category priority is reorderable in Settings → General.
  - **Alt-F** (proximity-only): ignores categories — just orders
    by proximity to the cursor.
  - **Ctrl-H** opens the find+replace bar with the same
    categorized ordering as Ctrl-F.

  Surfaces beyond the floating bar:
  - **Expandable results panel** below the bar — toggles open
    via a chevron, lists every match with surrounding context,
    and clicking an entry jumps to it. Open/closed state
    persists per session via `findResultsExpanded`.
  - **Nav-pane integration** — outline entries whose subtree
    contains a match get a small accent decoration, so you can
    see at a glance which sections of the doc match the current
    query without scrolling through results.
  - **Scope** — search can be restricted to a range (e.g. the
    current selection) instead of the whole doc. Toggling the
    scope chip clears it.
- Re-pressing a heading shortcut (F4 / F5 / F6 / F7 / Mod-F7 /
  Mod-F8) on a paragraph that already has that heading style now
  strips the paragraph's indentation while keeping the heading
  style and all other formatting intact, instead of being a
  no-op.
- Opening a doc now starts both the editor and the nav pane
  scrolled to the top, instead of inheriting the previous doc's
  scroll position.
- A "New document" window spawned while CardMirror is already
  running no longer offers to "recover" the docs you have open
  in other windows. Only the first window of an app session
  surfaces the startup-recovery sidebar.
- The navigation pane can now be hidden. Three ways to toggle:
  the new ☰ button in the View tools section of the ribbon, the
  × close button in the top-right of the nav pane itself, and a
  small pull-tab pinned to the left edge of the viewport (only
  visible when the nav pane is hidden). State is per-window; in
  multi-doc mode the toggle applies to all panes' nav at once.
- The word-count selection button (Σ) moved off the ribbon to
  the left edge of the status bar, next to the live read-aloud
  word counter — same family of question, fewer ribbon buttons.
- Zoom-strip controls (zoom in/out/reset + word-count) are
  slightly smaller and stay centered on the bar.
- Triple-click + drag now extends the selection paragraph-by-
  paragraph (instead of switching back to character-level on the
  first move). Matches Word and most browsers' contenteditable
  default.
- Right-clicking a link now opens a context menu (Open Link /
  Copy Link Address / Edit Link… / Remove Link). Open routes
  through the OS default browser via `shell.openExternal` on
  desktop; Edit reuses the in-app text prompt; Remove strips the
  link mark while preserving the text. Non-link right-clicks
  pass through to the browser / image context menu as before.
- Paint mode (highlight / shading paintbrush) now shows an I-beam
  precision cursor with a small swatch of the active color, so
  you can target characters precisely AND see which color the
  next paint will apply. Picking a new color while paint mode is
  armed updates the cursor live.
- Text selection inside the editor is now translucent (~30%
  alpha) instead of fully opaque, so the underlying highlight,
  shading, and other colors show through. Side effect: you can
  now tell at a glance whether selected text is currently
  highlighted (F11) — the highlight color shows through the
  selection overlay instead of being hidden by it.
- Clicking an image now shows a visible selected state — a 2px
  accent outline so it's obvious the click registered before
  pressing Delete / Copy. Unsupported-format placeholder spans
  also get a subtle background tint when selected.
- The caret no longer hides behind the fixed ribbon (top) or
  status bar (bottom) after Enter / arrow / new-heading actions.
  The browser's auto-scroll-into-view now reserves space for both
  fixed bars via `scroll-padding`.
- Legacy Verbatim character-style ids are now recognized on import
  — pre-modern distributions used `StyleBoldUnderline` for the
  underline mark and `StyleStyleBold12pt` for the cite mark. Files
  from those distributions (e.g. 2013-14 era debate evidence) now
  import with their underlining and cites intact instead of
  silently losing them. Export still normalizes to the current
  styleIds, so re-saving an old file cleans up the rStyle output.
- The AI alt-text generator now ships surrounding context with the
  image — the enclosing card's tag and cite, plus the paragraphs
  immediately before and after the image — so descriptions reflect
  what the image is *doing* in the argument instead of generic
  "a chart with bars" captions.
- Shift-F3 (cycle case) now keeps the selection after each press,
  so the user can re-press to advance to the next case state
  (lower → UPPER → Title → lower) without re-selecting.
- Speech-doc designation now uses the same warm-gold accent in both
  single-window multi-window mode (the banner under the ribbon) and
  single-window multi-pane mode (the per-pane chip), so the "this
  is the speech doc" affordance reads the same regardless of window
  topology.
- The window can now shrink to any size — the previous 800×600
  Electron floor is gone, so the status bar (zoom strip) stays
  on-screen on small / tiled / split-screen layouts. Ribbon
  panels hide progressively when there's literally no room left.
  The cascade is 11 steps, least-essential first: character
  styles → structural styles → doc-name chip → format menu →
  table / image / sub / sup / strike cluster → font-size step
  buttons → highlight + shading + font color panel → comments
  toggle + add-comment → file-ops buttons (Open / New / Save /
  Autosave) → read-mode + nav-pane toggle → settings gear +
  keyboard-shortcut button. The timer toggle (⏱) stays outside
  the cascade so it's always reachable mid-round. The hide/show
  is measurement-driven (not media-query breakpoints), so it
  adapts to chrome scale, OS font size, and which panels are
  even visible to begin with.
- Ribbon cleanup: the plain-paste toggle (`T`) is hidden on desktop
  (F2 reads the clipboard directly there — no armed state to show),
  and the autosave toggle (⏱) is hidden on the web edition
  (autosave requires an on-disk file handle, which the browser
  can't provide).

## 0.1.0-alpha.1 — 2026-05-16

First downloadable preview of CardMirror. **This is an alpha.**
Expect bugs, missing features, and occasional breakage. Don't use
it for tournament-day work yet; keep a Verbatim copy of anything
important.

What works:

- Open and save Microsoft Word `.docx` files. Round-trips against
  Verbatim-format docs.
- Native `.cmir` format for lossless save / restore (no Word
  conversion costs, autosave-eligible).
- Verbatim-parity editing model: Pocket / Hat / Block / Tag /
  Analytic / Undertag styles, F-key shortcuts, condense /
  uncondense / case-toggle, emphasis / underline / highlight,
  shrink, send-to-speech, paste-as-plain.
- Multi-doc workspace — pick between a three-pane single-window
  layout or one window per doc.
- Send-to-speech across windows in multi-window mode.
- Per-doc read mode and autosave.
- Crash-recovery journal — unsaved drafts come back on next
  launch.
- Word-style left navigation pane: outline view, multi-select,
  drag-reorder.

Not in this release (planned):

- Full-text and schema-aware search across open docs / the
  evidence library on disk.
- Transclusion (live-linked content from a source doc).
- Cross-window drag-and-drop. (Cross-pane drag within multi-pane
  mode works.)

Operational:

- **Crash dumps** are collected locally to disk only — never
  uploaded anywhere. If CardMirror crashes and you want to send
  a report, open *Help → Open Crash Dumps Folder* and attach
  the minidump to a GitHub issue.
- **Auto-update**: on launch, CardMirror checks GitHub Releases
  for a newer version and downloads it in the background. When
  one's ready, a dialog asks whether to restart now or install
  on next quit. *Help → Check for Updates…* triggers the same
  check on demand.

Platforms:

- **macOS** — `.dmg` for Intel (x64) and Apple Silicon (arm64).
- **Windows** — NSIS installer (`.exe`) for x64.
- **Linux** — `.AppImage` (distribution-agnostic) and `.pacman`
  (Arch-native; install with `sudo pacman -U file.pacman`) for
  x64.

Known gaps:

- Desktop builds are unsigned. First-launch warnings on
  Windows (SmartScreen) and macOS (Gatekeeper) require a
  right-click → Open. See README.
