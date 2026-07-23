function pascal(value) {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
}

function sqlObjects(migrations) {
  const objects = []
  for (const migration of migrations) {
    for (const match of migration.sql.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*?)\)\s*;/gi)) {
      if (match[1].startsWith('_lacify_')) continue
      const fields = match[2].split(',').map((column) => column.trim().match(/^["`[]?([a-zA-Z_][a-zA-Z0-9_]*)/)?.[1]).filter(Boolean)
      objects.push({ name: pascal(match[1]), fields: [...new Set(fields)].join(', ') || 'id' })
    }
  }
  return objects.length ? objects : [{ name: 'State', fields: 'id' }]
}

export function canonicalProjectToContracts(loadedProject) {
  return loadedProject.project.actors.map((actor) => {
    const id = actor.source.split('/')[2]
    const objects = sqlObjects(actor.migrations)
    const states = (actor.definition.stateMachines || []).map((machine, index) => ({
      obj: objects[Math.min(index, objects.length - 1)].name,
      flow: [machine.initial, ...machine.states.filter((state) => state !== machine.initial)],
    }))
    return {
      id,
      name: actor.definition.name,
      aggregateType: actor.definition.name,
      key: actor.definition.partitionBy,
      size: '0 B',
      queries: 0,
      status: 'dormant',
      objects,
      actions: actor.definition.commands,
      states,
      migrations: actor.migrations.map(({ id, sql }) => ({ id, sql })),
      operations: (actor.operations || []).map(({ definition, sql }) => ({ definition, sql })),
    }
  })
}
