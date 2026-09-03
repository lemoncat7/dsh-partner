import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  boundedConcernCheckMinutes, clamp, concernDecay, concernInterval, extractConcernResources, focusedConcernQuery, implicitConcernRejection,
  interruptDecision, MAX_IMPLICIT_CONCERNS_PER_BATCH, normalizeConcernSubject,
  concernLifecycleRequest, selectConcernLifecycleTarget,
  type ConcernActivity, type ConcernCandidate, type ConcernObservation, type ConcernObservationCandidate,
  type AppliedConcernLifecycleDirective, type ConcernOrigin, type ConcernState, type ObservationDecision, type PartnerConcern,
} from './concern-domain.js'

type SqlRow = Record<string, unknown>
export interface LegacyConcernSeed { scopeId: string; subject: string; reason: string; confidence: number; origin: ConcernOrigin }
export interface ConcernDueOptions { now?: number; limit?: number; includeFuture?: boolean; concernId?: string }
export type ConcernCandidateSource = 'reflection' | 'daily_review' | 'tool' | 'ui'
export type ConcernAuditDecision = 'created' | 'updated' | 'resolved' | 'dismissed' | 'rejected' | 'ignored'
export interface ConcernApplyOptions {
  source?: ConcernCandidateSource
  sessionId?: string
  evidence?: string
  maxImplicitCreates?: number
}
export interface ConcernApplyEntry {
  subject: string
  decision: ConcernAuditDecision
  reason: string
  concern?: PartnerConcern
}
export interface ConcernApplyResult {
  created: PartnerConcern[]
  entries: ConcernApplyEntry[]
}
export interface PendingConcernNotice {
  auditIds: string[]
  concerns: PartnerConcern[]
}

export class PartnerConcernStore {
  private readonly writes = new Map<string, Promise<void>>()

  constructor(private readonly root: string) {}

  async migrateLegacy(companionId: string, seeds: LegacyConcernSeed[]): Promise<boolean> {
    await this.serial(this.path(companionId), async () => {
      const database = await this.open(companionId)
      try {
        if (database.prepare("SELECT value FROM concern_meta WHERE key = 'legacy-focus-migrated'").get()) return
        database.exec('BEGIN IMMEDIATE')
        const now = Date.now()
        for (const item of seeds) this.upsert(database, companionId, item.scopeId, {
          subject: item.subject, reason: item.reason, operation: 'upsert', priority: item.origin === 'explicit' ? .9 : .58,
          confidence: item.confidence, watchKind: 'auto', watchQuery: item.subject,
        }, item.origin, now)
        database.prepare("INSERT INTO concern_meta (key, value) VALUES ('legacy-focus-migrated', ?)").run(String(now))
        database.exec('COMMIT')
      } catch (error) { rollback(database); throw error } finally { database.close() }
    })
    return true
  }

  async applyCandidates(
    companionId: string,
    scopeId: string,
    candidates: ConcernCandidate[],
    origin: ConcernOrigin,
    at = Date.now(),
    options: ConcernApplyOptions = {},
  ): Promise<PartnerConcern[]> {
    return (await this.ingestCandidates(companionId, scopeId, candidates, origin, at, options)).created
  }

  async ingestCandidates(
    companionId: string,
    scopeId: string,
    candidates: ConcernCandidate[],
    origin: ConcernOrigin,
    at = Date.now(),
    options: ConcernApplyOptions = {},
  ): Promise<ConcernApplyResult> {
    if (candidates.length === 0) return { created: [], entries: [] }
    return this.serialValue(this.path(companionId), async () => {
      const database = await this.open(companionId)
      const created: PartnerConcern[] = []
      const entries: ConcernApplyEntry[] = []
      const source = options.source ?? (origin === 'explicit' ? 'ui' : 'reflection')
      const maxImplicitCreates = Math.min(
        MAX_IMPLICIT_CONCERNS_PER_BATCH,
        Math.max(0, options.maxImplicitCreates ?? MAX_IMPLICIT_CONCERNS_PER_BATCH),
      )
      try {
        database.exec('BEGIN IMMEDIATE')
        for (const candidate of candidates.slice(0, 12)) {
          const normalized = normalizeConcernSubject(compact(candidate.subject, 300))
          const existing = normalized ? this.existing(database, companionId, scopeId, normalized) : undefined
          const directEvidence = source === 'tool' || source === 'reflection' ? options.evidence : undefined
          const rejection = origin === 'implicit' ? implicitConcernRejection(candidate, directEvidence) : undefined
          if (rejection !== undefined || (origin === 'implicit' && candidate.operation === 'upsert' && existing === undefined && created.length >= maxImplicitCreates)) {
            const reason = rejection ?? `每批最多新增 ${maxImplicitCreates} 条隐式关注`
            const entry: ConcernApplyEntry = { subject: compact(candidate.subject, 300), decision: 'rejected', reason }
            entries.push(entry)
            this.audit(database, companionId, scopeId, origin, candidate, entry, at, options)
            continue
          }
          const concern = this.upsert(database, companionId, scopeId, candidate, origin, at)
          if (concern !== undefined) created.push(concern)
          const current = concern ?? existing
          const decision: ConcernAuditDecision = candidate.operation === 'resolve'
            ? existing === undefined ? 'ignored' : 'resolved'
            : candidate.operation === 'dismiss'
              ? existing === undefined ? 'ignored' : 'dismissed'
              : existing === undefined ? 'created' : 'updated'
          const reason = decision === 'created' ? origin === 'implicit' ? '通过隐式关注策略并创建' : '根据用户明确要求创建'
            : decision === 'updated' ? '与已有关注同主题，已合并更新'
              : decision === 'ignored' ? '没有找到可关闭的同主题关注'
                : decision === 'resolved' ? '已有关注已闭环'
                  : '已有关注已归档'
          const entry: ConcernApplyEntry = { subject: compact(candidate.subject, 300), decision, reason, ...(current === undefined ? {} : { concern: current }) }
          entries.push(entry)
          this.audit(database, companionId, scopeId, origin, candidate, entry, at, options)
        }
        database.prepare('DELETE FROM concern_audit WHERE companion_id = ? AND created_at < ?').run(companionId, at - 90 * 86_400_000)
        database.exec('COMMIT')
      } catch (error) { rollback(database); throw error } finally { database.close() }
      return { created, entries }
    })
  }

