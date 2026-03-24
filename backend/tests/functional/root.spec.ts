import { test } from '@japa/runner'

test.group('Root API', () => {
  test('GET / returns API info', async ({ client, assert }) => {
    const response = await client.get('/')

    response.assertStatus(200)
    const body = response.body()
    assert.equal(body.name, 'Syphon API')
    assert.equal(body.version, '1.0.0')
    assert.equal(body.status, 'running')
  })
})
