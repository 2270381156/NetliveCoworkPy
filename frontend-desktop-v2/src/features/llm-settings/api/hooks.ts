import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/shared/api/queryKeys'
import { llmsApi } from '@/api/llms'

// LLM 账号 feature 的数据层(铁律:组件只调这些 hook,不直接用 useQuery/useMutation)。
// hook 内部负责缓存失效(queryKeys.llms());组件用 mutate 的 per-call onSuccess/onError
// 处理自身 UI 局部状态(modelPings / newModel / addError 等)。

export function useLlmProviders() {
  return useQuery({ queryKey: queryKeys.llms(), queryFn: llmsApi.list })
}

export function useDeleteProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => llmsApi.delete(name),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.llms() }) },
  })
}

/** 添加模型(先 ping 验证可用性,成功再持久化),返回 { provider, latency }。 */
export function useAddModel(providerName: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (modelName: string) => {
      const ping = await llmsApi.pingRegistered(providerName, modelName)
      if (!ping.ok) throw new Error(ping.error || '连接失败')
      const provider = await llmsApi.addModel(providerName, modelName)
      return { provider, latency: ping.latency_ms }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.llms() }) },
  })
}

export function useRemoveModel(providerName: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (model: string) => llmsApi.removeModel(providerName, model),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.llms() }) },
  })
}

export function useSetDefaultModel(providerName: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (model: string) => llmsApi.setDefault(providerName, model),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.llms() }) },
  })
}

/** ping 已注册账号的某模型(只读探针,不动缓存)。 */
export function usePingModel(providerName: string) {
  return useMutation({
    mutationFn: (model: string) => llmsApi.pingRegistered(providerName, model),
  })
}

/** 新建账号表单里,用临时凭证 ping 某模型(只读探针)。 */
export function usePingAdhoc() {
  return useMutation({
    mutationFn: (req: { style: string; api_key: string; base_url?: string; model: string }) =>
      llmsApi.ping(req),
  })
}

export function useRegisterProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: Parameters<typeof llmsApi.register>[0]) => llmsApi.register(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.llms() }) },
  })
}
