import { useState, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { Send, Bot, User, ChevronDown, ChevronUp, Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { sendChatMessage, type ChatMessage, type ChatResponse } from '@/api/client'
import { cn } from '@/lib/utils'

const SUGGESTIONS = [
  'How many invoices were uploaded this month?',
  'What is the total amount across all extracted invoices?',
  'Which invoices are still pending review?',
  'Show me invoices from the last 7 days',
  'What is the average confidence score?',
  'How many invoices were rejected?',
]

interface Message {
  role: 'user' | 'assistant'
  content: string
  sql?: string | null
  rows?: Record<string, unknown>[] | null
  loading?: boolean
}

function SqlBlock({ sql }: { sql: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2 rounded-md border border-border/60 text-xs overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 bg-muted/60 text-muted-foreground hover:bg-muted transition-colors"
      >
        <span className="font-mono">View SQL query</span>
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {open && (
        <pre className="p-3 bg-muted/30 overflow-x-auto font-mono leading-relaxed text-foreground whitespace-pre-wrap">
          {sql.trim()}
        </pre>
      )}
    </div>
  )
}

function ResultTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) return null
  const columns = Object.keys(rows[0])
  return (
    <div className="mt-2 rounded-md border border-border/60 overflow-hidden text-xs">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-muted/60">
              {columns.map((col) => (
                <th key={col} className="px-3 py-1.5 text-left font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={cn('border-t border-border/40', i % 2 === 0 ? 'bg-background' : 'bg-muted/20')}>
                {columns.map((col) => (
                  <td key={col} className="px-3 py-1.5 font-mono text-foreground whitespace-nowrap">
                    {String(row[col] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 bg-muted/30 border-t border-border/40 text-muted-foreground">
        {rows.length} row{rows.length !== 1 ? 's' : ''}
      </div>
    </div>
  )
}

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user'

  return (
    <div className={cn('flex gap-3 items-start', isUser && 'flex-row-reverse')}>
      {/* Avatar */}
      <div className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
        isUser ? 'bg-primary text-primary-foreground' : 'bg-muted border border-border',
      )}>
        {isUser
          ? <User className="h-4 w-4" />
          : <Bot className="h-4 w-4 text-muted-foreground" />
        }
      </div>

      {/* Bubble */}
      <div className={cn('max-w-[75%] space-y-1', isUser && 'items-end flex flex-col')}>
        <div className={cn(
          'rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'bg-primary text-primary-foreground rounded-tr-sm'
            : 'bg-muted text-foreground rounded-tl-sm',
        )}>
          {msg.loading
            ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Thinking…
              </span>
            )
            : msg.content
          }
        </div>

        {/* SQL + table below the bubble */}
        {!isUser && !msg.loading && (
          <div className="w-full">
            {msg.sql && <SqlBlock sql={msg.sql} />}
            {msg.rows && msg.rows.length > 0 && <ResultTable rows={msg.rows} />}
          </div>
        )}
      </div>
    </div>
  )
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const historyForApi = (): ChatMessage[] =>
    messages
      .filter((m) => !m.loading)
      .map((m) => ({ role: m.role, content: m.content }))

  const send = async (question: string) => {
    const q = question.trim()
    if (!q || loading) return

    setInput('')
    setLoading(true)

    const userMsg: Message = { role: 'user', content: q }
    const loadingMsg: Message = { role: 'assistant', content: '', loading: true }

    setMessages((prev) => [...prev, userMsg, loadingMsg])

    try {
      const res: ChatResponse = await sendChatMessage(q, historyForApi())
      setMessages((prev) => [
        ...prev.slice(0, -1), // remove loading bubble
        {
          role: 'assistant',
          content: res.answer,
          sql: res.sql,
          rows: res.rows,
        },
      ])
    } catch (err) {
      setMessages((prev) => prev.slice(0, -1))
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
      textareaRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send(input)
    }
  }

  const isEmpty = messages.length === 0

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem-4rem)] max-w-3xl mx-auto">

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Invoice Assistant</h1>
        <p className="text-muted-foreground mt-1">
          Ask anything about your invoices — amounts, suppliers, statuses, trends.
        </p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-5 pb-4 pr-1">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-6 text-center pb-12">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <Sparkles className="h-7 w-7 text-primary" />
            </div>
            <div>
              <p className="font-medium text-lg">Ask me about your invoices</p>
              <p className="text-sm text-muted-foreground mt-1">
                I can query totals, suppliers, statuses, dates, and more.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center max-w-lg">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-xs px-3 py-1.5 rounded-full border border-border bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t pt-4">
        {!isEmpty && (
          <div className="flex flex-wrap gap-2 mb-3">
            {SUGGESTIONS.slice(0, 3).map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                disabled={loading}
                className="text-xs px-2.5 py-1 rounded-full border border-border bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your invoices… (Enter to send, Shift+Enter for new line)"
            className="resize-none text-sm min-h-[44px] max-h-[120px]"
            rows={1}
            disabled={loading}
          />
          <Button
            onClick={() => send(input)}
            disabled={!input.trim() || loading}
            size="icon"
            className="shrink-0 h-11 w-11"
          >
            {loading
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Send className="h-4 w-4" />
            }
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2 text-center">
          Reads invoice data only · cannot modify records
        </p>
      </div>
    </div>
  )
}
