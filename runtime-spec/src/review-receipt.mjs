import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fingerprint, stableStringify } from './index.mjs'

const reviewIdPattern = /^review_[a-f0-9]{40}$/
const allowedSourceExtensions = new Set(['.json', '.sql', '.yaml', '.yml'])

async function sourceFiles(root) {
  const candidates = ['lacify.runtime.yaml']
  for (const directory of ['actors', 'tests']) {
    const start = path.join(root, directory)
    try {
      const pending = [start]
      while (pending.length) {
        const current = pending.pop()
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const absolute = path.join(current, entry.name)
          if (entry.isDirectory()) pending.push(absolute)
          else if (entry.isFile() && allowedSourceExtensions.has(path.extname(entry.name))) candidates.push(path.relative(root, absolute))
          if (candidates.length > 2048) throw new Error('Review is limited to 2,048 canonical source files.')
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return [...new Set(candidates)].sort()
}

async function createSourceManifest(root) {
  const manifest = []
  let totalBytes = 0
  for (const relative of await sourceFiles(root)) {
    const contents = await readFile(path.join(root, relative))
    totalBytes += contents.byteLength
    if (totalBytes > 16 * 1024 * 1024) throw new Error('Review source files exceed the 16 MiB safety bound.')
    manifest.push({
      path: relative.split(path.sep).join('/'),
      bytes: contents.byteLength,
      hash: fingerprint(contents.toString('utf8').replace(/\r\n/g, '\n')),
    })
  }
  return manifest
}

function boundedPlans(plans) {
  return plans.map(({ actor, valid, issues, alreadyApplied, planId, pending }) => ({
    actor,
    valid,
    planId,
    alreadyApplied,
    pending: pending.map(({ id, checksum, classification, operations }) => ({
      id,
      checksum,
      classification,
      changes: Object.entries((operations || []).reduce((counts, operation) => ({
        ...counts,
        [operation.classification]: (counts[operation.classification] || 0) + 1,
      }), {})).map(([change, count]) => ({ change, count })),
    })),
    diagnostics: issues.slice(0, 100),
  }))
}

export async function createReviewReceipt({ root, project, plans, tests }) {
  const sourceManifest = await createSourceManifest(root)
  const planIds = plans.map(({ planId }) => planId).sort()
  const sourceManifestFingerprint = fingerprint(sourceManifest)
  const binding = {
    receiptVersion: 2,
    projectFingerprint: project.fingerprint,
    environment: 'development',
    planIds,
    sourceManifestFingerprint,
  }
  const reviewId = `review_${fingerprint(binding).slice(0, 40)}`
  const receipt = {
    version: 'lacify.dev/review/v2',
    reviewId,
    project: project.project.runtime.project,
    environment: 'development',
    projectFingerprint: project.fingerprint,
    sourceManifestFingerprint,
    sourceFiles: sourceManifest,
    plans: boundedPlans(plans),
    tests: {
      passed: tests.passed === true,
      count: Array.isArray(tests.tests) ? tests.tests.length : 0,
      files: Array.isArray(tests.tests) ? tests.tests.map(({ file, name, steps }) => ({ file, name, steps })) : [],
    },
    summary: {
      actors: project.project.actors.length,
      operations: project.project.actors.reduce((sum, actor) => sum + actor.operations.length, 0),
      pendingMigrations: plans.reduce((sum, plan) => sum + plan.pending.length, 0),
    },
    binding,
  }
  return Object.freeze(receipt)
}

export async function saveReviewReceipt(root, receipt) {
  const directory = path.join(root, '.lacify', 'reviews')
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${receipt.reviewId}.json`)
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`
  try {
    await writeFile(file, serialized, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await readFile(file, 'utf8')
    if (stableStringify(JSON.parse(existing)) !== stableStringify(receipt)) {
      throw new Error('Review receipt identity collision detected; no file was overwritten.')
    }
  }
  return file
}

export async function readReviewReceipt(root, reviewId) {
  if (!reviewIdPattern.test(reviewId)) throw new Error('Review ID must match review_<40 lowercase hex characters>.')
  const file = path.join(root, '.lacify', 'reviews', `${reviewId}.json`)
  let receipt
  try {
    receipt = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Review receipt "${reviewId}" does not exist.`)
    throw new Error(`Review receipt "${reviewId}" is not valid JSON.`)
  }
  return { file, receipt }
}

export function verifyReviewReceipt(receipt, current) {
  if (receipt?.version !== 'lacify.dev/review/v2' || receipt.reviewId !== current.reviewId) {
    throw new Error('Review replay blocked because the receipt identity is invalid or the repository changed.')
  }
  if (stableStringify(receipt.binding) !== stableStringify(current.binding)) {
    throw new Error('Review replay blocked because the project fingerprint, source files, or migration plans changed.')
  }
  if (receipt.tests?.passed !== true || current.tests.passed !== true) {
    throw new Error('Review replay blocked because local operation tests did not pass.')
  }
  return true
}