  async createExplicit(companionId: string, scopeId: string, subject: string, reason = ''): Promise<PartnerConcern> {
    const descriptor = explicitConcernDescriptor(subject)
    await this.applyCandidates(companionId, scopeId, [{
      subject: descriptor.subject, reason: reason || '用户明确要求伙伴留意', operation: 'upsert', priority: .9,
      confidence: 1, watchKind: descriptor.watchKind, watchQuery: descriptor.watchQuery, resources: descriptor.resources,
    }], 'explicit', Date.now(), { source: 'ui' })
    const concern = (await this.list(companionId, scopeId)).find(item => normalizeConcernSubject(item.subject) === normalizeConcernSubject(descriptor.subject))
    if (!concern) throw new Error('concern could not be created')
    return concern
  }

  async applyUserDirective(
    companionId: string,
    scopeId: string,
    value: string,
    now = Date.now(),
  ): Promise<AppliedConcernLifecycleDirective | undefined> {
    const request = concernLifecycleRequest(value)
    if (request === undefined) return undefined
    return this.serialValue(this.path(companionId), async () => {
      const database = await this.open(companionId)
      try {
        const rows = database.prepare(`SELECT * FROM concerns WHERE companion_id = ? AND scope_id IN (?, '*')
          AND state != 'archived' ORDER BY score DESC, updated_at DESC LIMIT 80`).all(companionId, scopeId) as SqlRow[]
        const target = selectConcernLifecycleTarget(request, rows.map(concernFromRow))
        if (target === undefined) return undefined
        if (request.action === 'ignore') database.prepare("UPDATE concerns SET state = 'archived', updated_at = ? WHERE id = ?").run(now, target.id)
        else database.prepare("UPDATE concerns SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?").run(now, now, target.id)
        return { ...request, concernId: target.id, subject: target.subject }
      } finally { database.close() }
    })
  }

  async list(companionId: string, scopeId?: string, includeArchived = false, limit = 100): Promise<PartnerConcern[]> {
    const database = await this.open(companionId)
    try {
      const states = includeArchived ? '' : "AND state NOT IN ('archived')"
      const rows = scopeId === undefined
        ? database.prepare(`SELECT * FROM concerns WHERE companion_id = ? ${states} ORDER BY score DESC, updated_at DESC LIMIT ?`).all(companionId, limit)
        : database.prepare(`SELECT * FROM concerns WHERE companion_id = ? AND scope_id = ? ${states} ORDER BY score DESC, updated_at DESC LIMIT ?`).all(companionId, scopeId, limit)
      return (rows as SqlRow[]).map(concernFromRow)
    } finally { database.close() }
  }

