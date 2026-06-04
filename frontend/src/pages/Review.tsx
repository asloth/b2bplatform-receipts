import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ChevronRight,
  Loader2,
  ClipboardCheck,
  Inbox,
  FileText,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { listReviewTasks, getReviewTask, resolveReviewTask, getInvoicePreview } from '@/api/client'
import type { ReviewTask, ReviewTaskDetail } from '@/types'
import { cn } from '@/lib/utils'

const FIELD_LABELS: Record<string, string> = {
  supplier_name: 'Supplier Name',
  invoice_number: 'Invoice Number',
  invoice_date: 'Invoice Date',
  total_amount: 'Total Amount',
  tax_amount: 'Tax Amount',
  subtotal: 'Subtotal',
  currency: 'Currency',
}

const FIELD_PLACEHOLDERS: Record<string, string> = {
  supplier_name: 'e.g. Acme Corp',
  invoice_number: 'e.g. INV-2024-001',
  invoice_date: 'e.g. 2024-01-15',
  total_amount: 'e.g. 1200.00',
  tax_amount: 'e.g. 120.00',
  subtotal: 'e.g. 1080.00',
  currency: 'e.g. USD',
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const color =
    pct >= 85 ? 'bg-green-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500'
  const label =
    pct >= 85 ? 'text-green-700' : pct >= 50 ? 'text-amber-700' : 'text-red-600'

  return (
    <div className="flex items-center gap-2 min-w-[110px]">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn('text-xs font-semibold tabular-nums w-8 text-right', label)}>
        {pct}%
      </span>
    </div>
  )
}

