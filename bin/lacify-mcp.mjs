#!/usr/bin/env node
import readline from 'node:readline'
import { LacifyMcpService, handleMcpRequest } from '../runtime-spec/src/mcp-service.mjs'
import { remoteClient } from '../runtime-spec/src/remote-client.mjs'

const remote = await remoteClient().catch(() => null)
const service = new LacifyMcpService({ remote })
const input = readline.createInterface({ input: process.stdin, terminal: false })
for await (const line of input) {
  if (!line.trim()) continue
  let request
  try {
    request = JSON.parse(line)
    const result = await handleMcpRequest(service, request)
    if (request.id !== undefined && result !== null) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error.' } })}\n`)
  }
}
