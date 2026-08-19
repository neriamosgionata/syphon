import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

const dbConfig = defineConfig({
  /**
   * Default connection used for all queries.
   */
  connection: env.get('DB_CONNECTION'),

  connections: {
    /**
     * SQLite connection (default).
     */
    sqlite: {
      client: 'better-sqlite3',

      connection: {
        filename: env.get('SQLITE_FILENAME', app.makePath('syphon.sqlite3')),
      },

      /**
       * Required by Knex for SQLite defaults.
       */
      useNullAsDefault: true,

      pool: {
        afterCreate: (conn: any, done: any) => {
          conn.pragma('journal_mode = WAL')
          conn.pragma('synchronous = NORMAL')
          conn.pragma('busy_timeout = 5000')
          conn.pragma('foreign_keys = ON')
          done()
        },
      },

      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },

      schemaGeneration: {
        enabled: false,
      },

      debug: false,
    },

    /**
     * MySQL / MariaDB connection.
     */
    mysql: {
      client: 'mysql2',

      connection: {
        host: env.get('MYSQL_HOST'),
        port: env.get('MYSQL_PORT'),
        user: env.get('MYSQL_USER'),
        password: env.get('MYSQL_PASSWORD', ''),
        database: env.get('MYSQL_DB_NAME'),
      },

      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },

      debug: false,
    },
  },
})

export default dbConfig