  async due(companionId: string, scopeId: string, options: ConcernDueOptions = {}): Promise<PartnerConcern[]> {
    const now = options.now ?? Date.now()
    const limit = options.limit ?? 12
    return this.serialValue(this.path(companionId), async () => {
      const database = await this.open(companionId)
      try {
        database.exec('BEGIN IMMEDIATE')
        const rows = database.prepare(`SELECT * FROM concerns WHERE companion_id = ? AND scope_id IN (?, '*')
          AND state IN ('active', 'watching') AND (? = 1 OR next_check_at <= ?)
          AND (? IS NULL OR id = ?)
          ORDER BY priority DESC, next_check_at ASC LIMIT ?`).all(
          companionId, scopeId, options.includeFuture ? 1 : 0, now, options.concernId ?? null, options.concernId ?? null, Math.max(limit, 24),
        ) as SqlRow[]
        const due: PartnerConcern[] = []
        const update = database.prepare('UPDATE concerns SET score = ?, state = ? WHERE id = ?')
        for (const row of rows) {
          const item = concernFromRow(row)
          const score = concernDecay(item.score, item.lastActivityAt, now, item.origin)
          if (item.origin === 'implicit' && score < .18) {
            update.run(score, 'archived', item.id)
            continue
          }
          if (score !== item.score) update.run(score, item.state, item.id)
          if (due.length < limit) due.push({ ...item, score })
        }
        database.exec('COMMIT')
        return due
      } catch (error) { rollback(database); throw error } finally { database.close() }
    })
  }

  async recordObservations(concerns: PartnerConcern[], candidates: ConcernObservationCandidate[], now = Date.now(), userRecentlyActive = false): Promise<{ observations: ConcernObservation[]; notifications: ConcernObservation[] }> {
    if (concerns.length === 0) return { observations: [], notifications: [] }
    const companionId = concerns[0]!.companionId
    return this.serialValue(this.path(companionId), async () => {
      const database = await this.open(companionId)
      const observations: ConcernObservation[] = []
      try {
        database.exec('BEGIN IMMEDIATE')
        const byConcern = new Map(candidates.map(item => [item.concernId, item]))
        for (const concern of concerns) {
          const candidate = byConcern.get(concern.id)
          const chosenMinutes = boundedConcernCheckMinutes(candidate?.nextCheckInMinutes)
          const nextCheckAt = now + (chosenMinutes === undefined ? concernInterval(concern.priority, concern.origin) : chosenMinutes * 60_000)
          if (!candidate?.changed || !candidate.event.trim()) {
            database.prepare('UPDATE concerns SET last_checked_at = ?, next_check_at = ?, score = ? WHERE id = ?').run(now, nextCheckAt, concern.score, concern.id)
            continue
          }
          const fingerprint = observationFingerprint(candidate)
          const duplicateRow = database.prepare('SELECT * FROM concern_observations WHERE concern_id = ? AND fingerprint = ?').get(concern.id, fingerprint) as SqlRow | undefined
          const previousCount = number((database.prepare('SELECT COUNT(*) AS count FROM concern_observations WHERE concern_id = ?').get(concern.id) as SqlRow | undefined)?.count)
          const recentlyMentioned = concern.lastMentionedAt !== undefined && now - concern.lastMentionedAt < 72 * 3_600_000
          const novelty = duplicateRow ? number(duplicateRow.novelty) : previousCount === 0 ? .5 : 1
          const ruleReason = compact(candidate.notificationRuleReason ?? '', 800)
          const knowledgeLinked = concern.resources.some(resource => resource.kind === 'knowledge')
          const notificationRuleEffect = knowledgeLinked && ruleReason
            ? candidate.notificationRuleEffect ?? 'auto'
            : 'auto'
          const decision = interruptDecision({
            priority: concern.priority, concernConfidence: concern.confidence,
            observationConfidence: clamp(candidate.confidence), relevance: clamp(candidate.relevance), novelty,
            actionability: clamp(candidate.actionability), recentlyMentioned,
            firstObservation: duplicateRow ? novelty < 1 : previousCount === 0, userRecentlyActive,
            notificationRuleEffect,
          })
          const observation: ConcernObservation = {
            id: duplicateRow ? string(duplicateRow.id) : `observation-${randomUUID()}`,
            concernId: concern.id, companionId: concern.companionId, scopeId: concern.scopeId, fingerprint,
            event: duplicateRow ? string(duplicateRow.event) : compact(candidate.event, 800),
            evidence: duplicateRow ? string(duplicateRow.evidence) : compact(candidate.evidence, 2_000),
            source: duplicateRow ? string(duplicateRow.source) : compact(candidate.source, 240),
            novelty, relevance: clamp(candidate.relevance), confidence: clamp(candidate.confidence), actionability: clamp(candidate.actionability),
            interruptScore: decision.score, decision: decision.decision, notificationRuleEffect,
            notificationRuleReason: ruleReason, decisionReason: decision.reason,
            createdAt: duplicateRow ? number(duplicateRow.created_at) : now,
            ...(duplicateRow?.mentioned_at === null || duplicateRow?.mentioned_at === undefined ? {} : { mentionedAt: number(duplicateRow.mentioned_at) }),
          }
          if (duplicateRow) {
            const previousDecision = string(duplicateRow.decision) as ObservationDecision
            const preserveNotification = previousDecision === 'notify'
              && (observation.mentionedAt !== undefined || observation.notificationRuleEffect !== 'suppress')
            if (preserveNotification) {
              observation.decision = 'notify'
              observation.interruptScore = number(duplicateRow.interrupt_score)
              observation.notificationRuleEffect = string(duplicateRow.rule_effect || 'auto') as ConcernObservation['notificationRuleEffect']
              observation.notificationRuleReason = string(duplicateRow.rule_reason)
              observation.decisionReason = string(duplicateRow.decision_reason) || '此变化已进入待提醒队列'
            } else {
              database.prepare(`UPDATE concern_observations SET relevance = ?, confidence = ?, actionability = ?,
                interrupt_score = ?, decision = ?, rule_effect = ?, rule_reason = ?, decision_reason = ? WHERE id = ?`).run(
                observation.relevance, observation.confidence, observation.actionability, observation.interruptScore,
                observation.decision, observation.notificationRuleEffect, observation.notificationRuleReason, observation.decisionReason, observation.id,
              )
            }
            if (previousDecision !== 'notify' && observation.decision === 'notify' && observation.mentionedAt === undefined) observations.push(observation)
          } else {
            insertObservation(database, observation)
            observations.push(observation)
          }
          const nextState: ConcernState = observation.decision === 'notify' || observation.decision === 'feed' ? 'active' : 'watching'
          database.prepare(`UPDATE concerns SET state = ?, last_checked_at = ?, next_check_at = ?, score = ?, updated_at = ? WHERE id = ?`).run(
            nextState, now, nextCheckAt, Math.max(concern.score, observation.interruptScore), now, concern.id,
          )
        }
        database.exec('COMMIT')
      } catch (error) { rollback(database); throw error } finally { database.close() }
      return { observations, notifications: observations.filter(item => item.decision === 'notify') }
    })
  }

