import { CacheStore } from "./cache_store"
import { RedisCacheNotifier } from "./redis_cache_notifier"

export enum CacheNotifierOperation {
  del = "del",
  purgeTags = "purgeTags"
}

export interface ReceiveHandler {
  (op: CacheNotifierOperation, ns: string, value: string): void
}
export interface CacheNotifierAdapter {
  send(op: CacheNotifierOperation, ns: string, value: string): Promise<boolean>
  start(handler: ReceiveHandler): void
}

export class CacheNotifier {
  constructor(
    public cacheStore: CacheStore,
    public adapter: CacheNotifierAdapter
  ) {
    adapter.start((type, ns, value) => this.handle(type, ns, value))
  }

  async sendDel(ns: string, key: string) {
    return this.send(CacheNotifierOperation.del, ns, key)
  }
  async send(op: CacheNotifierOperation, ns: string, value: string) {
    return this.adapter.send(op, ns, value)
  }

  async handle(type: CacheNotifierOperation, ns: string, value: string) {
    switch (type) {
      case CacheNotifierOperation.del:
        const res = await this.cacheStore.del(ns, value)
      case CacheNotifierOperation.purgeTags:
        return !!(await this.cacheStore.purgeTags(ns, value))
      default:
        throw new Error(`Unknown CacheNotifierOperation: ${type}`)
    }
  }

}

export class LocalCacheNotifier implements CacheNotifierAdapter {
  private _handler: ReceiveHandler | undefined
  async send(op: CacheNotifierOperation, ns: string, value: string) {
    if (this._handler) {
      this._handler(op, ns, value)
    }
    return true
  }

  start(handler: ReceiveHandler) {
    this._handler = handler
  }
  /*switch(type) {
      case CacheNotifierOperation.del:
    return await this.cacheStore.del(ns, key)
      case CacheNotifierOperation.purgeTags:
    return !!(await this.cacheStore.purgeTags(ns, key))
      default:
    throw new Error(`Unknown CacheNotifierOperation: ${type}`)
    }
  }*/
}//*/e

export function defaultCacheNotifier(cacheStore: CacheStore) {
  let adapter: CacheNotifierAdapter = new LocalCacheNotifier()
  if (process.env.REDIS_CACHE_NOTIFIER_URL) {
    console.log("Using Redis Cache Notifier")
    adapter = new RedisCacheNotifier(process.env.REDIS_CACHE_NOTIFIER_URL)
  }
  return new CacheNotifier(cacheStore, adapter)
}