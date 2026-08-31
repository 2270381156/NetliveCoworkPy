// Electron <webview> 标签的 JSX 类型声明（应用内浏览器用）。
// 只声明我们实际用到的属性；imperative 方法（goBack/loadURL 等）在组件里按需 cast。
import type React from 'react'

interface WebviewHTMLAttributes extends React.HTMLAttributes<HTMLElement> {
  src?: string
  partition?: string
  allowpopups?: string
  useragent?: string
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<WebviewHTMLAttributes, HTMLElement>
    }
  }
}
