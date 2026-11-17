/** Narrow compatibility patch for hosts whose catalog has no removal record. */
export function patchSubagentCatalog(source) {
 const marker='// dsh-partner: remove only entries backed by a committed cleanup record'
 let next=source
 if(!source.includes(marker)){
 const needle='\t\tif (event.type !== "subagent/catalog" || event.seq < state.inheritedEventCount) return state;'
 if(source.split(needle).length!==2)throw Error('Unrecognized native subagent catalog implementation')
 const replacement=`\t\t${marker}
\t\tif (event.type === "plugin:dsh-partner/subagent-cleaned" && event.ignorable === true && event.seq >= state.inheritedEventCount) {
\t\t\tconst data = event.data;
\t\t\tif (data === null || typeof data !== "object" || data.version !== 1 || typeof data.childId !== "string" || typeof data.runId !== "string" || typeof data.ownerCompanionId !== "string") return state;
\t\t\tlet head;
\t\t\tfor (const entry of iterateChunkedList(state.head)) if (entry.childId !== data.childId) head = appendChunkedList(head, entry);
\t\t\treturn { ...state, head };
\t\t}
${needle}`
 next=source.replace(needle,replacement)
 const start=next.indexOf('const subagentCatalogProjectionDefinition = {'),end=next.indexOf('\n};',start)
 if(start<0||end<0||!next.slice(start,end).includes('stateVersion: 6,'))throw Error('Unrecognized native catalog state version')
 next=next.slice(0,start)+next.slice(start,end).replace('stateVersion: 6,','stateVersion: 7,')+next.slice(end)
 }
 const reservationMarker='// dsh-partner: retired names remain reserved for native historical uniqueness'
 if(!next.includes(reservationMarker)){
  const reservation='return this.names.reserve(parent, catalogNames(this.host.catalogOf(parent.session)), requested);'
  if(next.split(reservation).length!==2)throw Error('Unrecognized native subagent name allocator')
  next=next.replace(reservation,`${reservationMarker}
		const committed = catalogNames(this.host.catalogOf(parent.session));
		for (const event of parent.session.snapshotEvents()) {
			if (event.type === "subagent/catalog" && parent.session.isOwnSeq(event.seq) && typeof event.data.name === "string") committed.add(event.data.name);
		}
		return this.names.reserve(parent, committed, requested);`)
 }
 return next
}
