/** Settings that affect the generated game, excluding board layout and project title. */
export function generationKey(project) {
  if (!project) return null;
  const { name, blueprint, ...settings } = project;
  return JSON.stringify({ ...settings, blueprint: {
    ...blueprint, nodes: blueprint.nodes.map(({ x, y, ...node }) => node),
  } });
}
