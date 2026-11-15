import { stdin, stdout } from 'node:process'
import { CreationCli, CliArgumentError, CLI_EXIT_CODES, parseCliArgs } from './creation-cli.ts'
import { MAX_INBOUND_PAYLOAD_BYTES } from '../../src/shared/inbound-domain-contract.ts'

function validateEndpoint(endpoint: string | undefined): string {
  // Match the inbound API's literal loopback authority; URL normalization must not add aliases.
  if (!endpoint || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?(?:\/api\/inbound|\/)?$/.test(endpoint)) {
    throw new CliArgumentError('CLI_EXPLICIT_LOOPBACK_ENDPOINT_REQUIRED')
  }
  try {
    const url = new URL(endpoint)
    if (url.port && Number(url.port) === 0) throw new Error('Invalid port')
  } catch {
    throw new CliArgumentError('CLI_INVALID_ENDPOINT')
  }
  return endpoint
}

async function readCredential(): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_INBOUND_PAYLOAD_BYTES) throw new CliArgumentError('CLI_STDIN_LIMIT_EXCEEDED', CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR)
    chunks.push(bytes)
  }
  const credential = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  if (!credential || /[\r\n]/.test(credential)) {
    throw new CliArgumentError('CLI_SINGLE_CREDENTIAL_REQUIRED', CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR)
  }
  return credential
}

try {
  const argv = process.argv.slice(2)
  const { flags, positionals } = parseCliArgs(argv)
  const help = !positionals[0] || positionals[0] === 'help'
  const endpoint = help ? '' : validateEndpoint(flags.endpoint)
  let token = process.env.PAGEKIN_API_TOKEN || ''
  let humanReviewToken = process.env.PAGEKIN_HUMAN_REVIEW_TOKEN || ''
  if ((flags['token-stdin'] && flags['human-review-token-stdin'])
    || (flags['token-stdin'] && token) || (flags['human-review-token-stdin'] && humanReviewToken)) {
    throw new CliArgumentError('CLI_AMBIGUOUS_CREDENTIAL_SOURCE', CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR)
  }
  if (flags['token-stdin']) token = await readCredential()
  if (flags['human-review-token-stdin']) humanReviewToken = await readCredential()
  const cli = new CreationCli({ endpoint, token, humanReviewToken,
    callerId: flags.callerId, projectId: flags.projectId, grantId: flags.grantId })
  const result = await cli.executeCli(argv)
  stdout.write(`${result.output}\n`)
  process.exitCode = result.exitCode
} catch (error: unknown) {
  // Bootstrap errors never include input, credentials, a remote body or a stack trace.
  const exitCode = error instanceof CliArgumentError ? error.exitCode : CLI_EXIT_CODES.FAILED
  stdout.write(`${JSON.stringify({ exitCode, error: error instanceof CliArgumentError ? error.message : 'CLI_PROCESS_FAILED' })}\n`)
  process.exitCode = exitCode
}
