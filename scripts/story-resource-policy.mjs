// Paths are relative to the upstream snapshot, not to the installed skill.
// Examples are completed projects, not dependencies of the seven skill modules.
export function excludedStoryResourcePrefixes(id) {
  return id === 'novel-game-creation' ? ['examples/'] : []
}

export function includeStoryResource(id, path) {
  return !path.endsWith('/.gitignore') && path !== '.gitignore'
    && !excludedStoryResourcePrefixes(id).some(prefix => path.startsWith(prefix))
}
