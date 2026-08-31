// 迁移期 shim:http 客户端已迁到 @/shared/api/client。旧 `./client` 导入继续可用(strangler)。
export { http } from '@/shared/api/client'
