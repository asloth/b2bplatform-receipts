import { useState, useCallback, useRef } from 'react'
import { useDropzone } from 'react-dropzone'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  ArrowRight,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { uploadInvoice, getJobStatus } from '@/api/client'
import type { InvoiceStatus } from '@/types'
import { cn } from '@/lib/utils'

type UploadState = 'idle' | 'uploading' | 'polling' | 'done'

interface JobResult {
  job_id: string
  status: InvoiceStatus
  confidence: number | null
}

const STATUS_CONFIG: Record<
  InvoiceStatus,
  { label: string; color: string; icon: React.ReactNode; description: string }
> = {
  PROCESSING: {
    label: 'Processing',
    color: 'bg-blue-50 text-blue-700 border-blue-200',
    icon: <Loader2 className="h-4 w-4 animate-spin" />,
    description: 'AI is classifying and extracting invoice data...',
  },
  EXTRACTED: {
    label: 'Extracted',
    color: 'bg-green-50 text-green-700 border-green-200',
    icon: <CheckCircle2 className="h-4 w-4" />,
    description: 'All fields extracted with high confidence.',
  },
  PENDING_REVIEW: {
    label: 'Needs Review',
    color: 'bg-amber-50 text-amber-700 border-amber-200',
    icon: <AlertTriangle className="h-4 w-4" />,
    description: 'Some fields have low confidence and need human review.',
  },
  REJECTED: {
    label: 'Rejected',
    color: 'bg-red-50 text-red-700 border-red-200',
    icon: <XCircle className="h-4 w-4" />,
    description: 'This document does not appear to be a valid invoice.',
  },
  FAILED: {
    label: 'Failed',
    color: 'bg-red-50 text-red-700 border-red-200',
    icon: <XCircle className="h-4 w-4" />,
    description: 'Processing failed. Please try uploading again.',
  },
}

const STEPS = [
  { key: 'uploaded', label: 'Uploaded to S3' },
  { key: 'classifying', label: 'Classifying document' },
  { key: 'extracting', label: 'Running OCR + AI extraction' },
  { key: 'scoring', label: 'Scoring confidence' },
]

function getCompletedSteps(status: InvoiceStatus): number {
  if (status === 'PROCESSING') return 1
  if (status === 'EXTRACTED' || status === 'PENDING_REVIEW') return 4
  if (status === 'REJECTED') return 2
  if (status === 'FAILED') return 2
  return 0
}

