// MUST be the first import: pdfSetup sets `globalThis.pdfjsLib` via side effect,
// which pdfjs-dist/web/pdf_viewer.mjs destructures at module load time. Placing
// it at the application entry guarantees the global is installed before any
// later import path reaches pdf_viewer.mjs (a second-line defence; PdfViewer.tsx
// also imports pdfSetup before pdf_viewer).
import './preview/viewers/pdf/pdfSetup'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './index.css'
import App from './App'
import { LanguageProvider } from './i18n'
import { applyCloudSession, applyFactoryConfig } from './api/backends'
import { bootstrapCoworks, refreshCoworks } from './api/coworks'

// 出厂配置（app-config.json 的 cloudBackendUrl）→ 后端登记簿；随后向主进程要一次
// 云端会话（substrate 发票 → Hub 换令牌），把**按这个人算出来的**地址回填进去。
//
// 不 await：拿不到或慢了都不该拖住首屏；地址到位后 backends 会广播，订阅方自行刷新。
// 浏览器 dev 下没有 electronAPI，直接跳过，走 localStorage / 构建期变量那两级。
//
// ⚠ 这里**只拿地址，拿不到令牌**。Hub 令牌全程留在主进程，由它按 origin 注入到每个
//   云端请求上 —— 包括 SSE 与 <img src> 这类 JS 加不上头的（见 electron/lib/substrate.js）。
// cowork 阵容：**运行期**从地端后端拉，不再由 branding.json 构建期内联——能用哪几个是按
// 这个用户的权限下发的，内联那份是打包时固定的全量，装几个都显示七个。
// 同样不 await：拉到之前阵容为空，到了会广播，订阅方（useCurrentAgent / 抽屉 / 侧栏）自行刷新。
//
// 成功与否要记下来：清单为空有三种完全不同的原因（没这一层 / 没权限 / 没拉到），只有这里
// 知道是哪种。不记的话界面只能看到"空数组"，三种都显示成一样，而它们该让用户做的事完全不同
// （什么都不做 / 去申请权限 / 重试）。见 agents/lineup.ts。
void bootstrapCoworks()

// 阵容会**中途变**：用户在应用里登录之后套件才装得下来，每天那次对账也可能装新的/收回旧的。
// 主进程装完会喊一声，这里重拉。没有这条的话，界面停在开机那一刻的答案——新用户登录后
// 整个这一程都看到"你没有任何 Cowork 权限"，重启才好。
void (() => {
  type CoworkApi = { onCoworksChanged?: (cb: () => void) => () => void }
  const api = (window as unknown as { electronAPI?: CoworkApi }).electronAPI
  api?.onCoworksChanged?.(() => { void refreshCoworks() })
})()

void (async () => {
  type Api = {
    getAppConfig?: () => Promise<{ cloudBackendUrl?: string }>
    cloudConnect?: () => Promise<{ ok: boolean; connectUrl?: string; user?: string | null }>
  }
  const api = (window as unknown as { electronAPI?: Api }).electronAPI
  try {
    if (api?.getAppConfig) applyFactoryConfig(await api.getAppConfig())
  } catch {
    /* 取不到就当没配出厂地址 */
  }
  try {
    if (api?.cloudConnect) {
      const s = await api.cloudConnect()
      // 失败是**常态**（没登录、无准入、离线、对面在重启），不是错误 ——
      // 退回"没有云端"的形态即可，界面本来就会因此不出现云端字样。
      applyCloudSession(s?.ok ? s : null)
    }
  } catch {
    applyCloudSession(null)
  }
})()

// 阻止把文件/图片拖进窗口触发浏览器默认的「导航到/下载该文件」行为（拖入会弹下载或打开界面）。
// 全应用没有任何拖放投放区，dragover + drop 一律 preventDefault 吞掉即可；两个事件都要拦：
// 只拦 drop 不拦 dragover 时，窗口不算合法投放目标，浏览器仍会在 drop 时回退到默认导航。
// 若将来某处需要接收拖放，其元素级 onDrop 会先于此处的 window 冒泡监听执行，不受影响。
window.addEventListener('dragover', e => e.preventDefault())
window.addEventListener('drop', e => e.preventDefault())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
)

// Tell the Electron main process the renderer mounted (clears its white-screen
// watchdog). The IPC is idempotent on the main side, so firing it more than once
// is harmless. We fire via TWO paths because each alone has a failure mode:
//   - requestAnimationFrame fires after first paint (nice when visible) BUT is
//     SUSPENDED by Chromium when the window is occluded/minimized/background.
//     On first launch after install the backend wait is long and the NSIS finish
//     window often sits on top, so the window is frequently occluded at the
//     moment the UI loads → rAF never fires → renderer-ready never sent → the
//     20s watchdog falsely reports "界面已打开但未能正常显示".
//   - setTimeout is throttled in the background (clamped to ~1s) but, unlike rAF,
//     still FIRES while occluded — so it guarantees the signal regardless of
//     window visibility.
// Guard for the browser/dev case where the preload bridge isn't present.
const signalReady = () => {
  try {
    ;(window as unknown as { electronAPI?: { signalReady?: () => void } }).electronAPI?.signalReady?.()
  } catch {
    /* not running under Electron */
  }
}
requestAnimationFrame(signalReady) // fast path when visible
setTimeout(signalReady, 0) // visibility-independent fallback (occluded/background)