  async activity(companionId: string, limit = 60): Promise<ConcernActivity> {
    const database = await this.open(companionId)
    try {
      const concerns = (database.prepare("SELECT * FROM concerns WHERE companion_id = ? AND state != 'archived' ORDER BY score DESC, updated_at DESC LIMIT 200").all(companionId) as SqlRow[]).map(concernFromRow)
      const observations = (database.prepare("SELECT * FROM concern_observations WHERE companion_id = ? AND decision IN ('defer', 'feed', 'notify') ORDER BY created_at DESC LIMIT ?").all(companionId, limit) as SqlRow[]).map(observationFromRow)
      return { concerns, observations }
    } finally { database.close() }
  }

  async pendingToolCreationNotices(companionId: string, scopeId: string, sessionId: string, limit = 4): Promise<PendingConcernNotice> {
    const database = await this.open(companionId)
    try {
      const rows = database.prepare(`SELECT audit.id AS audit_id, concerns.* FROM concern_audit AS audit
        JOIN concerns ON concerns.id = audit.concern_id
        WHERE audit.companion_id = ? AND audit.scope_id = ? AND audit.session_id = ?
          AND audit.source = 'tool' AND audit.origin = 'implicit' AND audit.decision = 'created' AND audit.notified_at IS NULL
          AND concerns.state NOT IN ('resolved', 'archived')
        ORDER BY audit.created_at ASC LIMIT ?`).all(companionId, scopeId, sessionId, Math.max(1, Math.min(12, limit))) as SqlRow[]
      return { auditIds: rows.map(row => string(row.audit_id)), concerns: rows.map(concernFromRow) }
    } finally { database.close() }
  }

  async markCreationAuditsNotified(companionId: string, auditIds: string[], at = Date.now()): Promise<void> {
    if (auditIds.length === 0) return
    await this.serial(this.path(companionId), async () => {
      const database = await this.open(companionId)
      try {
        database.exec('BEGIN IMMEDIATE')
        const update = database.prepare('UPDATE concern_audit SET notified_at = ? WHERE companion_id = ? AND id = ? AND notified_at IS NULL')
        for (const id of [...new Set(auditIds)].slice(0, 20)) update.run(at, companionId, id)
        database.exec('COMMIT')
      } catch (error) { rollback(database); throw error } finally { database.close() }
    })
  }

