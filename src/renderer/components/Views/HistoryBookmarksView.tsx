import React, { useEffect, useState } from 'react'
import { Bookmark, Clock, Plus, Search, Trash2 } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'

export const HistoryBookmarksView: React.FC<{ initialMode?: 'history' | 'bookmarks' }> = ({
  initialMode = 'history'
}) => {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const bookmarks = useAppStore((s) => s.bookmarks)
  const history = useAppStore((s) => s.history)
  const refreshBookmarks = useAppStore((s) => s.refreshBookmarks)
  const refreshHistory = useAppStore((s) => s.refreshHistory)

  const [mode, setMode] = useState<'history' | 'bookmarks'>(initialMode)
  const [query, setQuery] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newUrl, setNewUrl] = useState('')

  useEffect(() => {
    void refreshBookmarks()
    void refreshHistory()
  }, [])

  const handleSearchHistory = (val: string): void => {
    setQuery(val)
    void refreshHistory(val)
  }

  const handleAddBookmark = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!newUrl.trim()) return
    const url = newUrl.trim().startsWith('http') ? newUrl.trim() : `https://${newUrl.trim()}`
    await window.streamgrab.bookmarks.add({
      url,
      title: newTitle.trim() || url
    })
    setNewTitle('')
    setNewUrl('')
    await refreshBookmarks()
  }

  const openUrl = (url: string): void => {
    if (activeTabId) {
      void window.streamgrab.tabs.navigate(activeTabId, url)
    } else {
      void window.streamgrab.tabs.create({ url, activate: true })
    }
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-zinc-950 p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode('history')}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
                mode === 'history'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900'
              }`}
            >
              <Clock className="h-4 w-4 text-sky-400" /> Browsing History
            </button>
            <button
              type="button"
              onClick={() => setMode('bookmarks')}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
                mode === 'bookmarks'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900'
              }`}
            >
              <Bookmark className="h-4 w-4 text-amber-400" /> Saved Bookmarks ({bookmarks.length})
            </button>
          </div>

          {mode === 'history' && history.length > 0 && (
            <button
              type="button"
              onClick={async () => {
                await window.streamgrab.history.clear()
                await refreshHistory()
              }}
              className="flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/20"
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear All History
            </button>
          )}
        </div>

        {mode === 'history' ? (
          <>
            <div className="relative">
              <Search className="absolute left-3.5 top-2.5 h-4 w-4 text-zinc-500" />
              <input
                type="text"
                value={query}
                onChange={(e) => handleSearchHistory(e.target.value)}
                placeholder="Search visited pages (Private/Incognito tabs are never logged)..."
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900 pl-10 pr-4 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
              />
            </div>

            <div className="space-y-2">
              {history.length === 0 ? (
                <p className="py-12 text-center text-xs text-zinc-500">No browsing history recorded.</p>
              ) : (
                history.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-2.5"
                  >
                    <button
                      type="button"
                      onClick={() => openUrl(item.url)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-xs font-medium text-zinc-100">{item.title}</p>
                      <p className="truncate text-[11px] text-zinc-500">
                        {item.url} • {new Date(item.visitedAt).toLocaleString()} ({item.visitCount}{' '}
                        visit{item.visitCount > 1 ? 's' : ''})
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await window.streamgrab.history.deleteItem(item.id)
                        await refreshHistory(query)
                      }}
                      className="rounded p-1.5 text-zinc-500 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <form
              onSubmit={(e) => void handleAddBookmark(e)}
              className="flex flex-wrap gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3"
            >
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Title (optional)"
                className="w-48 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
              />
              <input
                type="text"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://example.com"
                className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
              />
              <button
                type="submit"
                className="flex items-center gap-1 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400"
              >
                <Plus className="h-3.5 w-3.5" /> Add Bookmark
              </button>
            </form>

            <div className="space-y-2">
              {bookmarks.map((bm) => (
                <div
                  key={bm.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-2.5"
                >
                  <button
                    type="button"
                    onClick={() => openUrl(bm.url)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-xs font-medium text-zinc-100">{bm.title}</p>
                    <p className="truncate text-[11px] text-zinc-500">{bm.url}</p>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await window.streamgrab.bookmarks.remove(bm.id)
                      await refreshBookmarks()
                    }}
                    className="rounded p-1.5 text-zinc-500 hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
