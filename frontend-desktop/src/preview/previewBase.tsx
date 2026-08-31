import { createContext, useContext } from 'react'
import { LOCAL_BASE, baseOf } from '@/api/backends'

// 预览层的请求前缀。文件预览读的是**工作区文件**，而工作区在哪个后端取决于会话
// （云端会话的文件在云上那个实例里），所以预览也必须按会话定址——否则云端会话的
// 文件会被拿去问地端后端要，永远 403。
//
// 为什么用 context 而不是给每个 viewer 加参数：viewer 有十来个、层级也深，逐个透传
// 会把"这个文件属于哪个后端"这件与渲染无关的事扩散到每个组件签名里。预览一次只服务
// 一个会话，正是 context 的典型场景。
const PreviewBaseContext = createContext<string>(LOCAL_BASE)

export function PreviewBaseProvider({ sessionId, children }: {
  sessionId: string | null | undefined
  children: React.ReactNode
}) {
  return (
    <PreviewBaseContext.Provider value={baseOf(sessionId)}>
      {children}
    </PreviewBaseContext.Provider>
  )
}

export function usePreviewBase(): string {
  return useContext(PreviewBaseContext)
}