  async deferred(companionId: string, scopeId: string, query: string, limit = 3): Promise<ConcernObservation[]> {
    const database = await this.open(companionId)
    try {
      const rows = database.prepare(`SELECT * FROM concern_observations WHERE companion_id = ? AND scope_id IN (?, '*')
        AND decision = 'defer' AND mentioned_at IS NULL ORDER BY interrupt_score DESC, created_at DESC LIMIT 30`).all(companionId, scopeId) as SqlRow[]
      const terms = tokens(query)
      return rows.map(observationFromRow).map(item => ({ item, score: lexicalScore(`${item.event} ${item.evidence}`, terms) + item.interruptScore }))
        .filter(item => terms.length === 0 || item.score > .45).sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.item)
    } finally { database.close() }
  }

  async pendingNotifications(companionId: string, scopeId: string, limit = 4): Promise<ConcernObservation[]> {
    const database = await this.open(companionId)
    try {
      return (database.prepare(`SELECT * FROM concern_observations WHERE companion_id = ? AND scope_id IN (?, '*')
        AND decision = 'notify' AND mentioned_at IS NULL ORDER BY interrupt_score DESC, created_at ASC LIMIT ?`).all(companionId, scopeId, limit) as SqlRow[]).map(observationFromRow)
    } finally { database.close() }
  }

  async markMentioned(companionId: string, observationIds: string[], now = Date.now()): Promise<void> {
    if (observationIds.length === 0) return
    await this.serial(this.path(companionId), async () => {
      const database = await this.open(companionId)
      try {
        database.exec('BEGIN IMMEDIATE')
        const updateObservation = database.prepare('UPDATE concern_observations SET mentioned_at = ? WHERE companion_id = ? AND id = ?')
        const updateConcern = database.prepare('UPDATE concerns SET last_mentioned_at = ?, updated_at = ? WHERE companion_id = ? AND id = (SELECT concern_id FROM concern_observations WHERE id = ?)')
        for (const id of observationIds) { updateObservation.run(now, companionId, id); updateConcern.run(now, now, companionId, id) }
        database.exec('COMMIT')
      } catch (error) { rollback(database); throw error } finally { database.close() }
    })
  }

  async act(companionId: string, concernId: string, action: 'watch' | 'ignore' | 'prioritize' | 'resolve', now = Date.now()): Promise<void> {
    await this.serial(this.path(companionId), async () => {
      const database = await this.open(companionId)
      try {
        const concern = database.prepare('SELECT * FROM concerns WHERE companion_id = ? AND id = ?').get(companionId, concernId) as SqlRow | undefined
        if (!concern) throw new Error('concern was not found')
        if (action === 'ignore') database.prepare("UPDATE concerns SET state = 'archived', updated_at = ? WHERE id = ?").run(now, concernId)
        if (action === 'resolve') database.prepare("UPDATE concerns SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?").run(now, now, concernId)
        if (action === 'watch') database.prepare("UPDATE concerns SET state = 'watching', score = MAX(score, .72), last_activity_at = ?, next_check_at = ?, updated_at = ? WHERE id = ?").run(now, now, now, concernId)
        if (action === 'prioritize') database.prepare("UPDATE concerns SET state = 'active', priority = 1, score = 1, last_activity_at = ?, next_check_at = ?, updated_at = ? WHERE id = ?").run(now, now, now, concernId)
      } finally { database.close() }
    })
  }

  async clear(companionId: string): Promise<void> {
    await this.serial(this.path(companionId), () => rm(join(this.root, 'partners', companionId, 'concerns'), { recursive: true, force: true }))
  }

  private upsert(database: DatabaseSync, companionId: string, scopeId: string, candidate: ConcernCandidate, origin: ConcernOrigin, at: number): PartnerConcern | undefined {
    const subject = compact(candidate.subject, 300)
    const normalized = normalizeConcernSubject(subject)
    if (!normalized) return undefined
    const existing = database.prepare(`SELECT * FROM concerns WHERE companion_id = ? AND normalized_subject = ? AND scope_id IN (?, '*')
      ORDER BY CASE WHEN origin = 'explicit' THEN 0 ELSE 1 END LIMIT 1`).get(companionId, normalized, scopeId) as SqlRow | undefined
    if (candidate.operation === 'resolve' || candidate.operation === 'dismiss') {
      if (!existing) return undefined
      const state = candidate.operation === 'resolve' ? 'resolved' : 'archived'
      database.prepare('UPDATE concerns SET state = ?, resolved_at = ?, updated_at = ? WHERE id = ?').run(state, state === 'resolved' ? at : null, at, string(existing.id))
      return undefined
    }
    const priority = clamp(candidate.priority)
    const confidence = clamp(candidate.confidence)
    const score = clamp(priority * .55 + confidence * .45)
    const nextCheckAt = at + concernInterval(priority, origin)
    if (existing && string(existing.scope_id) !== scopeId) {
      const resources = resourcesJson(candidate.resources)
      database.prepare(`UPDATE concerns SET subject = ?, reason = ?, state = 'watching', priority = MAX(priority, ?),
        confidence = MAX(confidence, ?), score = MAX(score, ?), watch_kind = ?, watch_query = ?,
        resources_json = CASE WHEN ? = '[]' THEN resources_json ELSE ? END, updated_at = ?,
        last_activity_at = ?, next_check_at = MIN(next_check_at, ?), resolved_at = NULL WHERE id = ?`).run(
        subject, compact(candidate.reason, 800), priority, confidence, score, candidate.watchKind,
        compact(candidate.watchQuery || subject, 500), resources, resources, at, at, nextCheckAt, string(existing.id),
      )
      return undefined
    }
    const id = `concern-${randomUUID()}`
    database.prepare(`INSERT INTO concerns
      (id, companion_id, scope_id, normalized_subject, subject, reason, origin, state, priority, confidence, score,
       watch_kind, watch_query, resources_json, created_at, updated_at, last_activity_at, next_check_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'watching', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(companion_id, scope_id, normalized_subject) DO UPDATE SET
      subject=excluded.subject, reason=excluded.reason, origin=CASE WHEN concerns.origin='explicit' THEN 'explicit' ELSE excluded.origin END,
      state='watching', priority=MAX(concerns.priority, excluded.priority), confidence=MAX(concerns.confidence, excluded.confidence),
      score=MAX(concerns.score, excluded.score), watch_kind=excluded.watch_kind, watch_query=excluded.watch_query,
      resources_json=CASE WHEN excluded.resources_json='[]' THEN concerns.resources_json ELSE excluded.resources_json END,
      updated_at=excluded.updated_at, last_activity_at=excluded.last_activity_at, next_check_at=MIN(concerns.next_check_at, excluded.next_check_at), resolved_at=NULL`).run(
      id, companionId, scopeId, normalized, subject, compact(candidate.reason, 800), origin,
      priority, confidence, score, candidate.watchKind, compact(candidate.watchQuery || subject, 500), resourcesJson(candidate.resources), at, at, at, nextCheckAt,
    )
    const created = database.prepare('SELECT * FROM concerns WHERE id = ?').get(id) as SqlRow | undefined
    return created === undefined ? undefined : concernFromRow(created)
  }

  private existing(database: DatabaseSync, companionId: string, scopeId: string, normalized: string): PartnerConcern | undefined {
    const row = database.prepare(`SELECT * FROM concerns WHERE companion_id = ? AND normalized_subject = ? AND scope_id IN (?, '*')
      ORDER BY CASE WHEN origin = 'explicit' THEN 0 ELSE 1 END LIMIT 1`).get(companionId, normalized, scopeId) as SqlRow | undefined
    return row === undefined ? undefined : concernFromRow(row)
  }

  private audit(
    database: DatabaseSync,
    companionId: string,
    scopeId: string,
    origin: ConcernOrigin,
    candidate: ConcernCandidate,
    entry: ConcernApplyEntry,
    at: number,
    options: ConcernApplyOptions,
  ): void {
    database.prepare(`INSERT INTO concern_audit
      (id, concern_id, companion_id, scope_id, session_id, source, origin, operation, subject, reason, evidence,
       decision, decision_reason, created_at, notified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
      `concern-audit-${randomUUID()}`, entry.concern?.id ?? null, companionId, scopeId, options.sessionId ?? null,
      options.source ?? (origin === 'explicit' ? 'ui' : 'reflection'), origin, candidate.operation,
      compact(candidate.subject, 300), compact(candidate.reason, 800), compact(options.evidence ?? '', 1_200),
      entry.decision, compact(entry.reason, 400), at,
    )
  }

  private async open(companionId: string): Promise<DatabaseSync> {
    const directory = join(this.root, 'partners', companionId, 'concerns')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const database = new DatabaseSync(this.path(companionId))
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS concern_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS concerns (
        id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, scope_id TEXT NOT NULL, normalized_subject TEXT NOT NULL,
        subject TEXT NOT NULL, reason TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL,
        priority REAL NOT NULL, confidence REAL NOT NULL, score REAL NOT NULL,
        watch_kind TEXT NOT NULL, watch_query TEXT NOT NULL, resources_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
        next_check_at INTEGER NOT NULL, last_checked_at INTEGER, last_mentioned_at INTEGER, resolved_at INTEGER,
        UNIQUE(companion_id, scope_id, normalized_subject)
      );
      CREATE INDEX IF NOT EXISTS concerns_due ON concerns(companion_id, scope_id, state, next_check_at);
      CREATE INDEX IF NOT EXISTS concerns_score ON concerns(companion_id, score DESC, updated_at DESC);
      CREATE TABLE IF NOT EXISTS concern_observations (
        id TEXT PRIMARY KEY, concern_id TEXT NOT NULL, companion_id TEXT NOT NULL, scope_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, event TEXT NOT NULL, evidence TEXT NOT NULL, source TEXT NOT NULL,
        novelty REAL NOT NULL, relevance REAL NOT NULL, confidence REAL NOT NULL, actionability REAL NOT NULL,
        interrupt_score REAL NOT NULL, decision TEXT NOT NULL, rule_effect TEXT NOT NULL DEFAULT 'auto',
        rule_reason TEXT NOT NULL DEFAULT '', decision_reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, mentioned_at INTEGER,
        UNIQUE(concern_id, fingerprint), FOREIGN KEY(concern_id) REFERENCES concerns(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS observations_feed ON concern_observations(companion_id, decision, created_at DESC);
      CREATE INDEX IF NOT EXISTS observations_deferred ON concern_observations(companion_id, scope_id, decision, mentioned_at, created_at DESC);
      CREATE TABLE IF NOT EXISTS concern_audit (
        id TEXT PRIMARY KEY, concern_id TEXT, companion_id TEXT NOT NULL, scope_id TEXT NOT NULL, session_id TEXT,
        source TEXT NOT NULL, origin TEXT NOT NULL, operation TEXT NOT NULL, subject TEXT NOT NULL, reason TEXT NOT NULL,
        evidence TEXT NOT NULL, decision TEXT NOT NULL, decision_reason TEXT NOT NULL, created_at INTEGER NOT NULL, notified_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS concern_audit_session ON concern_audit(companion_id, scope_id, session_id, source, decision, notified_at, created_at);
      PRAGMA user_version = 4;`)
    ensureColumn(database, 'concerns', 'resources_json', "TEXT NOT NULL DEFAULT '[]'")
    ensureColumn(database, 'concern_observations', 'rule_effect', "TEXT NOT NULL DEFAULT 'auto'")
    ensureColumn(database, 'concern_observations', 'rule_reason', "TEXT NOT NULL DEFAULT ''")
    ensureColumn(database, 'concern_observations', 'decision_reason', "TEXT NOT NULL DEFAULT ''")
    migrateReferenceOnlyConcerns(database)
    return database
  }

  private path(companionId: string): string { return join(this.root, 'partners', companionId, 'concerns', 'concerns.sqlite') }
  private async serial(key: string, task: () => Promise<void>): Promise<void> { await this.serialValue(key, task) }
  private async serialValue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(key) ?? Promise.resolve()
    let value!: T
    const current = previous.catch(() => {}).then(async () => { value = await task() })
    this.writes.set(key, current)
    try { await current; return value } finally { if (this.writes.get(key) === current) this.writes.delete(key) }
  }
}

