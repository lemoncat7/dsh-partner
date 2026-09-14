import type { StorageMigration } from './registry.js'
import { migrateLayout, verifyInstalledLayout, type LayoutMigrationContext } from '../migrate-layout.js'

/** Owns only the v0 -> v1 transition. Later layouts get separate modules. */
export const v0ToV1: StorageMigration<LayoutMigrationContext> = {
  id: 'v0-to-v1-private-public-layout',
  from: 0,
  to: 1,
  title: '公共数据归档与伙伴 .partner 私有目录',
  execute: async context => { context.result=await migrateLayout(context.statePath,context.root,context.state) },
  verify: verifyInstalledLayout,
}
