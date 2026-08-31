import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Layout } from '@/components/layout/Layout'
import { SessionsPage } from '@/pages/SessionsPage'
import { LLMsPage } from '@/pages/LLMsPage'
import { TemplatesPage } from '@/pages/TemplatesPage'
import { MCPPage } from '@/pages/MCPPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000,
      retry: 1,
    },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Navigate to="/sessions" replace />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/llms" element={<LLMsPage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/mcp" element={<MCPPage />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