function concernFromRow(row: SqlRow): PartnerConcern {
  return {
    id: string(row.id), companionId: string(row.companion_id), scopeId: string(row.scope_id), subject: string(row.subject), reason: string(row.reason),
    origin: string(row.origin) as PartnerConcern['origin'], state: string(row.state) as ConcernState,
    priority: number(row.priority), confidence: number(row.confidence), score: number(row.score),
    watchKind: string(row.watch_kind) as PartnerConcern['watchKind'], watchQuery: string(row.watch_query), resources: parseResources(row.resources_json),
    createdAt: number(row.created_at), updatedAt: number(row.updated_at), lastActivityAt: number(row.last_activity_at), nextCheckAt: number(row.next_check_at),
    ...(row.last_checked_at === null ? {} : { lastCheckedAt: number(row.last_checked_at) }),
    ...(row.last_mentioned_at === null ? {} : { lastMentionedAt: number(row.last_mentioned_at) }),
    ...(row.resolved_at === null ? {} : { resolvedAt: number(row.resolved_at) }),
  }
}

function observationFromRow(row: SqlRow): ConcernObservation {
  return {
    id: string(row.id), concernId: string(row.concern_id), companionId: string(row.companion_id), scopeId: string(row.scope_id),
    fingerprint: string(row.fingerprint), event: string(row.event), evidence: string(row.evidence), source: string(row.source),
    novelty: number(row.novelty), relevance: number(row.relevance), confidence: number(row.confidence), actionability: number(row.actionability),
    interruptScore: number(row.interrupt_score), decision: string(row.decision) as ObservationDecision,
    notificationRuleEffect: string(row.rule_effect || 'auto') as ConcernObservation['notificationRuleEffect'],
    notificationRuleReason: string(row.rule_reason), decisionReason: string(row.decision_reason), createdAt: number(row.created_at),
    ...(row.mentioned_at === null ? {} : { mentionedAt: number(row.mentioned_at) }),
  }
}