function shortId(id: string) {
  return id.slice(0, 8) + '…'
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function Review() {
  const [tasks, setTasks] = useState<ReviewTask[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<ReviewTaskDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [corrections, setCorrections] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pdfZoom, setPdfZoom] = useState(100)

  const fetchTasks = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)
    try {
      const data = await listReviewTasks()
      setTasks(data.tasks)
    } catch {
      toast.error('Could not load review queue')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchTasks()
    const interval = setInterval(() => fetchTasks(true), 30_000)
    return () => clearInterval(interval)
  }, [fetchTasks])

  const openTask = async (task: ReviewTask) => {
    setOpen(true)
    setDetail(null)
    setPreviewUrl(null)
    setCorrections({})
    setNotes('')
    setPdfZoom(100)
    setDetailLoading(true)
    setPreviewLoading(true)

    // fetch detail + preview in parallel
    const [detailRes, previewRes] = await Promise.allSettled([
      getReviewTask(task.task_id),
      getInvoicePreview(task.invoice_id),
    ])

    if (detailRes.status === 'fulfilled') {
      setDetail(detailRes.value)
      const initial: Record<string, string> = {}
      for (const f of detailRes.value.fields) {
        initial[f.field_name] = f.normalised_value ?? ''
      }
      setCorrections(initial)
    } else {
      toast.error('Could not load task details')
      setOpen(false)
    }
    setDetailLoading(false)

    if (previewRes.status === 'fulfilled') {
      setPreviewUrl(previewRes.value.url)
    }
    setPreviewLoading(false)
  }

  const handleSubmit = async () => {
    if (!detail) return
    setSubmitting(true)

    const changed: Record<string, string> = {}
    for (const f of detail.fields) {
      const original = f.normalised_value ?? ''
      const current = corrections[f.field_name] ?? ''
      if (current !== original) changed[f.field_name] = current
    }

    try {
      await resolveReviewTask(detail.task_id, changed, notes)
      toast.success('Invoice validated successfully')
      setOpen(false)
      setTasks((prev) => prev.filter((t) => t.task_id !== detail.task_id))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  const flaggedFields = detail?.fields.filter((f) => f.confidence < 0.85) ?? []
  const goodFields = detail?.fields.filter((f) => f.confidence >= 0.85) ?? []

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review Queue</h1>
          <p className="text-muted-foreground mt-1">
            Invoices where AI confidence is below 85% — view the document and correct flagged fields.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchTasks(true)} disabled={refreshing}>
          <RefreshCw className={cn('h-4 w-4 mr-2', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      {!loading && (
        <div className="flex gap-4">
          <Card className="flex-1">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{tasks.length}</p>
                <p className="text-xs text-muted-foreground">Pending Review</p>
              </div>
            </CardContent>
          </Card>
          <Card className="flex-1">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-100">
                <ClipboardCheck className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {tasks.length > 0
                    ? `${Math.round(tasks.reduce((s, t) => s + t.doc_confidence, 0) / tasks.length * 100)}%`
                    : '—'}
                </p>
                <p className="text-xs text-muted-foreground">Avg Confidence</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Open Tasks</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-3">
                <Inbox className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="font-medium">All clear</p>
              <p className="text-sm text-muted-foreground mt-1">No invoices pending review right now.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice ID</TableHead>
                  <TableHead>Doc Confidence</TableHead>
                  <TableHead>Flagged Fields</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => {
                  const flagged = Object.keys(task.low_confidence_fields)
                  const docPct = Math.round(task.doc_confidence * 100)
                  return (
                    <TableRow
                      key={task.task_id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => openTask(task)}
                    >
                      <TableCell className="font-mono text-sm">{shortId(task.invoice_id)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <ConfidenceBar value={task.doc_confidence} />
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {flagged.slice(0, 3).map((f) => (
                            <Badge key={f} variant="secondary" className="text-xs">
                              {FIELD_LABELS[f] ?? f}
                            </Badge>
                          ))}
                          {flagged.length > 3 && (
                            <Badge variant="secondary" className="text-xs">+{flagged.length - 3}</Badge>
                          )}
                          {flagged.length === 0 && (
                            <span className="text-xs text-muted-foreground">None</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(task.created_at)}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" className="h-8">
                          Review <ChevronRight className="ml-1 h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Full-screen review dialog */}
      <DialogPrimitive.Root open={open} onOpenChange={(v) => !submitting && setOpen(v)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <DialogPrimitive.Popup className="fixed inset-4 z-50 flex flex-col rounded-xl bg-background shadow-2xl ring-1 ring-border overflow-hidden outline-none">
          {/* Dialog header */}
          <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <div>
                <h2 className="font-semibold text-base">Review Invoice</h2>
                {detail && (
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">{detail.invoice_id}</p>
                )}
              </div>
              {detail && (
                <div className="ml-2">
                  <ConfidenceBar value={detail.doc_confidence} />
                </div>
              )}
            </div>
            <Button variant="ghost" size="icon" onClick={() => setOpen(false)} disabled={submitting}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Split layout */}
          <div className="flex flex-1 overflow-hidden min-h-0">

            {/* Left — PDF preview */}
            <div className="flex-1 bg-muted/30 border-r flex flex-col min-w-0">
              <div className="flex items-center justify-between px-4 py-2 border-b bg-background/80 shrink-0">
                <span className="text-sm font-medium text-muted-foreground">Original Document</span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPdfZoom(z => Math.max(50, z - 25))}>
                    <ZoomOut className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-xs text-muted-foreground w-10 text-center">{pdfZoom}%</span>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPdfZoom(z => Math.min(200, z + 25))}>
                    <ZoomIn className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div className="flex-1 overflow-auto p-4 flex items-start justify-center">
                {previewLoading ? (
                  <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                    <Loader2 className="h-8 w-8 animate-spin" />
                    <p className="text-sm">Loading document…</p>
                  </div>
                ) : previewUrl ? (
                  <div style={{ width: `${pdfZoom}%`, minWidth: '300px' }} className="h-full">
                    <object
                      data={previewUrl}
                      type="application/pdf"
                      className="w-full h-full rounded border shadow-sm"
                      style={{ minHeight: '600px' }}
                    >
                      <div className="flex flex-col items-center justify-center h-64 bg-muted rounded border gap-3">
                        <FileText className="h-10 w-10 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">PDF preview not supported in this browser</p>
                        <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm">Open PDF</Button>
                        </a>
                      </div>
                    </object>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                    <FileText className="h-10 w-10" />
                    <p className="text-sm">Could not load preview</p>
                  </div>
                )}
              </div>
            </div>

            {/* Right — fields */}
            <div className="w-[38%] min-w-[300px] max-w-[460px] shrink-0 flex flex-col overflow-hidden border-l">
              {detailLoading ? (
                <div className="p-6 space-y-4">
                  {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
                </div>
              ) : detail ? (
                <div className="flex-1 overflow-y-auto p-5 space-y-5">

                  {/* Flagged fields */}
                  {flaggedFields.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                        <p className="text-sm font-semibold text-amber-700">
                          {flaggedFields.length} field{flaggedFields.length > 1 ? 's' : ''} need attention
                        </p>
                      </div>

                      {flaggedFields.map((field) => {
                        const pct = Math.round(field.confidence * 100)
                        const hasValue = !!(corrections[field.field_name] ?? field.normalised_value ?? field.raw_value)
                        return (
                          <div key={field.field_name} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <label className="text-xs font-semibold text-amber-800 uppercase tracking-wide">
                                {FIELD_LABELS[field.field_name] ?? field.field_name}
                              </label>
                              <ConfidenceBar value={field.confidence} />
                            </div>
                            {pct === 0 && !hasValue && (
                              <p className="text-xs text-red-600 font-medium">
                                Not detected — enter the value from the document
                              </p>
                            )}
                            {pct === 0 && hasValue && (
                              <p className="text-xs text-amber-700">
                                Low confidence — verify this value against the document
                              </p>
                            )}
                            {pct > 0 && pct < 85 && (
                              <p className="text-xs text-amber-700">
                                Partial confidence — check this looks correct
                              </p>
                            )}
                            <Input
                              value={corrections[field.field_name] ?? ''}
                              onChange={(e) =>
                                setCorrections((prev) => ({ ...prev, [field.field_name]: e.target.value }))
                              }
                              placeholder={FIELD_PLACEHOLDERS[field.field_name] ?? 'Enter value'}
                              className="h-8 text-sm border-amber-300 focus-visible:ring-amber-400 bg-white"
                            />
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {flaggedFields.length > 0 && goodFields.length > 0 && <Separator />}

                  {/* Good fields */}
                  {goodFields.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                        <p className="text-sm font-semibold text-green-700">
                          Auto-extracted with high confidence
                        </p>
                      </div>

                      {goodFields.map((field) => (
                        <div key={field.field_name} className="rounded-lg border p-3 space-y-2 bg-background">
                          <div className="flex items-center justify-between">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                              {FIELD_LABELS[field.field_name] ?? field.field_name}
                            </label>
                            <ConfidenceBar value={field.confidence} />
                          </div>
                          <Input
                            value={corrections[field.field_name] ?? ''}
                            onChange={(e) =>
                              setCorrections((prev) => ({ ...prev, [field.field_name]: e.target.value }))
                            }
                            placeholder={FIELD_PLACEHOLDERS[field.field_name] ?? 'Enter value'}
                            className="h-8 text-sm"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  <Separator />

                  {/* Resolution notes */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Resolution Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
                    <Textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Describe any corrections made…"
                      className="resize-none text-sm"
                      rows={3}
                    />
                  </div>
                </div>
              ) : null}

              {/* Footer actions */}
              <div className="border-t p-4 shrink-0 bg-background flex gap-2">
                <Button onClick={handleSubmit} disabled={submitting || detailLoading} className="flex-1">
                  {submitting
                    ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</>
                    : <><CheckCircle2 className="mr-2 h-4 w-4" />Submit & Validate</>
                  }
                </Button>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  )
}
