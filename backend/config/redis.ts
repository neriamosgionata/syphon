import env from '#start/env'
import { defineConfig } from '@adonisjs/redis'

const redisConfig = defineConfig({
  connection: env.get('REDIS_CONNECTION'),
  connections: {
    local: {
      host: env.get('REDIS_HOST'),
      port: env.get('REDIS_PORT'),
      password: env.get('REDIS_PASSWORD', '') || undefined,
      db: 0,
      keyPrefix: 'syphon:',
    },
  },
})

export default redisConfig