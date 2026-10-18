// Thin client for the CopyThat backend.
import { Platform } from "react-native";
import { storage } from "@/src/utils/storage";
import { uploadForm } from "@/src/utils/upload";

export const API_URL = `${process.env.EXPO_PUBLIC_BACKEND_URL ?? ""}/api`;
const TOKEN_KEY = "copythat.token";

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export async function loadToken(): Promise<string | null> {
  token = (await storage.secureGet<string>(TOKEN_KEY, "")) || null;
  return token;
}
export async function saveToken(t: string | null) {
  token = t;
  if (t) await storage.secureSet(TOKEN_KEY, t);
  else await storage.secureRemove(TOKEN_KEY);
}
export const getToken = () => token;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parse(res: Response) {
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.();
    const d = data?.detail;
    const msg = typeof d === "string" ? d : Array.isArray(d) ? d.map((x: any) => x.msg).join(", ") : `Fel ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: {
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Ingen kontakt med servern – kontrollera internetanslutningen");
  }
  return parse(res);
}

export type PickedFile = { name: string; size?: number; uri: string; file?: File; mimeType?: string };

/** Chunked upload into a document. Returns number of pages created. */
export async function uploadFile(
  documentId: string,
  f: PickedFile,
  onProgress?: (fraction: number) => void
): Promise<number> {
  const init = await api<{ upload_id: string; chunk_size: number }>("/uploads/init", {
    body: { document_id: documentId, filename: f.name, size: f.size ?? 0 },
  });
  const headers = { Authorization: `Bearer ${token}` };
  const url = `${API_URL}/uploads/${init.upload_id}/chunk`;
  if (Platform.OS === "web" && f.file) {
    const total = Math.max(1, Math.ceil(f.file.size / init.chunk_size));
    for (let i = 0; i < total; i++) {
      const blob = f.file.slice(i * init.chunk_size, (i + 1) * init.chunk_size);
      await parse(await uploadForm(url, { headers, fields: { index: i }, files: { file: { blob, name: f.name } } }));
      onProgress?.((i + 1) / total);
    }
  } else {
    await parse(await uploadForm(url, { headers, fields: { index: 0 }, files: { file: { uri: f.uri, name: f.name, mimeType: f.mimeType } } }));
    onProgress?.(1);
  }
  const done = await api<{ pages_created: number }>(`/uploads/${init.upload_id}/complete`, { method: "POST" });
  return done.pages_created;
}

export function exportUrl(docId: string, format: "docx" | "zip" | "txt" | "html") {
  return `${API_URL}/documents/${docId}/export?format=${format}&token=${encodeURIComponent(token ?? "")}`;
}

// ---------- Types ----------
export type User = { id: string; email: string; role: "owner" | "member"; last_login?: string };
export type Course = { id: string; name: string; document_count: number };
export type Figure = { id: string; n: number; url: string; caption: string; deleted: boolean; box_2d: number[] };
export type Page = {
  id: string;
  document_id: string;
  order: number;
  status: "queued" | "processing" | "done" | "error";
  error: string | null;
  image_url: string;
  width: number;
  height: number;
  markdown: string;
  confidence: number | null;
  page_number: number | null;
  figures: Figure[];
  source_name: string;
  edited?: boolean;
  ai?: { provider: string; model: string; mode: string; coherence_note: string; verifiers: any[] };
};
export type Doc = {
  id: string;
  course_id: string;
  title: string;
  kind: "scan" | "generated";
  status: "ready" | "processing" | "error";
  error?: string;
  instruction?: string;
  markdown?: string;
  figures?: Record<string, string>;
  source_figures?: Record<string, string>;
  figure_captions?: Record<string, string>;
  page_counts?: Record<string, number>;
  page_total?: number;
  pages?: Page[];
  updated_at: string;
};
export type Template = { id: string; name: string; instruction: string };
