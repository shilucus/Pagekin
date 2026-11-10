import { EventEmitter } from 'node:events'
import type { IncomingHttpHeaders, RequestListener } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INBOUND_ERROR_CODES, type InboundRequest } from '../../../src/shared/inbound-domain-contract'
import { InboundApiController } from '../inbound-api-controller'

const httpMock = vi.hoisted(() => ({ createServer: vi.fn() }))
vi.mock('node:http', () => ({ createServer: httpMock.createServer }))

describe('inbound HTTP header boundary without a network listener', () => {
  let listener: RequestListener
  let controller: InboundApiController
  const request: InboundRequest = {
    callerId: 'header-test-caller',
    token: 'invalid-header-test-token',
    projectId: 'header-test-project',
    grantId: 'header-test-grant',
    command: 'project:get',
    idempotencyKey: 'header-test-request',
    payload: {},
  }

  beforeEach(async () => {
    httpMock.createServer.mockReset()
    httpMock.createServer.mockImplementation((callback: RequestListener) => {
      listener = callback
      return {
        on: vi.fn(),
        listen: vi.fn((_port: number, _host: string, ready: () => void) => ready()),
        address: () => ({ port: 43111 }),
      }
    })
    controller = new InboundApiController()
    await controller.startServer(0)
  })

  async function invoke(headers: IncomingHttpHeaders, body: InboundRequest = request) {
    const incoming = Object.assign(new EventEmitter(), { headers, method: 'POST', destroy: vi.fn() })
    const subscribe = vi.spyOn(incoming, 'on')
    let complete!: (value: string) => void
    const completed = new Promise<string>(resolve => { complete = resolve })
    const response = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((value: string) => complete(value)),
    }

    listener(incoming as unknown as Parameters<RequestListener>[0], response as unknown as Parameters<RequestListener>[1])
    incoming.emit('data', Buffer.from(JSON.stringify(body)))
    incoming.emit('end')
    const result = JSON.parse(await completed) as { error?: { code: string; message: string }; status?: string }
    return { status: response.statusCode, result, subscribe }
  }

  it.each([
    [{ host: 'localhost:abc' }, INBOUND_ERROR_CODES.INVALID_HOST_HEADER],
    [{ host: 'localhost:65536' }, INBOUND_ERROR_CODES.INVALID_HOST_HEADER],
    [{ host: 'localhost:80/path' }, INBOUND_ERROR_CODES.INVALID_HOST_HEADER],
    [{ host: 'localhost', origin: 'http://localhost.evil' }, INBOUND_ERROR_CODES.INVALID_ORIGIN_HEADER],
    [{ host: 'localhost', origin: 'http://127.0.0.1.evil' }, INBOUND_ERROR_CODES.INVALID_ORIGIN_HEADER],
    [{ host: 'localhost', origin: 'http://localhost@evil.example' }, INBOUND_ERROR_CODES.INVALID_ORIGIN_HEADER],
    [{ host: 'localhost', origin: 'http://localhost/path' }, INBOUND_ERROR_CODES.INVALID_ORIGIN_HEADER],
    [{ host: 'localhost', origin: 'http://localhost?query' }, INBOUND_ERROR_CODES.INVALID_ORIGIN_HEADER],
    [{ host: 'localhost', origin: 'http://localhost#hash' }, INBOUND_ERROR_CODES.INVALID_ORIGIN_HEADER],
    [{ host: 'localhost', origin: 'http://localhost http://127.0.0.1' }, INBOUND_ERROR_CODES.INVALID_ORIGIN_HEADER],
  ] as const)('rejects headers %j before reading or dispatching the body', async (headers, code) => {
    const dispatch = vi.spyOn(controller.service, 'executeInboundRequest')
    const response = await invoke(headers)

    expect(response.status).toBe(403)
    expect(response.result.error?.code).toBe(code)
    expect(response.subscribe).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('preserves the missing Host response before reading the body', async () => {
    const dispatch = vi.spyOn(controller.service, 'executeInboundRequest')
    const response = await invoke({})

    expect(response.status).toBe(400)
    expect(response.result.error?.code).toBe(INBOUND_ERROR_CODES.INVALID_HOST_HEADER)
    expect(response.subscribe).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('still authenticates a request with valid headers', async () => {
    const response = await invoke({ host: '127.0.0.1:43111', origin: 'http://localhost:5180' })

    expect(response.status).toBe(401)
    expect(response.result.error?.code).toBe(INBOUND_ERROR_CODES.UNAUTHORIZED_TOKEN)
    expect(response.subscribe).toHaveBeenCalledWith('data', expect.any(Function))
  })

  it('still enforces the project grant with valid headers and a valid token', async () => {
    const token = controller.service.issueToken({
      callerId: request.callerId,
      scopes: ['task'],
      allowedProjectIds: ['another-header-test-project'],
    })
    const response = await invoke({ host: 'localhost', origin: 'ai-novel://local' }, { ...request, token: token.token })

    expect(response.status).toBe(403)
    expect(response.result.error?.code).toBe(INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID)
  })

  it('dispatches authorized input with a valid custom-protocol origin and Bearer token', async () => {
    const token = controller.service.issueToken({
      callerId: request.callerId,
      scopes: ['task'],
      allowedProjectIds: [request.projectId],
    })
    const response = await invoke({
      host: '[::1]:43111',
      origin: 'vscode-webview://header-test-extension',
      authorization: `Bearer ${token.token}`,
    }, { ...request, token: '' })

    expect(response.status).toBe(200)
    expect(response.result.status).toBe('succeeded')
  })
})