function insertObservation(database: DatabaseSync, item: ConcernObservation): void {
  database.prepare(`INSERT INTO concern_observations
    (id, concern_id, companion_id, scope_id, fingerprint, event, evidence, source, novelty, relevance, confidence,
     actionability, interrupt_score, decision, rule_effect, rule_reason, decision_reason, created_at, mentioned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    item.id, item.concernId, item.companionId, item.scopeId, item.fingerprint, item.event, item.evidence, item.source,
    item.novelty, item.relevance, item.confidence, item.actionability, item.interruptScore, item.decision,
    item.notificationRuleEffect, item.notificationRuleReason, item.decisionReason, item.createdAt, item.mentionedAt ?? null,
  )
}

function observationFingerprint(value: ConcernObservationCandidate): string {
  return createHash('sha256').update(`${value.concernId}\n${normalizeConcernSubject(value.event)}\n${normalizeConcernSubject(value.evidence)}\n${value.source}`).digest('hex')
}
function tokens(value: string): string[] { return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 40) }
function lexicalScore(value: string, terms: string[]): number {
  if (terms.length === 0) return 0
  const text = value.toLocaleLowerCase()
  return terms.filter(term => text.includes(term)).length / terms.length
}
function compact(value: string, max: number): string { const text = value.replace(/\s+/g, ' ').trim(); return text.length <= max ? text : `${text.slice(0, max - 1)}…` }

function explicitConcernDescriptor(value: string): Pick<ConcernCandidate, 'subject' | 'watchKind' | 'watchQuery'> & { resources: PartnerConcern['resources'] } {
  const resources = extractConcernResources(value)
  const remainder = compact(value
    .replace(/@知识库\[[^\]]+\]/gu, ' ')
    .replace(/(?:^|\s)@(?:"[^"]+"|[^\s]+)/gu, ' ')
    .replace(/^(?:(?:请|麻烦|帮我|替我|让(?:伙伴|你)?)[，,：:\s]*)?(?:关注|留意|盯着|跟进|惦记|记着)[，,：:\s]*/u, '')
    .replace(/(?:一下|这件事|这个|这些)[。！!？?\s]*$/u, ''), 300)
  const resourceSubjects = resources.map(resource => {
    if (resource.kind === 'file') return resource.locator
    const slash = resource.locator.indexOf('/')
    return slash < 0 ? resource.label : resource.locator.slice(slash + 1).trim()
  }).filter(Boolean)
  const primary = resourceSubjects[0] ?? ''
  const subject = remainder
    ? primary && !remainder.toLocaleLowerCase('zh-CN').includes(primary.toLocaleLowerCase('zh-CN')) ? `${primary} · ${remainder}` : remainder
    : primary || compact(value, 300)
  const watchQuery = compact(focusedConcernQuery([...resourceSubjects, remainder].filter((item, index, all) => item && all.indexOf(item) === index).join(' ')), 500) || subject
  const kinds = new Set(resources.map(item => item.kind))
  const watchKind = kinds.size === 1 && kinds.has('knowledge') ? 'knowledge' : kinds.size === 1 && kinds.has('file') ? 'workspace' : 'auto'
  return { subject, watchKind, watchQuery, resources }
}

function migrateReferenceOnlyConcerns(database: DatabaseSync): void {
  if (database.prepare("SELECT value FROM concern_meta WHERE key = 'reference-subject-normalized-v1'").get()) return
  database.exec('BEGIN IMMEDIATE')
  try {
    const rows = database.prepare("SELECT id, companion_id, scope_id, subject, resources_json FROM concerns WHERE origin = 'explicit' AND resources_json != '[]'").all() as SqlRow[]
    const update = database.prepare('UPDATE concerns SET normalized_subject = ?, subject = ?, watch_kind = ?, watch_query = ? WHERE id = ?')
    for (const row of rows) {
      const raw = string(row.subject)
      const descriptor = explicitConcernDescriptor(raw)
      if (descriptor.subject === raw || descriptor.resources.length === 0) continue
      const normalized = normalizeConcernSubject(descriptor.subject)
      const duplicate = database.prepare('SELECT id FROM concerns WHERE companion_id = ? AND scope_id = ? AND normalized_subject = ? AND id != ?').get(
        string(row.companion_id), string(row.scope_id), normalized, string(row.id),
      )
      if (!duplicate) update.run(normalized, descriptor.subject, descriptor.watchKind, descriptor.watchQuery, string(row.id))
    }
    database.prepare("INSERT INTO concern_meta (key, value) VALUES ('reference-subject-normalized-v1', ?)").run(String(Date.now()))
    database.exec('COMMIT')
  } catch (error) { rollback(database); throw error }
}
function resourcesJson(value: ConcernCandidate['resources']): string {
  return JSON.stringify((value ?? []).slice(0, 8).map(item => ({ kind: item.kind, locator: compact(item.locator, 500), label: compact(item.label, 240) }))
    .filter(item => (item.kind === 'file' || item.kind === 'knowledge') && item.locator))
}
function parseResources(value: unknown): PartnerConcern['resources'] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap(item => {
      if (typeof item !== 'object' || item === null) return []
      const resource = item as Record<string, unknown>
      if ((resource.kind !== 'file' && resource.kind !== 'knowledge') || typeof resource.locator !== 'string' || typeof resource.label !== 'string') return []
      return [{ kind: resource.kind as 'file' | 'knowledge', locator: compact(resource.locator, 500), label: compact(resource.label, 240) }]
    }).slice(0, 8)
  } catch { return [] }
}
function ensureColumn(database: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]
  if (!columns.some(item => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
function string(value: unknown): string { return typeof value === 'string' ? value : String(value ?? '') }
function number(value: unknown): number { return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number(value ?? 0) }
function rollback(database: DatabaseSync): void { try { database.exec('ROLLBACK') } catch { /* no active transaction */ } }
