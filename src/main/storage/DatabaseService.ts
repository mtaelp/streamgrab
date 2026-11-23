import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  AppSettings,
  BookmarkItem,
  DownloadChunkRecord,
  DownloadTask,
  HistoryItem
} from '@shared/types'
import { resolvePortablePaths } from '../portable/PortablePaths'

export class DatabaseService {
  private db: DatabaseSync
  private defaultDownloadsDir: string

  constructor(customDbPath?: string, defaultDownloadsDir?: string) {
    const paths = resolvePortablePaths()
    const dbPath = customDbPath ?? path.join(paths.userDataDir, 'vidgrab.db')
    this.defaultDownloadsDir = defaultDownloadsDir ?? paths.defaultDownloadsDir

    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `)
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        task_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS download_chunks (
        task_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_byte INTEGER NOT NULL,
        current_byte INTEGER NOT NULL,
        end_byte INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (task_id, chunk_index),
        FOREIGN KEY (task_id) REFERENCES downloads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS bookmarks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        favicon TEXT,
        folder TEXT NOT NULL DEFAULT 'Bookmarks Bar',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        favicon TEXT,
        visited_at INTEGER NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_downloads_created_at ON downloads(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_history_visited_at ON history(visited_at DESC);
    `)
  }

  // ==========================================
  // Settings
  // ==========================================
  public getDefaultSettings(): AppSettings {
    return {
      downloadDir: this.defaultDownloadsDir,
      maxThreadsPerDownload: 32,
      maxConcurrentDownloads: 3,
      adblockEnabled: true,
      whitelistedDomains: [],
      interceptStandardDownloads: true,
      minDirectMediaBytes: 512 * 1024, // 512 KB default noise floor
      autoRefreshExpiredTokens: true,
      searchEngine: 'duckduckgo'
    }
  }

  public getSettings(): AppSettings {
    const defaults = this.getDefaultSettings()
    const row = this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get('app_settings') as { value_json: string } | undefined

    if (!row) {
      return defaults
    }

    try {
      const parsed = JSON.parse(row.value_json) as Partial<AppSettings>
      return { ...defaults, ...parsed }
    } catch {
      return defaults
    }
  }

  public updateSettings(partial: Partial<AppSettings>): AppSettings {
    const next = { ...this.getSettings(), ...partial }
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run('app_settings', JSON.stringify(next))
    return next
  }

  // ==========================================
  // Downloads & Byte-Range Chunks
  // ==========================================
  public upsertDownload(task: DownloadTask): void {
    this.db
      .prepare(
        `INSERT INTO downloads (id, task_json, status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           task_json = excluded.task_json,
           status = excluded.status,
           completed_at = excluded.completed_at`
      )
      .run(
        task.id,
        JSON.stringify(task),
        task.status,
        task.createdAt,
        task.completedAt ?? null
      )
  }

  public getDownload(id: string): DownloadTask | null {
    const row = this.db
      .prepare('SELECT task_json FROM downloads WHERE id = ?')
      .get(id) as { task_json: string } | undefined
    if (!row) return null
    return JSON.parse(row.task_json) as DownloadTask
  }

  public getAllDownloads(): DownloadTask[] {
    const rows = this.db
      .prepare('SELECT task_json FROM downloads ORDER BY created_at DESC')
      .all() as Array<{ task_json: string }>
    return rows.map((r) => JSON.parse(r.task_json) as DownloadTask)
  }

  public markInterruptedDownloadsPaused(): DownloadTask[] {
    const all = this.getAllDownloads()
    const updated: DownloadTask[] = []
    for (const task of all) {
      if (
        task.status === 'downloading' ||
        task.status === 'queued' ||
        task.status === 'muxing' ||
        task.status === 'refreshing_token'
      ) {
        task.status = 'paused'
        task.speedBps = 0
        task.etaSec = 0
        this.upsertDownload(task)
      }
      updated.push(task)
    }
    return updated
  }

  public deleteDownload(id: string): void {
    this.db.prepare('DELETE FROM downloads WHERE id = ?').run(id)
  }

  public clearCompletedDownloads(): void {
    this.db
      .prepare("DELETE FROM downloads WHERE status IN ('completed', 'cancelled')")
      .run()
  }

  public saveChunks(taskId: string, chunks: DownloadChunkRecord[]): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM download_chunks WHERE task_id = ?').run(taskId)
      const stmt = this.db.prepare(
        `INSERT INTO download_chunks (task_id, chunk_index, start_byte, current_byte, end_byte, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      for (const c of chunks) {
        stmt.run(c.taskId, c.chunkIndex, c.startByte, c.currentByte, c.endByte, c.status)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  public updateChunkProgress(
    taskId: string,
    chunkIndex: number,
    currentByte: number,
    status: DownloadChunkRecord['status']
  ): void {
    this.db
      .prepare(
        `UPDATE download_chunks
         SET current_byte = ?, status = ?
         WHERE task_id = ? AND chunk_index = ?`
      )
      .run(currentByte, status, taskId, chunkIndex)
  }

  public getChunks(taskId: string): DownloadChunkRecord[] {
    const rows = this.db
      .prepare(
        `SELECT task_id, chunk_index, start_byte, current_byte, end_byte, status
         FROM download_chunks
         WHERE task_id = ?
         ORDER BY chunk_index ASC`
      )
      .all(taskId) as Array<{
      task_id: string
      chunk_index: number
      start_byte: number
      current_byte: number
      end_byte: number
      status: DownloadChunkRecord['status']
    }>

    return rows.map((r) => ({
      taskId: r.task_id,
      chunkIndex: r.chunk_index,
      startByte: r.start_byte,
      currentByte: r.current_byte,
      endByte: r.end_byte,
      status: r.status
    }))
  }

  // ==========================================
  // Bookmarks
  // ==========================================
  public listBookmarks(): BookmarkItem[] {
    const rows = this.db
      .prepare(
        'SELECT id, url, title, favicon, folder, created_at FROM bookmarks ORDER BY created_at DESC'
      )
      .all() as Array<{
      id: string
      url: string
      title: string
      favicon: string | null
      folder: string
      created_at: number
    }>
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      favicon: r.favicon ?? undefined,
      folder: r.folder,
      createdAt: r.created_at
    }))
  }

  public addBookmark(input: {
    url: string
    title: string
    favicon?: string
    folder?: string
  }): BookmarkItem {
    const id = crypto.randomUUID()
    const now = Date.now()
    const folder = input.folder || 'Bookmarks Bar'
    this.db
      .prepare(
        `INSERT INTO bookmarks (id, url, title, favicon, folder, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title,
           favicon = COALESCE(excluded.favicon, bookmarks.favicon),
           folder = excluded.folder`
      )
      .run(id, input.url, input.title || input.url, input.favicon ?? null, folder, now)

    const row = this.db
      .prepare('SELECT id, url, title, favicon, folder, created_at FROM bookmarks WHERE url = ?')
      .get(input.url) as {
      id: string
      url: string
      title: string
      favicon: string | null
      folder: string
      created_at: number
    }
    return {
      id: row.id,
      url: row.url,
      title: row.title,
      favicon: row.favicon ?? undefined,
      folder: row.folder,
      createdAt: row.created_at
    }
  }

  public removeBookmark(idOrUrl: string): void {
    this.db.prepare('DELETE FROM bookmarks WHERE id = ? OR url = ?').run(idOrUrl, idOrUrl)
  }

  // ==========================================
  // History (Skipped automatically for Incognito)
  // ==========================================
  public recordHistoryVisit(input: {
    url: string
    title: string
    favicon?: string
    isIncognito?: boolean
  }): void {
    if (input.isIncognito) return
    if (!input.url || input.url.startsWith('app://') || input.url.startsWith('about:')) return

    const id = crypto.randomUUID()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO history (id, url, title, favicon, visited_at, visit_count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(url) DO UPDATE SET
           title = CASE WHEN excluded.title != '' THEN excluded.title ELSE history.title END,
           favicon = COALESCE(excluded.favicon, history.favicon),
           visited_at = excluded.visited_at,
           visit_count = history.visit_count + 1`
      )
      .run(id, input.url, input.title || input.url, input.favicon ?? null, now)
  }

  public listHistory(query?: string, limit = 300): HistoryItem[] {
    let rows: Array<{
      id: string
      url: string
      title: string
      favicon: string | null
      visited_at: number
      visit_count: number
    }>
    if (query && query.trim().length > 0) {
      const like = `%${query.trim()}%`
      rows = this.db
        .prepare(
          `SELECT id, url, title, favicon, visited_at, visit_count
           FROM history
           WHERE url LIKE ? OR title LIKE ?
           ORDER BY visited_at DESC
           LIMIT ?`
        )
        .all(like, like, limit) as typeof rows
    } else {
      rows = this.db
        .prepare(
          `SELECT id, url, title, favicon, visited_at, visit_count
           FROM history
           ORDER BY visited_at DESC
           LIMIT ?`
        )
        .all(limit) as typeof rows
    }

    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      favicon: r.favicon ?? undefined,
      visitedAt: r.visited_at,
      visitCount: r.visit_count
    }))
  }

  public deleteHistoryItem(id: string): void {
    this.db.prepare('DELETE FROM history WHERE id = ?').run(id)
  }

  public clearHistory(): void {
    this.db.prepare('DELETE FROM history').run()
  }

  public close(): void {
    this.db.close()
  }
}
