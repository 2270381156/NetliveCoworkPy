/**
 * 开机拉阵容的重试规则。
 *
 * 这里钉的是一条**用户报过的故障**：新用户第一次打开、在应用里登录，整个这一程都显示
 * "你没有任何 Cowork 权限"，重启才好。原因是阵容只在开机拉那一次，之后再没人更新过。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { bootstrapCoworks, refreshCoworks } from './coworks'
import { getAgents, hydrateAgents } from '@/agents/registry'
import { lineupState } from '@/agents/lineup'
import { http } from './client'

const ROW = { id: 'mbb', display_name: 'MBB Cowork', subtitle: '', accent: '#2563eb' }

describe('bootstrapCoworks', () => {
  // 阵容是模块级的，测试之间会串：上一条留下的 agents 会让下一条直接判成 ready。
  beforeEach(() => { vi.restoreAllMocks(); hydrateAgents([]) })

  it('拉失败要再试——后端常比窗口晚起来一步，一次不成不代表没有', async () => {
    const get = vi.spyOn(http, 'get')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce([ROW])
    await bootstrapCoworks(5, 0)
    expect(get).toHaveBeenCalledTimes(3)
    expect(getAgents().map(a => a.id)).toEqual(['mbb'])
    expect(lineupState()).toBe('ready')
  })

  it('一直失败 → 认输，报"没拉到"而不是"没权限"', async () => {
    // 两者该让用户做的事完全相反：一个是等/重试，一个是去找管理员申请。
    vi.spyOn(http, 'get').mockRejectedValue(new Error('ECONNREFUSED'))
    await bootstrapCoworks(3, 0)
    expect(lineupState()).toBe('unreachable')
  })

  it('拉到了但是空的 → **不重试**，空是个确定答案', async () => {
    // 再问一百遍还是空，白等几秒只让"没权限"这句话来得更晚。这种情况靠的是主进程装完
    // 套件之后喊的那一声（onCoworksChanged），不是靠这里死等。
    const get = vi.spyOn(http, 'get').mockResolvedValue([])
    await bootstrapCoworks(5, 0)
    expect(get).toHaveBeenCalledTimes(1)
    expect(lineupState()).toBe('none')
  })

  it('refreshCoworks 能把"没权限"翻回"有"——登录后/管理员刚开通就靠它', async () => {
    vi.spyOn(http, 'get').mockResolvedValue([])
    await bootstrapCoworks(1, 0)
    expect(lineupState()).toBe('none')

    vi.spyOn(http, 'get').mockResolvedValue([ROW])
    await refreshCoworks()
    expect(lineupState()).toBe('ready')
    expect(getAgents().map(a => a.id)).toEqual(['mbb'])
  })
})
