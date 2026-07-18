/**
 * Preload for the floating timer pop-out window — deliberately the
 * smallest possible surface. The pop-out runs entirely on
 * localStorage + BroadcastChannel (timer state AND settings), so the
 * ONLY thing it needs the host for is resizing its own frameless
 * window when the panel's content reflows (compact ↔ expanded
 * toggle): `resizable: false` blocks `window.resizeTo` from the
 * renderer, and the main process must apply the chrome-zoom factor
 * to the CSS-pixel measurement anyway. Nothing else is exposed.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('timerPopoutBridge', {
  /** Ask the main process to size this window to hug the given
   *  content box (CSS px; main scales by the window's zoom). */
  resizeContent: (contentWidth: number, contentHeight: number): Promise<void> =>
    ipcRenderer.invoke('host:timer-popout-resize', { contentWidth, contentHeight }),
});
