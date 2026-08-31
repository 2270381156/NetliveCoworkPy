import { useState } from 'react'
import { PlusIcon, Trash2Icon, Wand2Icon, ChevronLeftIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { useFirstVisitTour, llmTourSteps } from '@/hooks/useOnboarding'
import { useLlmProviders, useDeleteProvider } from './api/hooks'
import { ProviderCard } from './components/ProviderCard'
import { AddProviderForm } from './components/AddProviderForm'

export function LLMSettingsPage({ onClose }: { onClose?: () => void }) {
  const { t, lang } = useI18n()
  const [view, setView] = useState<'list' | 'add'>('list')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // 首次进入大模型配置页跑一次引导（仅 list 视图）
  useFirstVisitTour('llm', llmTourSteps(lang), { enabled: view === 'list' })

  const { data: providers = [] } = useLlmProviders()
  const deleteMut = useDeleteProvider()

  return (
    <div className="flex h-full flex-col bg-bg0">
      {/* Header */}
      <div className="bg-bg1 border-b border-border">
        <div className="px-6 pt-5 pb-4">
          {view === 'list' ? (
            <div className="flex items-center gap-2">
              {onClose && <CloseButton onClick={onClose} title={t('common.close')} />}
              <Wand2Icon size={16} className="text-blue" />
              <h1 className="text-base font-semibold text-t1">{t('llm.title')}</h1>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setView('list')}
                className="flex items-center gap-1 text-xs transition-colors cursor-pointer text-t3 hover:text-t1"
              >
                <ChevronLeftIcon size={14} />{t('common.back')}
              </button>
              <span className="text-border2 text-xs">|</span>
              <h1 className="text-base font-semibold text-t1">{t('llm.addProvider')}</h1>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div data-tour="llm-list" className="flex-1 overflow-y-auto p-5">
        {view === 'add' ? (
          <AddProviderForm onDone={() => setView('list')} />
        ) : (
          <>
            <div data-tour="llm-add" className="flex justify-end mb-4">
              <Button size="sm" className="w-[150px]" onClick={() => setView('add')}>
                <PlusIcon size={13} />{t('llm.addProvider')}
              </Button>
            </div>
            {providers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <Wand2Icon size={32} className="text-t3 opacity-40" />
                <p className="text-sm font-medium text-t2">{t('llm.emptyTitle')}</p>
                <p className="text-xs text-t3">{t('llm.emptyDesc')}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {providers.map(p => (
                  <ProviderCard key={p.name} provider={p} onDelete={() => setConfirmDelete(p.name)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,31,61,0.4)] backdrop-blur-[4px]">
          <div className="w-80 p-5 bg-bg1 border border-border rounded-2xl shadow-[0_24px_80px_rgba(15,31,61,0.2)]">
            <div className="flex items-center gap-2 mb-1">
              <Trash2Icon size={14} className="text-red" />
              <p className="text-sm font-semibold text-t1">{t('llm.deleteTitle')}</p>
            </div>
            <p className="mt-2 mb-5 text-xs leading-relaxed text-t2">
              {t('llm.deleteConfirmPre')}<span className="font-mono font-semibold text-t1">{confirmDelete}</span>{t('llm.deleteConfirmPost')}<br />
              {t('llm.deleteConfirmNote')}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</Button>
              <Button variant="danger" size="sm" loading={deleteMut.isPending} onClick={() => deleteMut.mutate(confirmDelete, { onSuccess: () => setConfirmDelete(null) })}>{t('common.delete')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CloseButton({ onClick, title }: { onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-7 h-7 flex items-center justify-center rounded-md transition-colors cursor-pointer text-t3 hover:bg-bg3 hover:text-t1"
    >
      <ChevronLeftIcon size={18} />
    </button>
  )
}
