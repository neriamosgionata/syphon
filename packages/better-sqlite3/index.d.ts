/**
 * Minimal type surface for the node:sqlite-backed better-sqlite3 shim.
 * Only the API consumed by knex's better-sqlite3 dialect and the app's
 * database config is declared.
 */

declare class Statement {
  readonly reader: boolean
  readonly sourceSQL: string
  run(...bindings: any[]): { changes: number; lastInsertRowid: number }
  get(...bindings: any[]): any
  all(...bindings: any[]): any[]
  iterate(...bindings: any[]): IterableIterator<any>
  safeIntegers(value: boolean): this
}

declare class Database {
  constructor(filename: string, options?: { nativeBinding?: string; readonly?: boolean; fileMustExist?: boolean })
  readonly open: boolean
  prepare(sql: string): Statement
  exec(sql: string): this
  close(): void
  pragma(sql: string, options?: { simple?: boolean }): any
  defaultSafeIntegers(value?: boolean): this
  transaction<T extends (...args: any[]) => any>(fn: T): T
  on(event: string, listener: (...args: any[]) => void): this
  once(event: string, listener: (...args: any[]) => void): this
  removeListener(event: string, listener: (...args: any[]) => void): this
  off(event: string, listener: (...args: any[]) => void): this
}

export = Database
