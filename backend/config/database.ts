import Env from '@ioc:Adonis/Core/Env'
import { DatabaseConfig } from '@ioc:Adonis/Lucid/Database'

const databaseConfig: DatabaseConfig = {
  connection: Env.get('DB_CONNECTION'),
  connections: {
    sqlite: {
      client: 'better-sqlite3',
      connection: {
        filename: Env.get('SQLITE_FILENAME', `${process.cwd()}/syphon.sqlite3`),
      },
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
      },
      healthCheck: true,
      debug: false,
    },
    mysql: {
      client: 'mysql2',
      connection: {
        host: Env.get('MYSQL_HOST'),
        port: Env.get('MYSQL_PORT'),
        user: Env.get('MYSQL_USER'),
        password: Env.get('MYSQL_PASSWORD', ''),
        database: Env.get('MYSQL_DB_NAME'),
      },
      migrations: {
        naturalSort: true,
      },
      healthCheck: true,
      debug: false,
    },
  },
}

export default databaseConfig
