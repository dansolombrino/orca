// Why this exists: xterm 6.1 runs WriteBuffer.flushSync on every resize, and
// that flush shifts from index 0 instead of _bufferOffset. Chunks a time-sliced
// _innerWrite already parsed (and their callbacks) are parsed AGAIN, so a fit
// landing between slices replays old TUI output over the screen — garbled rows
// that persist until the TUI's next full redraw (a manual resize). Still
// unfixed upstream as of 6.1.0-beta.315. This trims the parsed prefix first and
// skips flushes that would re-enter a chunk mid-parse. Delete once xterm's
// flushSync honours _bufferOffset.

type WriteChunk = string | Uint8Array

type WriteBufferInternals = {
  _writeBuffer: WriteChunk[]
  _callbacks: unknown[]
  _bufferOffset: number
  _isSyncWriting: boolean
  _action: (data: WriteChunk, promiseResult?: boolean) => unknown
  _innerWrite: (...args: unknown[]) => void
  flushSync: () => void
}

function readWriteBuffer(terminal: unknown): WriteBufferInternals | null {
  const candidate = (
    terminal as { _core?: { _writeBuffer?: Partial<WriteBufferInternals> } } | null
  )?._core?._writeBuffer
  if (
    !candidate ||
    !Array.isArray(candidate._writeBuffer) ||
    !Array.isArray(candidate._callbacks) ||
    typeof candidate._bufferOffset !== 'number' ||
    typeof candidate._isSyncWriting !== 'boolean' ||
    typeof candidate._action !== 'function' ||
    typeof candidate._innerWrite !== 'function' ||
    typeof candidate.flushSync !== 'function'
  ) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field the repair touches was shape-checked above.
  return candidate as WriteBufferInternals
}

function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

/** Returns false when the vendored xterm no longer has the expected internals. */
export function installXtermWriteBufferFlushRepair(terminal: unknown): boolean {
  const writeBuffer = readWriteBuffer(terminal)
  if (!writeBuffer) {
    return false
  }
  const originalAction = writeBuffer._action
  const originalInnerWrite = writeBuffer._innerWrite
  const originalFlushSync = writeBuffer.flushSync
  let actionDepth = 0
  let innerWriteDepth = 0
  let parserPausedOnPromise = false
  // Identifies the chunk _innerWrite last parsed: during its callback _bufferOffset still points at it.
  let lastParsedBuffer: WriteChunk[] | null = null
  let lastParsedOffset = -1

  writeBuffer._action = (data, promiseResult) => {
    const offset = writeBuffer._bufferOffset
    const buffer = writeBuffer._writeBuffer
    actionDepth += 1
    try {
      const result = originalAction(data, promiseResult)
      parserPausedOnPromise = isThenable(result)
      lastParsedBuffer = parserPausedOnPromise ? null : buffer
      lastParsedOffset = offset
      return result
    } finally {
      actionDepth -= 1
    }
  }
  writeBuffer._innerWrite = function (...args: unknown[]): void {
    innerWriteDepth += 1
    try {
      originalInnerWrite.apply(writeBuffer, args)
    } finally {
      innerWriteDepth -= 1
    }
  }
  writeBuffer.flushSync = function (): void {
    if (writeBuffer._isSyncWriting) {
      originalFlushSync.call(writeBuffer)
      return
    }
    // Why: flushing inside a parse or across an async handler pause would re-run a partly parsed chunk.
    if (actionDepth > 0 || parserPausedOnPromise) {
      return
    }
    const insideParsedChunkCallback =
      innerWriteDepth > 0 &&
      lastParsedBuffer === writeBuffer._writeBuffer &&
      lastParsedOffset === writeBuffer._bufferOffset
    const parsedCount = writeBuffer._bufferOffset + (insideParsedChunkCallback ? 1 : 0)
    if (parsedCount > 0 && parsedCount <= writeBuffer._writeBuffer.length) {
      writeBuffer._writeBuffer.splice(0, parsedCount)
      writeBuffer._callbacks.splice(0, parsedCount)
      writeBuffer._bufferOffset = 0
    }
    originalFlushSync.call(writeBuffer)
  }
  return true
}
