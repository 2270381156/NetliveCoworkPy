import { useEffect } from 'react'
import { driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import { useI18n, type Lang } from '@/i18n'

// 新手引导：每个页面一组步骤、各自一个 localStorage 标志，每机只引导一次。
// 目标元素用 data-tour="..." 选择器定位（见各组件）。

const PREFIX = 'onboarding.'
const VERSION = 'v1'
const key = (tour: string) => `${PREFIX}${tour}.${VERSION}`

export type TourKey = 'main' | 'workspace' | 'llm' | 'skills'
export const ALL_TOURS: TourKey[] = ['main', 'workspace', 'llm', 'skills']

// 同一时刻只允许一个引导在跑，避免两段引导（如 main 与 workspace）同时弹出叠加。
let _active = false

export function tourSeen(tour: TourKey): boolean {
  return localStorage.getItem(key(tour)) === '1'
}
export function markTourSeen(tour: TourKey): void {
  try { localStorage.setItem(key(tour), '1') } catch { /* 配额满等 → 忽略 */ }
}

/**
 * 首次进入某页时跑一次引导。
 * - 只保留当前 DOM 里真实存在的目标，缺失的（如空列表/未显示的工作区）自动跳过。
 * - 走完或中途关闭都算"已看过"。
 */
export function useFirstVisitTour(
  tour: TourKey,
  steps: DriveStep[],
  opts: { enabled?: boolean; delayMs?: number } = {},
): void {
  const { lang } = useI18n()
  const enabled = opts.enabled ?? true
  useEffect(() => {
    if (!enabled || tourSeen(tour)) return
    const timer = setTimeout(() => {
      if (tourSeen(tour)) return
      if (_active) return   // 已有引导在跑 → 本次先不弹（enabled 再次变化时重试）
      const present = steps.filter(
        (s) => !s.element || document.querySelector(s.element as string),
      )
      if (present.length === 0) return   // 目标尚未出现 → 不标记，等下次满足再引导
      _active = true
      const en = lang === 'en'
      const d = driver({
        showProgress: true,
        allowClose: true,
        overlayColor: 'rgba(15,31,61,0.55)',
        nextBtnText: en ? 'Next' : '下一步',
        prevBtnText: en ? 'Back' : '上一步',
        doneBtnText: en ? 'Done' : '完成',
        progressText: '{{current}} / {{total}}',
        steps: present,
        onDestroyed: () => { _active = false; markTourSeen(tour) },
      })
      d.drive()
    }, opts.delayMs ?? 400)
    return () => clearTimeout(timer)
    // 仅在挂载 / enabled 变化时评估；steps 与 lang 在 effect 运行时读取即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour, enabled])
}

// ── 各页步骤定义（按 lang 取中/英文案）────────────────────────────────────────

const tr = (lang: Lang, zh: string, en: string) => (lang === 'en' ? en : zh)

// 进入主界面即引导：侧栏部分（此时还没有会话，聊天区/工作区尚未出现）
export function mainTourSteps(lang: Lang): DriveStep[] {
  return [
    { element: '[data-tour="new-session"]', popover: {
      title: tr(lang, '新建会话', 'New Session'),
      description: tr(lang, '点这里新建会话、选择工作目录，开始一个任务。', 'Create a session and choose a working directory to start a task.') } },
    { element: '[data-tour="session-list"]', popover: {
      title: tr(lang, '会话列表', 'Sessions'),
      description: tr(lang, '你的历史会话都在这里，点击即可切换。', 'All your sessions are here — click to switch.') } },
    { element: '[data-tour="user-menu"]', popover: {
      title: tr(lang, '设置', 'Settings'),
      description: tr(lang, '大模型配置、Skill 管理都在设置里。', 'Model config and Skill management are all in Settings.') } },
  ]
}

// 选定工作目录、有了会话/草稿后再引导：对话区 + 工作区（此时才会出现）
export function workspaceTourSteps(lang: Lang): DriveStep[] {
  return [
    { element: '[data-tour="chat-area"]', popover: {
      title: tr(lang, '对话区', 'Chat'),
      description: tr(lang, '在这里输入需求，和 AI 一步步协作完成任务。', 'Type your request here and work with the AI step by step.') } },
    { element: '[data-tour="workspace"]', popover: {
      title: tr(lang, '工作区', 'Workspace'),
      description: tr(lang, 'AI 产出的文件会出现在这里，可直接预览。', 'Files the AI produces appear here — preview them directly.') } },
  ]
}

export function llmTourSteps(lang: Lang): DriveStep[] {
  return [
    { element: '[data-tour="llm-add"]', popover: {
      title: tr(lang, '添加大模型', 'Add Model'),
      description: tr(lang, '点这里添加一个大模型账号。', 'Add a model account here.') } },
    { element: '[data-tour="llm-list"]', popover: {
      title: tr(lang, '大模型列表', 'Models'),
      description: tr(lang, '已配置的模型在这里，可以管理你自己配置的模型。', 'Your configured models are here — manage the ones you added.') } },
  ]
}

export function skillsTourSteps(lang: Lang): DriveStep[] {
  return [
    { element: '[data-tour="skills-tabs"]', popover: {
      title: tr(lang, '本地 Skill / Skill 市场', 'Local / Marketplace'),
      description: tr(lang, '可以在 Skill 市场下载安装更多 Skill 到本地。', 'Download and install more Skills from the marketplace.') } },
    { element: '[data-tour="skills-import"]', popover: {
      title: tr(lang, '导入 Skill', 'Import Skill'),
      description: tr(lang, '可以从这里导入自己的 Skill（zip 文件）。', 'Import your own Skill (a zip file) here.') } },
  ]
}
