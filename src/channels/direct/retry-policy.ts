import {ChannelHttpError} from './transport.js'

/** Retry transport failures, never authorization, malformed data or delivery. */
export function matrixTransientFailure(error: unknown): boolean {
  return error instanceof ChannelHttpError
    ? error.status === 408 || error.status === 429 || error.status >= 500
    : error instanceof Error && (error.name === 'TimeoutError'
      || error instanceof TypeError && error.message === 'fetch failed')
}
