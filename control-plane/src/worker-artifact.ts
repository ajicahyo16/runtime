/**
 * Releases compiled before worker.js was introduced contain the fixed Lacify
 * worker template as TypeScript. Convert only that known template, then reject
 * the upload if any TypeScript-only syntax remains. New releases already contain
 * JavaScript and pass through unchanged.
 */
export function generatedWorkerJavaScript(source: string) {
  let javascript = source
    .replace(/export interface Env \{[\s\S]*?\}\s*/, '')
    .replace(/^\s*sql: any;\s*$/gm, '')
    .replace(/constructor\(ctx: DurableObjectState, env: Env\)/g, 'constructor(ctx, env)')
    .replace(/async fetch\(request: Request, env: Env\): Promise<Response>/g, 'async fetch(request, env)')
    .replace(/async fetch\(request: Request\): Promise<Response>/g, 'async fetch(request)')
    .replace(/let body:\s*\{\s*command\?: unknown;\s*payload\?: unknown\s*\};/g, 'let body;')
    .replace(/ as \{ state: string; version: number \} \| undefined/g, '')

  if (!javascript.includes("url.pathname === '/health'")) {
    javascript = javascript.replace(
      '    const url = new URL(request.url);',
      "    const url = new URL(request.url);\n    if (url.pathname === '/health' && request.method === 'GET') {\n      return Response.json({ ok: true, service: 'lacify-runtime' });\n    }",
    )
  }

  const unsupported = /\binterface\s+Env\b|:\s*(?:DurableObjectState|DurableObjectNamespace|Env|Request|Promise<|any\b)|:\s*Response(?=\s*[,);={])|\b(?:command|payload)\?:|\bas\s+\{/.exec(javascript)
  if (unsupported) {
    throw new Error(`The release Worker still contains unsupported TypeScript syntax near "${unsupported[0]}". Compile a new release with the JavaScript artifact compiler.`)
  }
  return javascript
}
