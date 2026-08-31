import type { TocItem } from '../../toolbar/capabilities'

// A pdfjs outline destination: a named string or an explicit destination array.
export type OutlineDest = string | unknown[]

interface RawOutlineNode {
  title: string
  dest: OutlineDest | null
  items?: RawOutlineNode[]
}

export interface FlatOutline {
  items: TocItem[]
  dests: Map<string, OutlineDest>
}

// Flatten pdfjs's nested getOutline() result into a flat TocItem[] (with level for
// indentation) plus a map from each item id to its destination (resolved later via
// PDFLinkService.goToDestination). Pure — no pdfjs calls.
export function flattenOutline(outline: RawOutlineNode[] | null): FlatOutline {
  const items: TocItem[] = []
  const dests = new Map<string, OutlineDest>()
  let seq = 0

  function walk(nodes: RawOutlineNode[], level: number): void {
    for (const node of nodes) {
      const id = `o${seq++}`
      items.push({ id, label: node.title?.trim() || '(untitled)', level })
      if (node.dest != null) dests.set(id, node.dest)
      if (node.items && node.items.length) walk(node.items, level + 1)
    }
  }

  if (outline && outline.length) walk(outline, 0)
  return { items, dests }
}
