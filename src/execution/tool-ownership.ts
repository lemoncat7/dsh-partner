/** Actual registrations owned by this plugin, including partner-managed MCPs.
 * Never infer ownership from a tool name or from its presence in the host. */
const globalOwner = Symbol('partner-global-tools')
const registrations = new WeakMap<object, Map<string | symbol, Map<object, Set<string>>>>()

export function trackPartnerTools(store: object, owner: string | symbol, names: Iterable<string>): () => void {
  let owners = registrations.get(store)
  if (!owners) { owners = new Map(); registrations.set(store, owners) }
  let scopes = owners.get(owner)
  if (!scopes) { scopes = new Map(); owners.set(owner, scopes) }
  const token = {}, current = scopes
  current.set(token, new Set(names))
  return () => {
    current.delete(token)
    if (!current.size && owners.get(owner) === current) owners.delete(owner)
  }
}

export function isPartnerOwnedTool(store: object, owner: string, name: string): boolean {
  const owners = registrations.get(store)
  return [owner, globalOwner].some(key => [...(owners?.get(key)?.values() ?? [])].some(names => names.has(name)))
}

export function trackGlobalPartnerTools(store: object, names: Iterable<string>): () => void {
  return trackPartnerTools(store, globalOwner, names)
}
