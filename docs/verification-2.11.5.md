# 2.11.5 verification — 2026-10-28

- Node 22 build succeeded. Full `node --test test/*.test.mjs`: **802 / 802 passed**.
- Behavioral coverage: real-user inactivity, night/day quiet windows, per-owner cap, no repeat without reply, simultaneous tick claim, persistent restart deduplication, active-turn avoidance, input during claim, disabled concerns heartbeat, coexistence with concern continuations, exact route delivery, revocation/config-change/new-input suppression.
- Archive `/tmp/lemoncat7-dsh-partner-2.11.5.tgz`: 7,765,962 bytes. Package/resource/hash checks passed; Apache license and asset provenance are included.
- Deployed container `dsh-docker-dsh-1`: healthy, restart count 0. Backup: `dsh-docker/backups/partner-2115-k7nkh1Ij`. All 14 companions preserved.
- Production sticker API returns 20 entries. Every image SHA-256 matches the unmodified official Volpeon archive recorded in `blobfox-manifest.json`.
- Real browser verified identity tab, idle toggle color/thumb position, selected route and idle interval, sticker preview/source link, and dialog close at 1280px and 375px in light/dark themes. Screenshots: `/tmp/partner-idle-2115-QlrhJL/`. Reviewed mobile idle and desktop sticker screenshots.
- Browser changed only unsaved drafts; companion snapshot was identical before/after. No test message sent to real channels and no automatic contact enabled on existing companions. Generation/delivery races were exercised with isolated test doubles, not unsolicited production messages.
- Browser command uses `PLAYWRIGHT_BROWSERS_PATH=/home/moye/.cache/ms-playwright` and `PARTNER_PLAYWRIGHT_MODULE=/home/moye/Online Document/infinite-canvas/node_modules/playwright/index.mjs` with `ops/verify-idle-stickers.mjs`.
