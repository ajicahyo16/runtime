import type { Actor } from '@/components/ActorCard'

export interface ContractValidationIssue {
  path: string
  message: string
}

export interface ContractValidationResult {
  valid: boolean
  issues: ContractValidationIssue[]
}

const identifier = /^[A-Za-z][A-Za-z0-9]*$/
const contractId = /^[a-z0-9][a-z0-9-_]{0,62}$/

const duplicateValues = (values: string[]) => new Set(values.map((value) => value.trim().toLocaleLowerCase())).size !== values.length

/** Validates the minimum runtime contract before it can be compiled or saved. */
export function validateContract(actor: Actor): ContractValidationResult {
  const issues: ContractValidationIssue[] = []
  const objects = actor.objects ?? []
  const actions = actor.actions ?? []
  const states = actor.states ?? []

  if (!contractId.test(actor.id || '')) issues.push({ path: 'id', message: 'Aggregate ID must use 1–63 lowercase letters, numbers, hyphens, or underscores.' })
  if (!actor.name?.trim()) issues.push({ path: 'name', message: 'Aggregate name is required.' })
  if (!identifier.test(actor.aggregateType || '')) issues.push({ path: 'aggregateType', message: 'Aggregate type must be a valid identifier.' })
  if (!identifier.test(actor.key || '')) issues.push({ path: 'key', message: 'Partition key must be a valid identifier.' })

  const objectNames = objects.map((object) => object.name?.trim() || '')
  if (!objectNames.length) issues.push({ path: 'objects', message: 'Add at least one business object.' })
  if (objectNames.some((name) => !identifier.test(name))) issues.push({ path: 'objects', message: 'Every business object needs a valid identifier.' })
  if (duplicateValues(objectNames)) issues.push({ path: 'objects', message: 'Business object names must be unique.' })

  if (!actions.length) issues.push({ path: 'actions', message: 'Add at least one business command.' })
  if (actions.some((action) => !identifier.test(action?.trim() || ''))) issues.push({ path: 'actions', message: 'Every command needs a valid identifier.' })
  if (duplicateValues(actions)) issues.push({ path: 'actions', message: 'Command names must be unique.' })

  const stateObjects = states.map((state) => state.obj?.trim() || '')
  if (duplicateValues(stateObjects)) issues.push({ path: 'states', message: 'An object can have only one state machine.' })
  states.forEach((state, index) => {
    if (!objectNames.includes(state.obj)) issues.push({ path: `states.${index}.obj`, message: `State machine "${state.obj}" must reference an existing business object.` })
    const flow = state.flow ?? []
    if (flow.length < 2) issues.push({ path: `states.${index}.flow`, message: `State machine "${state.obj}" needs at least two states.` })
    if (flow.some((name) => !identifier.test(name?.trim() || ''))) issues.push({ path: `states.${index}.flow`, message: `States for "${state.obj}" must be valid identifiers.` })
    if (duplicateValues(flow)) issues.push({ path: `states.${index}.flow`, message: `States for "${state.obj}" must be unique.` })
  })

  return { valid: issues.length === 0, issues }
}
