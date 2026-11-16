/** Actual registrations owned by this plugin, including partner-managed MCPs.
 * Never infer ownership from a tool name or from its presence in the host. */
const globalOwner = Symbol('partner-global-tools')
const revisions = new WeakMap<object, number>()
export function partnerToolRevision(store: object): number { return revisions.get(store) ?? 0 }
function changed(store: object): void { revisions.set(store, partnerToolRevision(store) + 1) }
const registrations = new WeakMap<object, Map<string | symbol, Map<object, Set<string>>>>()

export function trackPartnerTools(store: object, owner: string | symbol, names: Iterable<string>): () => void {
  let owners = registrations.get(store)
  if (!owners) { owners = new Map(); registrations.set(store, owners) }
  let scopes = owners.get(owner)
  if (!scopes) { scopes = new Map(); owners.set(owner, scopes) }
  const token = {}, current = scopes
  current.set(token, new Set(names))
  changed(store)
  return () => {
    if (!current.delete(token)) return
    changed(store)
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
