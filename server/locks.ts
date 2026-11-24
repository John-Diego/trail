/**
 * A Claude run reads and edits a checkout; a refresh moves it to another commit. The two must
 * never overlap in the same directory. Checks and registrations here are synchronous, so
 * between two awaits no other request can slip in.
 */
const running = new Map<string, number>()
const moving = new Set<string>()

function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409 })
}

export function isRunning(dir: string): boolean {
  return running.has(dir)
}

export async function withRun<T>(dir: string, work: () => Promise<T>): Promise<T> {
  if (moving.has(dir)) throw conflict('This review is being refreshed. Try again in a moment.')
  running.set(dir, (running.get(dir) ?? 0) + 1)
  try {
    return await work()
  } finally {
    const left = (running.get(dir) ?? 1) - 1
    if (left > 0) running.set(dir, left)
    else running.delete(dir)
  }
}

export async function withMove<T>(dir: string, work: () => Promise<T>): Promise<T> {
  if (running.has(dir)) throw conflict('Claude is still working in this review. Wait for it to finish, or stop it, before refreshing.')
  if (moving.has(dir)) throw conflict('This review is already being refreshed.')
  moving.add(dir)
  try {
    return await work()
  } finally {
    moving.delete(dir)
  }
}
