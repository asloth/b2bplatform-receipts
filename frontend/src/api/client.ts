import type { JobStatus, ReviewTask, ReviewTaskDetail } from '@/types'

const BASE = 'https://0yborlwkuf.execute-api.us-east-1.amazonaws.com'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data as T
}

export async function uploadInvoice(file: File): Promise<{ job_id: string; status: string }> {
  const form = new FormData()
  form.append('file', file)
  return request('/invoices/upload', { method: 'POST', body: form })
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  return request(`/invoices/${jobId}`)
}

export async function listReviewTasks(): Promise<{ tasks: ReviewTask[]; count: number }> {
  return request('/review/tasks')
}

export async function getReviewTask(taskId: string): Promise<ReviewTaskDetail> {
  return request(`/review/tasks/${taskId}`)
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatResponse {
  answer: string
  sql: string | null
  rows: Record<string, unknown>[] | null
}

export async function sendChatMessage(
  question: string,
  history: ChatMessage[],
): Promise<ChatResponse> {
  return request('/assist/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history }),
  })
}

export async function getInvoicePreview(invoiceId: string): Promise<{ url: string }> {
  return request(`/invoices/${invoiceId}/preview`)
}

export async function resolveReviewTask(
  taskId: string,
  correctedFields: Record<string, string>,
  resolutionNotes: string,
): Promise<{ task_id: string; status: string }> {
  return request(`/review/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ corrected_fields: correctedFields, resolution_notes: resolutionNotes }),
  })
}
