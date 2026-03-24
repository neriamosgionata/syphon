import { test } from '@japa/runner'
import http from 'http'

test.group('Notifications API', () => {
  test('GET /api/notifications/stream returns SSE headers', async ({ assert }) => {
    const port = process.env.PORT || '3333'
    const host = process.env.HOST || '0.0.0.0'

    const result = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; data: string }>((resolve) => {
      const req = http.get(`http://${host}:${port}/api/notifications/stream`, (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk.toString()
          // Read the first event then close
          if (data.includes('\n\n')) {
            req.destroy()
            resolve({ statusCode: res.statusCode!, headers: res.headers, data })
          }
        })
      })

      // Safety timeout
      setTimeout(() => {
        req.destroy()
        resolve({ statusCode: 0, headers: {}, data: '' })
      }, 5000)
    })

    assert.equal(result.statusCode, 200)
    assert.equal(result.headers['content-type'], 'text/event-stream')
    assert.equal(result.headers['cache-control'], 'no-cache')
    assert.equal(result.headers['connection'], 'keep-alive')
  })

  test('GET /api/notifications/stream sends connected event', async ({ assert }) => {
    const port = process.env.PORT || '3333'
    const host = process.env.HOST || '0.0.0.0'

    const data = await new Promise<string>((resolve) => {
      const req = http.get(`http://${host}:${port}/api/notifications/stream`, (res) => {
        let buf = ''
        res.on('data', (chunk) => {
          buf += chunk.toString()
          if (buf.includes('\n\n')) {
            req.destroy()
            resolve(buf)
          }
        })
      })

      setTimeout(() => {
        req.destroy()
        resolve('')
      }, 5000)
    })

    assert.include(data, 'event: connected')
    assert.include(data, 'Connected to notifications')
  })
})
