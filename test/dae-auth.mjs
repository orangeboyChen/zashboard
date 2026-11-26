// Regression checks for dae authentication when requests race with backend changes or time out.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'
import { connectBrowser, waitFor } from './lib/cdp.mjs'
import { launchChrome } from './lib/chrome.mjs'
import { findFreePort } from './lib/ports.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-allow-methods': 'GET, PATCH, POST, OPTIONS',
}

const reply = (res, status, data) => {
  res.writeHead(status, { ...cors, 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

let releaseFirstPatch
let firstPatchArrived
const firstPatch = new Promise((resolve) => (firstPatchArrived = resolve))
const patchGate = new Promise((resolve) => (releaseFirstPatch = resolve))
let wrongBackendPatches = 0
let holdFirstLogin = false
let firstLoginArrived
let releaseFirstLogin
let stalledPhase = 'discovery'
let stalledRequests = 0

const backendServer = (name) =>
  createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return reply(res, 204, {})

    if (req.url === '/api') {
      if (name === 'stalled' && stalledPhase === 'discovery') {
        stalledRequests++
        return
      }
      return reply(res, 200, { auth: { mode: 'password', setup_required: false } })
    }

    if (req.url === '/api/v1/auth/login') {
      if (name === 'stalled') {
        stalledRequests++
        return
      }
      if (name === 'first' && holdFirstLogin) {
        firstLoginArrived()
        await firstLoginGate
      }
      return reply(res, 200, {
        token: `token-${name}`,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      })
    }

    if (req.url === '/api/v1/runtime/settings' && req.method === 'PATCH') {
      if (name === 'first') {
        firstPatchArrived()
        await patchGate
        return reply(res, 401, { error: { code: 'unauthorized' } })
      }
      wrongBackendPatches++
      return reply(res, 200, {})
    }

    reply(res, 404, {})
  })

const servers = ['first', 'second', 'stalled'].map(backendServer)
const ports = await Promise.all(servers.map(listen))
const backend = (uuid, port) => ({
  uuid,
  type: 'dae',
  protocol: 'http',
  host: '127.0.0.1',
  port: String(port),
  secondaryPath: '',
  username: 'admin',
  password: 'password',
  label: uuid,
})
const [first, second, stalled] = ports.map((port, i) =>
  backend(['first', 'second', 'stalled'][i], port),
)
let firstLoginGate = Promise.resolve()

const vite = await createViteServer({
  configFile: false,
  root,
  appType: 'custom',
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 0 },
})
vite.middlewares.use('/__dae_auth_test', (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>dae auth test</title>')
})
await vite.listen()

const debuggingPort = await findFreePort()
const chrome = await launchChrome({ port: debuggingPort })
const browser = await connectBrowser(debuggingPort)
const page = await browser.newPage()

try {
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__dae_auth_test`)
  assert.notEqual(await waitFor(() => page.evaluate(`document.title === 'dae auth test'`)), null)

  await page.evaluate(`
    localStorage.setItem('setup/api-list', ${JSON.stringify(JSON.stringify([first, second]))});
    localStorage.setItem('setup/active-uuid', 'first');
  `)

  await page.evaluate(`
    (async () => {
      const { patchDaeRuntimeSettingsAPI } = await import('/src/api/dae.ts');
      window.__patchResult = patchDaeRuntimeSettingsAPI({ mode: 'test' })
        .then(() => 'resolved', (error) => error.response?.status ?? error.message);
    })()
  `)
  assert.notEqual(
    await Promise.race([
      firstPatch,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]),
    null,
  )

  await page.evaluate(`
    (async () => {
      const { setActiveBackend } = await import('/src/store/setup.ts');
      setActiveBackend('second');
    })()
  `)
  releaseFirstPatch()
  const patchResult = await page.evaluate('window.__patchResult')
  assert.equal(patchResult, 401)
  assert.equal(wrongBackendPatches, 0, '401 retry must not PATCH the second backend')
  console.log('✓ 401 after a backend switch does not retry a mutation on the new backend')

  holdFirstLogin = true
  const loginArrived = new Promise((resolve) => (firstLoginArrived = resolve))
  firstLoginGate = new Promise((resolve) => (releaseFirstLogin = resolve))
  await page.evaluate(`
    (async () => {
      const { setActiveBackend } = await import('/src/store/setup.ts');
      const { dropDaeSession } = await import('/src/api/dae-auth.ts');
      setActiveBackend('first');
      dropDaeSession(${JSON.stringify(first)});
    })()
  `)
  await page.evaluate(`
    (async () => {
      const { patchDaeRuntimeSettingsAPI } = await import('/src/api/dae.ts');
      window.__pendingAuthResult = patchDaeRuntimeSettingsAPI({ mode: 'test' })
        .then(() => 'resolved', (error) => error.code);
    })()
  `)
  assert.notEqual(
    await Promise.race([
      loginArrived,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]),
    null,
  )
  await page.evaluate(`
    (async () => {
      const { setActiveBackend } = await import('/src/store/setup.ts');
      setActiveBackend('second');
    })()
  `)
  releaseFirstLogin()
  assert.equal(await page.evaluate('window.__pendingAuthResult'), 'ERR_CANCELED')
  assert.equal(wrongBackendPatches, 0)
  console.log('✓ switching during authentication cancels the original mutation')

  for (const phase of ['discovery', 'login']) {
    stalledPhase = phase
    stalledRequests = 0
    const result = await page.evaluate(`
      (async () => {
        const { probeDaeChannel } = await import('/src/api/dae.ts');
        return probeDaeChannel(${JSON.stringify(stalled)}, 150, undefined, true);
      })()
    `)
    assert.equal(result.kind, 'timeout', `${phase} should respect the probe timeout`)
    assert.ok(result.latency < 2000, `${phase} should finish promptly`)
    assert.equal(stalledRequests, 1, `${phase} endpoint should have been reached`)
    console.log(`✓ stalled ${phase} respects the probe timeout`)
  }
} finally {
  releaseFirstPatch()
  releaseFirstLogin?.()
  await page.close()
  browser.close()
  await chrome.close()
  await vite.close()
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}
