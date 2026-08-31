/**
 * 云端工作区选择器 —— **本分支是个占位**。
 *
 * 云地协同不在本期范围（需求 §2.2），而 `probeCloud()` 恒返回不可用，
 * 所以调用它的那段分支永远渲染不到。
 *
 * ⚠ **保留这个文件而不是把调用点删掉**，理由同 `api/backends.ts`：
 * 接云端时把这里换成真实实现即可，NewSessionDialog 一行都不用改。
 * 删掉的话要回头在那个已经很长的组件里重新织进去，而织错不报错——
 * 只是"新建云端会话"少了选文件夹这一步。
 */
export function CloudFolderPicker(_props: {
  value?: string
  onChange?: (name: string, path: string) => void
  enabled?: boolean
}) {
  return null
}
