import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  type InboundReceipt,
  type InboundRequest,
  InboundDomainError,
  MAX_INBOUND_PAYLOAD_BYTES,
  validateHostHeader,
  validateOriginHeader,
} from '../../src/shared/inbound-domain-contract'
import { InboundApiService } from '../services/inbound-api-service'

export interface InboundApiControllerOptions {
  service?: InboundApiService
  port?: number
}

export class InboundApiController {
  public readonly service: InboundApiService
  private server: Server | null = null
  private listeningPort: number | null = null

  constructor(options: InboundApiControllerOptions = {}) {
    this.service = options.service ?? new InboundApiService()
  }

  /**
   * Direct programmatic dispatch entry point (IPC / in-process).
   */
  async handleRequest(request: InboundRequest): Promise<InboundReceipt> {
    return this.service.executeInboundRequest(request)
  }

  /**
   * Starts a local loopback HTTP inbound listener on 127.0.0.1.
   */
  async startServer(port = 0): Promise<number> {
    if (this.server) {
      return this.listeningPort!
    }

    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        void this.handleIncomingHttp(req, res)
      })

      srv.on('error', reject)

      // Strict binding to 127.0.0.1 (Loopback only)
      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address()
        if (typeof addr === 'object' && addr !== null) {
          this.listeningPort = addr.port
          this.server = srv
          resolve(addr.port)
        } else {
          reject(new Error('Failed to obtain server listening address'))
        }
      })
    })
  }

  /**
   * Stops the HTTP inbound listener.
   */
  async stopServer(): Promise<void> {
    if (!this.server) {
      return
    }

    return new Promise((resolve, reject) => {
      this.server!.close(err => {
        this.server = null
        this.listeningPort = null
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  getPort(): number | null {
    return this.listeningPort
  }

  /**
   * Handles an incoming HTTP request with full security header validations.
   */
  private async handleIncomingHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')

    try {
      // 1. Host & Origin security checks
      validateHostHeader(req.headers.host)
      validateOriginHeader(req.headers.origin)

      // 2. Only POST allowed for domain API commands
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is supported' } }))
        return
      }

      // 3. Extract Bearer token
      const authHeader = req.headers.authorization
      let bearerToken: string | undefined
      if (authHeader && authHeader.startsWith('Bearer ')) {
        bearerToken = authHeader.slice(7).trim()
      }

      // 4. Read body with byte length check
      const bodyStr = await this.readRequestBody(req)
      const parsedBody = JSON.parse(bodyStr) as Partial<InboundRequest>

      // Inject token if supplied in Authorization header
      if (bearerToken && !parsedBody.token) {
        parsedBody.token = bearerToken
      }

      // 5. Execute inbound domain request
      const receipt = await this.service.executeInboundRequest(parsedBody as InboundRequest)

      res.statusCode = 200
      res.end(JSON.stringify(receipt))
    } catch (err: unknown) {
      if (err instanceof InboundDomainError) {
        res.statusCode = err.status
        res.end(
          JSON.stringify({
            error: {
              code: err.code,
              message: err.message,
            },
          }),
        )
        return
      }

      // General fallback
      const message = err instanceof Error ? err.message : String(err)
      res.statusCode = 500
      res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message } }))
    }
  }

  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let totalBytes = 0
      const chunks: Buffer[] = []

      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (totalBytes > MAX_INBOUND_PAYLOAD_BYTES) {
          req.destroy()
          reject(
            new InboundDomainError(
              'PAYLOAD_SIZE_EXCEEDED',
              `Payload exceeds limit of ${MAX_INBOUND_PAYLOAD_BYTES} bytes`,
              413,
            ),
          )
          return
        }
        chunks.push(chunk)
      })

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'))
      })

      req.on('error', reject)
    })
  }
}
