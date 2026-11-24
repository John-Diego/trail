import { useEffect, useState } from 'react'
import type { FileDiff, Review } from '../../shared/types.ts'
import { api } from './api.ts'
import { highlightLines, type Tok } from './highlight.ts'

export interface LoadedFile {
  oldLines: Tok[][] | null
  newLines: Tok[][] | null
  known: Set<string>
}

const fileCache = new Map<string, Promise<LoadedFile>>()
const blobCache = new Map<string, Promise<{ lines: Tok[][]; known: Set<string> }>>()

function loadFile(review: Review, file: FileDiff): Promise<LoadedFile> {
  // Both ends of the diff and the path: the same head against another base is a different diff.
  // The index too: a type change is two entries with the same path.
  const key = `${review.id}:${review.baseSha}:${review.headSha}:${file.idx}:${file.oldPath}:${file.path}`
  let p = fileCache.get(key)
  if (!p) {
    p = api.file(review.id, file.idx).then((c) => ({
      oldLines: c.old === null ? null : highlightLines(c.old, file.oldPath),
      newLines: c.new === null ? null : highlightLines(c.new, file.path),
      known: new Set(c.known),
    }))
    p.catch(() => fileCache.delete(key))
    fileCache.set(key, p)
  }
  return p
}

/** Full old and new contents of a changed file, highlighted. Null until loaded. */
export function useFile(review: Review, file: FileDiff, enabled = true): LoadedFile | null {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null)
  useEffect(() => {
    if (!enabled || file.binary) return
    let live = true
    setLoaded(null)
    loadFile(review, file).then(
      (f) => live && setLoaded(f),
      () => {},
    )
    return () => {
      live = false
    }
  }, [review.id, review.baseSha, review.headSha, file.idx, file.oldPath, file.path, enabled])
  return loaded
}

export function loadBlob(review: Review, path: string, side: 'old' | 'new') {
  const key = `${review.id}:${review.baseSha}:${review.headSha}:${side}:${path}`
  let p = blobCache.get(key)
  if (!p) {
    p = api.blob(review.id, path, side).then((b) => ({ lines: highlightLines(b.text, path), known: new Set(b.known) }))
    p.catch(() => blobCache.delete(key))
    blobCache.set(key, p)
  }
  return p
}
