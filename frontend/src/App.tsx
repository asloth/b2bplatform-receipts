import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { UploadCloud, ClipboardList, FileStack, Sparkles } from 'lucide-react'
import Upload from '@/pages/Upload'
import Review from '@/pages/Review'
import Chat from '@/pages/Chat'
import { cn } from '@/lib/utils'

function Nav() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors',
      isActive
        ? 'bg-primary text-primary-foreground'
        : 'text-muted-foreground hover:text-foreground hover:bg-muted',
    )

  return (
    <header className="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
            <FileStack className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="font-semibold text-sm tracking-tight">B2B Invoice Platform</span>
        </div>
        <nav className="flex items-center gap-1">
          <NavLink to="/upload" className={linkClass}>
            <UploadCloud className="h-4 w-4" />
            Upload
          </NavLink>
          <NavLink to="/review" className={linkClass}>
            <ClipboardList className="h-4 w-4" />
            Review Queue
          </NavLink>
          <NavLink to="/chat" className={linkClass}>
            <Sparkles className="h-4 w-4" />
            Assistant
          </NavLink>
        </nav>
      </div>
    </header>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="max-w-5xl mx-auto px-6 py-8">
          <Routes>
            <Route path="/" element={<Navigate to="/upload" replace />} />
            <Route path="/upload" element={<Upload />} />
            <Route path="/review" element={<Review />} />
            <Route path="/chat" element={<Chat />} />
          </Routes>
        </main>
      </div>
      <Toaster richColors position="bottom-right" />
    </BrowserRouter>
  )
}
