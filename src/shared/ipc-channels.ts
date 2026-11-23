export const IPC_CHANNELS = {
  // Tabs & Navigation
  TABS_GET_STATE: 'tabs:get-state',
  TABS_CREATE: 'tabs:create',
  TABS_CLOSE: 'tabs:close',
  TABS_ACTIVATE: 'tabs:activate',
  TABS_NAVIGATE: 'tabs:navigate',
  TABS_GO_BACK: 'tabs:go-back',
  TABS_GO_FORWARD: 'tabs:go-forward',
  TABS_RELOAD: 'tabs:reload',
  TABS_TOGGLE_MUTE: 'tabs:toggle-mute',
  TABS_OPEN_INTERNAL: 'tabs:open-internal',
  TABS_UPDATED: 'tabs:updated',

  // Layout (Side Panel & Overlays vs WebContentsView bounds)
  LAYOUT_SET_SIDE_PANEL: 'layout:set-side-panel',
  LAYOUT_SET_MODAL_OPEN: 'layout:set-modal-open',

  // Adblock Shield & Popup Blocker
  ADBLOCK_TOGGLE_GLOBAL: 'adblock:toggle-global',
  ADBLOCK_TOGGLE_DOMAIN: 'adblock:toggle-domain',
  ADBLOCK_GET_STATUS: 'adblock:get-status',
  POPUP_BLOCKED_EVENT: 'popup:blocked',

  // Media Sniffer & Extractor
  MEDIA_GET_FOR_TAB: 'media:get-for-tab',
  MEDIA_CLEAR_FOR_TAB: 'media:clear-for-tab',
  MEDIA_DEEP_ANALYZE_YTDLP: 'media:deep-analyze-ytdlp',
  MEDIA_UPDATED: 'media:updated',

  // Headless Paste-URL Sniffer
  HEADLESS_START_PROBE: 'headless:start-probe',
  HEADLESS_CANCEL_PROBE: 'headless:cancel-probe',
  HEADLESS_GET_JOBS: 'headless:get-jobs',
  HEADLESS_UPDATED: 'headless:updated',

  // Downloads
  DOWNLOADS_START_FROM_MEDIA: 'downloads:start-from-media',
  DOWNLOADS_GET_ALL: 'downloads:get-all',
  DOWNLOADS_PAUSE: 'downloads:pause',
  DOWNLOADS_RESUME: 'downloads:resume',
  DOWNLOADS_CANCEL: 'downloads:cancel',
  DOWNLOADS_DELETE: 'downloads:delete',
  DOWNLOADS_OPEN_FILE: 'downloads:open-file',
  DOWNLOADS_SHOW_IN_FOLDER: 'downloads:show-in-folder',
  DOWNLOADS_CLEAR_COMPLETED: 'downloads:clear-completed',
  DOWNLOADS_UPDATED: 'downloads:updated',

  // Bookmarks & History
  BOOKMARKS_LIST: 'bookmarks:list',
  BOOKMARKS_ADD: 'bookmarks:add',
  BOOKMARKS_REMOVE: 'bookmarks:remove',
  HISTORY_LIST: 'history:list',
  HISTORY_CLEAR: 'history:clear',
  HISTORY_DELETE_ITEM: 'history:delete-item',

  // Settings & Portable Binaries
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_PICK_FOLDER: 'settings:pick-folder',
  BINARIES_CHECK_HEALTH: 'binaries:check-health',
  BINARIES_INSTALL_UPDATE: 'binaries:install-update',
  BINARIES_PROGRESS: 'binaries:progress',

  // Preload -> Main internal frame sniffer channel
  INTERNAL_SNIFFER_BLOB: 'internal:sniffer-blob',
  INTERNAL_SNIFFER_VIDEO_META: 'internal:sniffer-video-meta',
  INTERNAL_SNIFFER_DIAG: 'internal:sniffer-diag',

  // Diagnostic Flight-Recorder Logger
  DIAG_GET_STATUS: 'diag:get-status',
  DIAG_CLEAR_LOGS: 'diag:clear-logs',
  DIAG_OPEN_LOGS_FOLDER: 'diag:open-logs-folder'
} as const
