export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RevConflictError extends SyncError {
  constructor(
    public readonly path: string,
    message = `Revision conflict for ${path}`,
  ) {
    super(message);
  }
}

export class CursorResetError extends SyncError {
  constructor(message = 'Remote cursor was reset') {
    super(message);
  }
}

export class AuthError extends SyncError {
  constructor(message = 'Authentication error') {
    super(message);
  }
}

export class RateLimitError extends SyncError {
  constructor(
    public readonly retryAfterMs: number,
    message = `Rate limited; retry after ${retryAfterMs}ms`,
  ) {
    super(message);
  }
}

export class InsufficientSpaceError extends SyncError {
  constructor(message = 'Insufficient space on remote storage') {
    super(message);
  }
}

export class NetworkError extends SyncError {
  constructor(message = 'Network error') {
    super(message);
  }
}

export class NotFoundError extends SyncError {
  constructor(
    public readonly path: string,
    message = `Path not found: ${path}`,
  ) {
    super(message);
  }
}

export class RemotePathError extends SyncError {
  constructor(
    public readonly path: string,
    public readonly summary: string,
  ) {
    super(`Remote path error for ${path}: ${summary}`);
  }
}
