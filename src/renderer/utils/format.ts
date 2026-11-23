export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let val = bytes
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`
}

export function formatSpeed(bps?: number): string {
  if (!bps || bps <= 0 || !Number.isFinite(bps)) return '0 B/s'
  return `${formatBytes(bps)}/s`
}

export function formatDuration(sec?: number): string {
  if (!sec || sec <= 0 || !Number.isFinite(sec)) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatEta(sec?: number): string {
  if (!sec || sec <= 0 || !Number.isFinite(sec)) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
