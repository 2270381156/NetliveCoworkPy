export interface SearchCapability {
  run(query: string): void
  next(): void
  prev(): void
  clear(): void
  count?: number
  current?: number
}
export interface ZoomCapability {
  in(): void
  out(): void
  reset(): void
  fit(): void
  scale: number
}
export interface PagesCapability { count: number; current: number; goto(n: number): void }
export interface TocItem { id: string; label: string; level?: number }
export interface TocCapability { items: TocItem[]; goto(id: string): void }
export interface DownloadCapability { url: string; filename: string }

export interface ViewerCapabilities {
  search?: SearchCapability
  zoom?: ZoomCapability
  pages?: PagesCapability
  toc?: TocCapability
  download?: DownloadCapability
  copy?: () => string
}
