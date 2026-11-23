export class TokenExpiredError extends Error {
  public readonly statusCode: number
  constructor(statusCode: number, message?: string) {
    super(message || `Remote CDN returned HTTP ${statusCode} (Signed token expired)`)
    this.name = 'TokenExpiredError'
    this.statusCode = statusCode
  }
}

export class PauseRequestedError extends Error {
  constructor() {
    super('Download paused by user')
    this.name = 'PauseRequestedError'
  }
}

export class CancelRequestedError extends Error {
  constructor() {
    super('Download cancelled by user')
    this.name = 'CancelRequestedError'
  }
}
