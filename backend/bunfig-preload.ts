import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/*
 * Patch 1: jsonschema's resolveUrl emits bare relative paths ('/undefined#/...')
 * that Bun's spec-compliant URL parser rejects when resolved against the
 * opaque 'thismessage::/' base. Node tolerates it. Emit absolute file URLs
 * instead so ref resolution works on both runtimes.
 */
const helpers = require('jsonschema/lib/helpers.js')

helpers.resolveUrl = function resolveUrl(from, to) {
  const resolvedUrl = new URL(to, new URL(from, 'resolve://'))
  if (resolvedUrl.protocol === 'resolve:') {
    const { pathname, search, hash } = resolvedUrl
    return 'file://' + (pathname || '/') + search + hash
  }
  return resolvedUrl.toString()
}

/*
 * Patch 2: execa 9 calls channel.refCounted()/unrefCounted() on the child
 * process IPC channel (ipc defaults to true for execaNode). Bun's channel
 * object lacks those methods, so every execaNode spawn (ace test, ace serve)
 * rejects with "channel.refCounted is not a function". Guard the calls with
 * optional chaining. Idempotent: rewrites the source only when unpatched, so
 * it survives node_modules re-installs.
 */
const execaEntry = require.resolve('execa')
const referencePath = join(dirname(execaEntry), 'lib', 'ipc', 'reference.js')
const referenceSource = readFileSync(referencePath, 'utf8')

if (!referenceSource.includes('refCounted?.()')) {
  const patched = referenceSource
    .replace('channel.refCounted();', 'channel.refCounted?.();')
    .replace('channel.unrefCounted();', 'channel.unrefCounted?.();')
  writeFileSync(referencePath, patched)
}
