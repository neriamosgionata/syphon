// The unit specs boot a throwaway Adonis Application and point the global IoC
// hooks at its container so `@ioc:*` / `App/*` imports resolve to stubs.
// Those hooks are GLOBAL and must be restored afterwards, otherwise the
// functional suite (which boots the real app in the same process) resolves
// Env/Models/Redis through the stale stub container and breaks.

const IOC_USE = Symbol.for('ioc.use')
const IOC_MAKE = Symbol.for('ioc.make')
const IOC_CALL = Symbol.for('ioc.call')

export interface IocHooks {
  use: any
  make: any
  call: any
}

export function captureIocHooks(): IocHooks {
  return {
    use: (globalThis as any)[IOC_USE],
    make: (globalThis as any)[IOC_MAKE],
    call: (globalThis as any)[IOC_CALL],
  }
}

export function installIocHooks(app: any): IocHooks {
  const previous = captureIocHooks()
  ;(globalThis as any)[IOC_USE] = app.container.use.bind(app.container)
  ;(globalThis as any)[IOC_MAKE] = app.container.make.bind(app.container)
  ;(globalThis as any)[IOC_CALL] = app.container.call.bind(app.container)
  return previous
}

export function restoreIocHooks(hooks: IocHooks) {
  ;(globalThis as any)[IOC_USE] = hooks.use
  ;(globalThis as any)[IOC_MAKE] = hooks.make
  ;(globalThis as any)[IOC_CALL] = hooks.call
}

/**
 * Redis stub for unit specs. The MeilisearchService singleton is constructed
 * by whichever spec imports it first (module cache), so every spec's Redis
 * stub must share the same counter map or ids drift across the suite.
 */
const redisCounters = new Map<string, number>()

export function createRedisStub() {
  const incr = async (key: string) => {
    const next = (redisCounters.get(key) || 0) + 1
    redisCounters.set(key, next)
    return next
  }
  return {
    counters: redisCounters,
    incr,
    get: async () => null,
    set: async () => {},
    del: async () => {},
    connection: () => ({ incr, get: async () => null, set: async () => {}, del: async () => {} }),
  }
}
