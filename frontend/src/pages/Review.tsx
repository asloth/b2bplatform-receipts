import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ChevronRight,
  X,
  Loader2,
  ClipboardCheck,
  Inbox,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { listReviewTasks, getReviewTask, resolveReviewTask } from '@/api/client'
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

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const cls =
    pct >= 85
      ? 'bg-green-50 text-green-700 border-green-200'
      : pct >= 70
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-red-50 text-red-700 border-red-200'
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', cls)}>
      {pct}%
    </span>
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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ReviewTaskDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [corrections, setCorrections] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

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

  const openTask = async (taskId: string) => {
    setSelectedTaskId(taskId)
    setDetail(null)
    setCorrections({})
    setNotes('')
    setDetailLoading(true)
    try {
      const d = await getReviewTask(taskId)
      setDetail(d)
      const initial: Record<string, string> = {}
      for (const f of d.fields) {
        initial[f.field_name] = f.normalised_value ?? ''
      }
      setCorrections(initial)
    } catch {
      toast.error('Could not load task details')
      setSelectedTaskId(null)
    } finally {
      setDetailLoading(false)
    }
  }

  const handleSubmit = async () => {
    if (!selectedTaskId || !detail) return
    setSubmitting(true)

    const changed: Record<string, string> = {}
    for (const f of detail.fields) {
      const original = f.normalised_value ?? ''
      const current = corrections[f.field_name] ?? ''
      if (current !== original) changed[f.field_name] = current
    }

    try {
      await resolveReviewTask(selectedTaskId, changed, notes)
      toast.success('Task resolved — invoice validated')
      setSelectedTaskId(null)
      setDetail(null)
      setTasks((prev) => prev.filter((t) => t.task_id !== selectedTaskId))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  const lowFields = detail
    ? detail.fields.filter((f) => f.confidence < 0.85)
    : []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review Queue</h1>
          <p className="text-muted-foreground mt-1">
            Invoices where AI confidence is below 85% — review and correct extracted fields.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fetchTasks(true)}
          disabled={refreshing}
        >
          <RefreshCw className={cn('h-4 w-4 mr-2', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Stats bar */}
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
                    ? Math.round(
                        tasks.reduce((s, t) => s + t.doc_confidence, 0) / tasks.length * 100,
                      )
                    : '—'}
                  {tasks.length > 0 && <span className="text-base font-normal">%</span>}
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
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-3">
                <Inbox className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="font-medium">All clear</p>
              <p className="text-sm text-muted-foreground mt-1">
                No invoices pending review right now.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice ID</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Flagged Fields</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => {
                  const flagged = Object.keys(task.low_confidence_fields)
                  return (
                    <TableRow
                      key={task.task_id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => openTask(task.task_id)}
                    >
                      <TableCell className="font-mono text-sm">
                        {shortId(task.invoice_id)}
                      </TableCell>
                      <TableCell>
                        <ConfidenceBadge value={task.doc_confidence} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {flagged.slice(0, 3).map((f) => (
                            <Badge key={f} variant="secondary" className="text-xs">
                              {FIELD_LABELS[f] ?? f}
                            </Badge>
                          ))}
                          {flagged.length > 3 && (
                            <Badge variant="secondary" className="text-xs">
                              +{flagged.length - 3}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(task.created_at)}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" className="h-8">
                          Review
                          <ChevronRight className="ml-1 h-4 w-4" />
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

      {/* Review slide-over sheet */}
      <Sheet open={!!selectedTaskId} onOpenChange={(open) => !open && setSelectedTaskId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader className="mb-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <SheetTitle>Review Invoice</SheetTitle>
                {detail && (
                  <p className="text-sm text-muted-foreground mt-1 font-mono">
                    {detail.invoice_id}
                  </p>
                )}
              </div>
              {detail && (
                <ConfidenceBadge value={detail.doc_confidence} />
              )}
            </div>
          </SheetHeader>

          {detailLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : detail ? (
            <div className="space-y-6">
              {/* Low confidence callout */}
              {lowFields.length > 0 && (
                <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="text-sm text-amber-700">
                    <p className="font-medium">
                      {lowFields.length} field{lowFields.length > 1 ? 's' : ''} need attention
                    </p>
                    <p className="text-xs mt-0.5 opacity-80">
                      Review and correct the highlighted fields below before submitting.
                    </p>
                  </div>
                </div>
              )}

              {/* Fields */}
              <div className="space-y-3">
                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  Extracted Fields
                </p>
                {detail.fields.map((field) => {
                  const isLow = field.confidence < 0.85
                  return (
                    <div
                      key={field.field_name}
                      className={cn(
                        'rounded-lg border p-3 space-y-2 transition-colors',
                        isLow ? 'border-amber-200 bg-amber-50/50' : 'border-border bg-background',
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium flex items-center gap-2">
                          {isLow && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
                          {FIELD_LABELS[field.field_name] ?? field.field_name}
                        </label>
                        <ConfidenceBadge value={field.confidence} />
                      </div>
                      <Input
                        value={corrections[field.field_name] ?? ''}
                        onChange={(e) =>
                          setCorrections((prev) => ({
                            ...prev,
                            [field.field_name]: e.target.value,
                          }))
                        }
                        placeholder="No value extracted"
                        className={cn(
                          'text-sm h-8',
                          isLow && 'border-amber-200 focus-visible:ring-amber-400',
                        )}
                      />
                      {field.raw_value && field.raw_value !== corrections[field.field_name] && (
                        <p className="text-xs text-muted-foreground">
                          Original: <span className="font-mono">{field.raw_value}</span>
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>

              <Separator />

              {/* Resolution notes */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Resolution Notes</label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional notes about corrections made..."
                  className="resize-none text-sm"
                  rows={3}
                />
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <Button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="flex-1"
                >
                  {submitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  Submit & Validate
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setSelectedTaskId(null)}
                  disabled={submitting}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}
