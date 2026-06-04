export type InvoiceStatus =
  | 'PROCESSING'
  | 'EXTRACTED'
  | 'PENDING_REVIEW'
  | 'REJECTED'
  | 'FAILED'

export interface JobStatus {
  job_id: string
  status: InvoiceStatus
  confidence: number | null
  is_invoice: boolean | null
  created_at: string
}

export interface ReviewTask {
  task_id: string
  invoice_id: string
  doc_confidence: number
  low_confidence_fields: Record<string, { confidence: number; value: string | number | null }>
  status: 'OPEN' | 'RESOLVED'
  created_at: string
  s3_key: string
}

export interface InvoiceField {
  field_name: string
  raw_value: string | null
  normalised_value: string | null
  confidence: number
  source: 'llm' | 'human' | 'textract'
}

export interface ReviewTaskDetail extends ReviewTask {
  invoice_status: InvoiceStatus
  fields: InvoiceField[]
}
