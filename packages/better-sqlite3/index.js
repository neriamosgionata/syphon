'use strict'

const READER_RE = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN|VALUES|RETURNING)\b/i
const RETURNING_RE = /\bRETURNING\b/i

let SQLite = null
let prepareName = 'prepare'

try {
  SQLite = require('bun:sqlite').Database
  prepareName = 'query'
} catch {
  SQLite = require('node:sqlite').DatabaseSync
}

function normalizeBindings(bindings) {
  if (!bindings || !bindings.length) return []
  return bindings.map((b) => (b === undefined ? null : b))
}

class Statement {
  constructor(db, sql) {
    this.db = db
    this.sql = sql
    this._stmt = null
    this._reader = READER_RE.test(sql) || RETURNING_RE.test(sql)
  }

  get reader() {
    return this._reader
  }

  get sourceSQL() {
    return this.sql
  }

  _prepare() {
    if (!this._stmt) {
      this._stmt = this.db._db[prepareName](this.sql)
    }
    return this._stmt
  }

  run(...args) {
    const bindings = normalizeBindings(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
    const result = this._prepare().run(...bindings)
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    }
  }

  get(...args) {
    const bindings = normalizeBindings(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
    return this._prepare().get(...bindings)
  }

  all(...args) {
    const bindings = normalizeBindings(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
    return this._prepare().all(...bindings)
  }

  iterate(...args) {
    const bindings = normalizeBindings(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
    const stmt = this._prepare()
    if (typeof stmt.iterate === 'function') {
      return stmt.iterate(...bindings)
    }
    return stmt.all(...bindings)[Symbol.iterator]()
  }

  safeIntegers() {
    return this
  }
}

class Database {
  constructor(filename, options = {}) {
    const opts = {}
    if (options.readonly) opts.readonly = true
    if (options.fileMustExist) opts.fileMustExist = true
    this._db = Object.keys(opts).length ? new SQLite(filename, opts) : new SQLite(filename)
  }

  get open() {
    return this._db.isOpen
  }

  prepare(sql) {
    return new Statement(this, sql)
  }

  exec(sql) {
    this._db.exec(sql)
    return this
  }

  close() {
    this._db.close()
  }

  pragma(sql, options) {
    const source = /^\s*PRAGMA\b/i.test(sql) ? sql : 'PRAGMA ' + sql
    const rows = this._db[prepareName](source).all()
    if (options && options.simple) {
      if (!rows.length) return undefined
      const row = rows[0]
      return row[Object.keys(row)[0]]
    }
    return rows
  }

  defaultSafeIntegers() {
    return this
  }

  transaction(fn) {
    const db = this._db
    return function wrappedTransaction(...args) {
      db.exec('BEGIN')
      try {
        const result = fn.apply(this, args)
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }

  on() {
    return this
  }

  once() {
    return this
  }

  removeListener() {
    return this
  }

  off() {
    return this
  }

  inspect() {
    return this
  }
}

module.exports = Database
module.exports.default = Database
module.exports.Database = Database
