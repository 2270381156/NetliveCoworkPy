import { http } from './client'
import { hydrateAgents, type CoworkDTO } from '@/agents/registry'
import { noteLineupFetched } from '@/agents/lineup'

/**
 * cowork 清单 —— "这台机器上现在能用哪几个"。
 *
 * **打地端**：cowork 是装在本机的（云端下发后落到本地数据目录），地端后端知道装了什么；
 * 云端实例装的是同一批（设计文档 §3quater 云地必须一致），不必分别问两边。
 */
export const coworksApi = {
  list: () => http.get<CoworkDTO[]>('/coworks'),
}

/**
 * 启动时拉一次并填进注册表。**不抛**：拿不到就维持空阵容，界面显示"尚未开通"而不是崩掉。
 *
 * 拉不到与"一个都没装"要分得开（设计文档 §4.4）：前者是故障、后者是没权限。这里返回是否
 * 成功，由调用方决定怎么呈现——本函数不替它决定。
 */
export async function loadCoworks(): Promise<boolean> {
  try {
    hydrateAgents(await coworksApi.list())
    return true
  } catch {
    return false
  }
}

/**
 * 重新拉一次并广播。**阵容不是只在开机时定下来的**：
 *
 *   · 用户在应用里登录 → 这时才拿得到套件，主进程装完会通知我们（onCoworksChanged）
 *   · 每天那次对账装了新的 / 收回了旧的
 *   · 空态上用户自己点「重试」
 *
 * 少了这条路，界面就永远停在开机那一刻的答案，用户只能靠重启——而"为什么重启就好了"
 * 他无从知道。
 */
export async function refreshCoworks(): Promise<boolean> {
  const ok = await loadCoworks()
  noteLineupFetched(ok)
  return ok
}

/**
 * 开机那次：**拉不到就再试几次**，试完才认输。
 *
 * 只对"拉失败"重试，不对"拉到了但是空的"重试：空是一个确定的答案（这个人现在确实一个
 * 都没开通），再问一百遍还是空，白等几秒还让"没权限"这句话来得更晚。而拉失败往往只是
 * 后端比窗口慢了一步（dev 态窗口根本不等后端），一秒后再问就有了。
 *
 * 重试期间状态停在 pending，界面显示"正在获取"——不是"你没有权限"。把一次没连上说成
 * 没权限，用户会跑去找管理员开通一个他其实已经有的东西。
 */
export async function bootstrapCoworks(tries = 5, gapMs = 1200): Promise<void> {
  for (let i = 1; i <= tries; i++) {
    if (await loadCoworks()) { noteLineupFetched(true); return }
    if (i < tries) await new Promise(r => setTimeout(r, gapMs))
  }
  noteLineupFetched(false)
}
