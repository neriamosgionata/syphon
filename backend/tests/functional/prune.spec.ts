import { test } from '@japa/runner'

test.group('Prune API', () => {
  test('POST /api/prune returns success response', async ({ client, assert }) => {
    const response = await client.post('/api/prune')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'message')
    assert.isString(body.message)
    assert.include(body.message.toLowerCase(), 'prune')
  })

  test('POST /api/prune preserves tickers', async ({ client, assert }) => {
    // Get ticker count before prune
    const beforeResponse = await client.get('/api/tickers')
    beforeResponse.assertStatus(200)
    const tickersBefore = beforeResponse.body().meta.total

    // Prune
    await client.post('/api/prune')

    // Check tickers are still there
    const afterResponse = await client.get('/api/tickers')
    afterResponse.assertStatus(200)
    const tickersAfter = afterResponse.body().meta.total

    assert.equal(tickersAfter, tickersBefore)
  })
})
