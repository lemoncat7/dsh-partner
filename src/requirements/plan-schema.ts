import { contractParameters } from '../tasks/contract.js'

export const planParameters = {
  submissionKey: { type: 'string', maxLength: 120, description: 'Stable unique key for this exact plan. Reuse it on transport retries, never regenerate a key to retry. A changed plan needs explicit reconciliation and a new key.' },
  autoRun: { type: 'boolean', description: 'submit_plan: default true for requested execution; false saves the WHOLE plan without running it.' },
  completeScope: { type: 'boolean', description: 'submit_plan: default false. true confirms the whole requirement scope, enabling automatic final archive after all children pass review. Independent of autoRun.' },
  tasks: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['key', 'title', 'assigneeCompanionId', 'reviewerCompanionId'], properties: {
    key: { type: 'string', maxLength: 80 }, title: { type: 'string', maxLength: 200 }, description: { type: 'string', maxLength: 8000 },
    assigneeCompanionId: { type: 'string', description: 'Actual executor stable ID from authorized directory, not a name.' },
    reviewerCompanionId: { type: 'string', minLength: 1, description: 'Explicit authorized reviewer stable ID. When a specialist is designated to verify this deliverable, use that specialist here, not just as executor of a later review task. Dependencies wait for acceptance, not merely execution. Use creator ID only when no other reviewer was designated. Overall synthesis may be a separate task; it does not replace task acceptance.' },
    dependsOn: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'Other task KEYS within this same plan; forward references are supported.' },
    dependencyTaskIds: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'Existing task IDs within the original requirement.' },
    priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
    skillIds: { type: 'array', maxItems: 20, items: { type: 'string' } }, ...contractParameters,
  } } },
}
