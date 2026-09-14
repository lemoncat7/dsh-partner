import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerInboxStore } from '../lib/notifications/store.js'
import { syncStorageNotice } from '../lib/storage/notice.js'

for (const partitioned of [false, true]) test(`storage reminder persists acknowledgement, clears after upgrade; partitioned=${partitioned}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-notice-'))
  const open = () => partitioned
    ? PartnerInboxStore.openPartitioned(join(root, 'inbox.sqlite'), () => { throw Error('System notice must not create a companion') })
    : PartnerInboxStore.open(join(root, 'inbox.sqlite'))
  let inbox = await open()
  try {
    syncStorageNotice(inbox, 0, 1)
    const first = inbox.snapshot().items[0]
    assert.equal(first.action, 'storage-migration')
    assert.equal(inbox.snapshot().unread, 1)
    syncStorageNotice(inbox, 0, 1)
    assert.equal(inbox.snapshot().items.length, 1)
    inbox.markRead([first.id]); inbox.close(); inbox = await open()
    syncStorageNotice(inbox, 0, 1)
    assert.equal(inbox.snapshot().unread, 0)
    assert.equal(inbox.snapshot().items[0].createdAt, first.createdAt)
    syncStorageNotice(inbox, 1, 2)
    assert.equal(inbox.snapshot().items.length, 1)
    assert.equal(inbox.snapshot().unread, 1)
    syncStorageNotice(inbox, 2, 2)
    assert.equal(inbox.snapshot().items.length, 0)
  } finally { inbox.close(); await rm(root, { recursive: true, force: true }) }
})
