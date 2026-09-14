import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { storageLayout, storageVersion, TARGET_STORAGE_VERSION } from './layout.js'
import { exists } from './safe-files.js'

export interface StorageConfig { storageVersion: number; transactionId: string; workspaceRoot: string }
export const storageConfigPath = (statePath:string) => join(dirname(resolve(statePath)),'storage-config.json')
export async function readStorageConfig(statePath:string,root:string,configured=0):Promise<StorageConfig> {
  const path=storageConfigPath(statePath)
  if(!await exists(path)) {
    if(configured!==0)throw Error('缺少迁移提交配置，不能手动启用新版目录')
    return {storageVersion:0,transactionId:'',workspaceRoot:resolve(root)}
  }
  const value=JSON.parse(await readFile(path,'utf8')) as StorageConfig
  if (!value || typeof value !== 'object' || !Number.isInteger(value.storageVersion) || typeof value.transactionId !== 'string') throw Error('存储配置无效，拒绝猜测数据版本')
  const version=storageVersion(value.storageVersion)
  if(version>TARGET_STORAGE_VERSION)throw Error('数据版本高于插件支持版本，拒绝写入')
  if(value.workspaceRoot!==resolve(root))throw Error('数据根目录已变化，请恢复配置后再迁移，不能静默创建新伙伴数据')
  if(configured>version)throw Error('插件配置与已提交的数据版本不一致')
  if(version===1) {
    const layout=storageLayout(resolve(statePath),resolve(root))
    const manifest=JSON.parse(await readFile(join(layout.publicRoot,'migration-owner.json'),'utf8'))
    if(manifest.transactionId!==value.transactionId)throw Error('迁移配置与目录提交标记不一致')
  }
  return value
}
