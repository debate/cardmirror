/**
 * Shared thematic grouping of `RibbonCommandId`s.
 *
 * Used by:
 * - The Keyboard Shortcuts reference modal (`reference-ui.ts`) to
 *   render its "cheat sheet" sections.
 * - The Settings → Keybindings editor (`keybindings-editor.ts`) to
 *   group the rebinding rows under the same headings so users see
 *   the same taxonomy in both surfaces.
 *
 * Single source of truth: editing this file changes BOTH surfaces.
 *
 * Drift guard: every `RibbonCommandId` must appear in exactly one
 * group below. If a new command lands in the registry without
 * being categorized, the module-load assertion throws — fail loud
 * instead of silently dropping rows from one or both surfaces.
 */

import { RIBBON_COMMAND_IDS, type RibbonCommandId } from './ribbon-commands.js';

export interface RibbonGroup {
  title: string;
  commands: RibbonCommandId[];
}

export const RIBBON_GROUPS: RibbonGroup[] = [
  {
    title: 'File',
    commands: ['newDocument', 'openFile', 'save', 'saveAs', 'toggleAutosave'],
  },
  {
    title: 'Speech',
    commands: [
      'newSpeechDocument',
      'markActiveAsSpeech',
      'sendToSpeechAtCursor',
      'sendToSpeechAtEnd',
      'selectSpeechDoc',
    ],
  },
  {
    title: 'Structural styles',
    commands: ['setPocket', 'setHat', 'setBlock', 'setTag', 'setAnalytic', 'setUndertag'],
  },
  {
    title: 'Character styles',
    commands: [
      'applyCite',
      'applyUnderline',
      'applyEmphasis',
      'emphasizeAcronym',
      'applyHighlight',
      'highlightAcronym',
      'applyShading',
      'applyFontColor',
    ],
  },
  {
    title: 'Inline formatting',
    commands: [
      'toggleBold',
      'toggleItalic',
      'toggleStrikethrough',
      'toggleSuperscript',
      'toggleSubscript',
      'adjustFontSizeUp',
      'adjustFontSizeDown',
    ],
  },
  {
    title: 'Condense',
    commands: [
      'condenseDefault',
      'condenseNoIntegrity',
      'condenseNoIntegrityWithPilcrows',
      'condenseWithWarning',
      'uncondense',
      'toggleCase',
      'toggleParagraphIntegrity',
    ],
  },
  {
    title: 'Editing utilities',
    commands: [
      'pasteAsText',
      'clearToNormal',
      'shrink',
      'copyPreviousCite',
      'createReference',
      'insertImage',
    ],
  },
  {
    title: 'Highlight tools',
    commands: [
      'standardizeHighlight',
      'standardizeShading',
      'highlightToShading',
      'shadingToHighlight',
      'togglePaintbrushHighlight',
      'togglePaintbrushShading',
    ],
  },
  {
    title: 'Color pickers & menus',
    commands: [
      'openHighlightPicker',
      'openShadingPicker',
      'openFontColorPicker',
      'openFontSizePicker',
      'openDocToolsMenu',
      'openCardToolsMenu',
      'openTableMenu',
    ],
  },
  {
    title: 'Find',
    commands: ['openFind', 'openFindReplace', 'openFindByProximity'],
  },
  {
    title: 'View',
    commands: [
      'toggleReadMode',
      'toggleNavPane',
      'wordCountSelection',
      'openSettings',
      'openShortcutsReference',
    ],
  },
  {
    title: 'Zoom & scale',
    commands: [
      'zoomIn',
      'zoomOut',
      'zoomReset',
      'chromeScaleUp',
      'chromeScaleDown',
      'chromeScaleReset',
    ],
  },
  {
    title: 'Comments',
    commands: ['toggleCommentsVisible', 'addCommentToSelection'],
  },
  {
    title: 'Multi-pane workspace',
    commands: [
      'focusSlot1',
      'focusSlot2',
      'focusSlot3',
      'sendDocToSlot1',
      'sendDocToSlot2',
      'sendDocToSlot3',
      'toggleSlotExpand',
      'closeDocOrWindow',
    ],
  },
  {
    title: 'AI',
    commands: ['aiAskAboutSelection', 'aiCreateCite'],
  },
  {
    title: 'Select',
    commands: ['selectSimilar'],
  },
  {
    title: 'Cleanup',
    commands: [
      'convertAnalyticsToTags',
      'fixFormattingGaps',
      'removeHyperlinks',
    ],
  },
  {
    title: 'Table',
    commands: [
      'insertTable',
      'addRowBefore',
      'addRowAfter',
      'addColumnBefore',
      'addColumnAfter',
      'deleteTableRow',
      'deleteTableColumn',
      'mergeTableCells',
      'splitTableCell',
      'deleteTable',
    ],
  },
];

// Drift guard: every `RibbonCommandId` must appear in exactly one
// group above. If a new command is added to the registry and
// someone forgets to update RIBBON_GROUPS, this throws at module
// load time — fail loud instead of silently dropping rows from
// the cheat sheet AND the rebinding editor.
(function assertGroupsCoverRegistry(): void {
  const placed = new Set<string>();
  const duplicates: string[] = [];
  for (const group of RIBBON_GROUPS) {
    for (const id of group.commands) {
      if (placed.has(id)) duplicates.push(id);
      placed.add(id);
    }
  }
  const missing = RIBBON_COMMAND_IDS.filter((id) => !placed.has(id));
  const extra = [...placed].filter(
    (id) => !(RIBBON_COMMAND_IDS as readonly string[]).includes(id),
  );
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`missing from RIBBON_GROUPS: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    problems.push(`in RIBBON_GROUPS but not in RIBBON_COMMAND_IDS: ${extra.join(', ')}`);
  }
  if (duplicates.length > 0) {
    problems.push(`appear in multiple groups: ${duplicates.join(', ')}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `ribbon-groups RIBBON_GROUPS / RIBBON_COMMAND_IDS mismatch:\n  - ${problems.join('\n  - ')}`,
    );
  }
})();
