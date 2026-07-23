import { dump } from 'js-yaml'

function sqlName(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()
}

function pascal(value) {
  const normalized = value.replace(/[^A-Za-z0-9]+(.)/g, (_, character) => character.toUpperCase())
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

export function visualContractsToFiles(projectId, contracts) {
  if (!contracts.length) throw new Error('The visual project has no Actor contracts to export.')
  const actors = contracts.map((contract) => {
    const actorName = pascal(contract.aggregateType)
    const actorId = sqlName(contract.id).replaceAll('_', '-')
    const definition = {
      version: 'lacify.dev/actor/v1',
      name: actorName,
      description: `Exported from visual contract ${contract.id}.`,
      partitionBy: contract.key,
      storage: 'sqlite',
      commands: [...contract.actions],
      ...(contract.states?.length ? {
        stateMachines: contract.states.map((state) => ({
          name: `${pascal(state.obj)}Lifecycle`,
          initial: state.flow[0],
          states: state.flow,
          transitions: state.flow.slice(1).map((to, index) => ({
            command: contract.actions[Math.min(index, contract.actions.length - 1)],
            from: state.flow[index],
            to,
          })),
        })),
      } : {}),
    }
    const sql = contract.objects.map((object) => {
      const fields = String(object.fields || 'id').split(',').map((field) => sqlName(field.trim())).filter(Boolean)
      const uniqueFields = [...new Set(['id', ...fields])]
      return `CREATE TABLE ${sqlName(object.name)} (\n${uniqueFields.map((field) => `  ${field} TEXT${field === 'id' ? ' PRIMARY KEY' : ''}`).join(',\n')}\n);`
    }).join('\n\n')
    return {
      actorId,
      actorPath: `./actors/${actorId}/actor.yaml`,
      actorYaml: dump(definition, { noRefs: true, lineWidth: 120 }),
      migrationSql: `${sql}\n`,
    }
  })
  const runtime = {
    version: 'lacify.dev/v1',
    project: projectId,
    runtime: 'request-response',
    actors: actors.map(({ actorPath }) => actorPath),
  }
  return { runtimeYaml: dump(runtime, { noRefs: true, lineWidth: 120 }), actors }
}
