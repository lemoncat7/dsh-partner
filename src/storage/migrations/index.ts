import { v0ToV1 } from './v0-to-v1.js'
export { migrationPath, runMigrationPath } from './registry.js'
export const storageMigrations = [v0ToV1] as const