export default function Upload() {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [result, setResult] = useState<JobResult | null>(null)
  const [pollProgress, setPollProgress] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const startPolling = useCallback((jobId: string) => {
    setUploadState('polling')
    let elapsed = 0
    const maxMs = 120_000
    const intervalMs = 3_000

    pollRef.current = setInterval(async () => {
      elapsed += intervalMs
      setPollProgress(Math.min((elapsed / maxMs) * 100, 95))

      try {
        const job = await getJobStatus(jobId)
        if (job.status !== 'PROCESSING') {
          stopPolling()
          setPollProgress(100)
          setResult({ job_id: jobId, status: job.status, confidence: job.confidence })
          setUploadState('done')
          if (job.status === 'EXTRACTED') toast.success('Invoice extracted successfully')
          if (job.status === 'PENDING_REVIEW') toast.warning('Invoice needs human review')
          if (job.status === 'REJECTED') toast.error('Document rejected — not a valid invoice')
          if (job.status === 'FAILED') toast.error('Processing failed')
        }
      } catch {
        // network hiccup — keep polling
      }

      if (elapsed >= maxMs) {
        stopPolling()
        toast.error('Processing timed out — check back later')
        setUploadState('done')
        setResult({ job_id: jobId, status: 'PROCESSING', confidence: null })
      }
    }, intervalMs)
  }, [])

  const handleUpload = async () => {
    if (!file) return
    setUploadState('uploading')
    try {
      const { job_id } = await uploadInvoice(file)
      startPolling(job_id)
    } catch (err) {
      setUploadState('idle')
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted[0]) {
        setFile(accepted[0])
        setResult(null)
        setUploadState('idle')
        stopPolling()
      }
    },
    [],
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
    disabled: uploadState === 'uploading' || uploadState === 'polling',
  })

  const reset = () => {
    stopPolling()
    setFile(null)
    setResult(null)
    setUploadState('idle')
    setPollProgress(0)
  }

  const isProcessing = uploadState === 'uploading' || uploadState === 'polling'
  const statusConfig = result ? STATUS_CONFIG[result.status] : null

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Upload Invoice</h1>
        <p className="text-muted-foreground mt-1">
          Drop a PDF invoice — we'll classify, OCR, and extract fields automatically.
        </p>
      </div>

      {/* Drop zone */}
      <div
        {...getRootProps()}
        className={cn(
          'relative rounded-xl border-2 border-dashed transition-all cursor-pointer',
          'flex flex-col items-center justify-center gap-3 p-12 text-center',
          isDragActive
            ? 'border-primary bg-primary/5 scale-[1.01]'
            : 'border-border hover:border-primary/50 hover:bg-muted/30',
          isProcessing && 'pointer-events-none opacity-60',
          file && !isProcessing && 'border-primary/40 bg-primary/3',
        )}
      >
        <input {...getInputProps()} />

        {file ? (
          <>
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <FileText className="h-7 w-7 text-primary" />
            </div>
            <div>
              <p className="font-medium text-foreground">{file.name}</p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {(file.size / 1024 / 1024).toFixed(2)} MB · PDF
              </p>
            </div>
            {!isProcessing && (
              <button
                onClick={(e) => { e.stopPropagation(); reset() }}
                className="absolute top-3 right-3 rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </>
        ) : (
          <>
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
              <UploadCloud className="h-7 w-7 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">
                {isDragActive ? 'Drop it here' : 'Drag & drop your PDF'}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">
                or <span className="text-primary underline underline-offset-2">browse files</span> · max 50 MB
              </p>
            </div>
          </>
        )}
      </div>

      {/* Upload button */}
      {file && uploadState === 'idle' && (
        <Button onClick={handleUpload} className="w-full" size="lg">
          <UploadCloud className="mr-2 h-4 w-4" />
          Upload & Process
        </Button>
      )}

      {/* Processing card */}
      {(uploadState === 'uploading' || uploadState === 'polling') && (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span className="font-medium text-sm">
                {uploadState === 'uploading' ? 'Uploading...' : 'Processing pipeline running'}
              </span>
            </div>

            <Progress value={uploadState === 'uploading' ? 15 : pollProgress} className="h-1.5" />

            <div className="space-y-2.5">
              {STEPS.map((step, i) => {
                const currentStep = uploadState === 'uploading' ? 0 : 1
                const done = i < currentStep
                const active = i === currentStep
                return (
                  <div key={step.key} className="flex items-center gap-2.5 text-sm">
                    {done ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                    ) : active ? (
                      <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                    ) : (
                      <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30 shrink-0" />
                    )}
                    <span className={cn(done || active ? 'text-foreground' : 'text-muted-foreground')}>
                      {step.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Result card */}
      {uploadState === 'done' && result && statusConfig && (
        <Card className={cn('border', result.status === 'EXTRACTED' ? 'border-green-200' : result.status === 'PENDING_REVIEW' ? 'border-amber-200' : 'border-red-200')}>
          <CardContent className="pt-6 space-y-4">
            {/* Step tracker */}
            <div className="space-y-2.5">
              {STEPS.map((step, i) => {
                const completed = getCompletedSteps(result.status)
                const done = i < completed
                return (
                  <div key={step.key} className="flex items-center gap-2.5 text-sm">
                    {done ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                    ) : (
                      <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/20 shrink-0" />
                    )}
                    <span className={done ? 'text-foreground' : 'text-muted-foreground'}>
                      {step.label}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className={cn('flex items-start gap-3 rounded-lg border p-3', statusConfig.color)}>
              <div className="mt-0.5">{statusConfig.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{statusConfig.label}</span>
                  {result.confidence != null && (
                    <Badge variant="outline" className="text-xs">
                      {Math.round(result.confidence * 100)}% confidence
                    </Badge>
                  )}
                </div>
                <p className="text-xs mt-0.5 opacity-80">{statusConfig.description}</p>
              </div>
            </div>

            <div className="flex gap-2">
              {result.status === 'PENDING_REVIEW' && (
                <Button
                  onClick={() => navigate('/review')}
                  className="flex-1"
                  variant="default"
                >
                  Go to Review Queue
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              )}
              <Button onClick={reset} variant="outline" className={result.status === 'PENDING_REVIEW' ? '' : 'flex-1'}>
                Upload another
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
