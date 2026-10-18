// Client for ScanBridge (Windows tray app wrapping NAPS2) on http://127.0.0.1:7226. Web only.
const BASE = "http://127.0.0.1:7226/api/v1";
export const SCANBRIDGE_DOWNLOAD = "https://github.com/gcgov/ScanBridge/releases";

export type ScanOptions = { paperSource: "duplex" | "feeder" | "flatbed"; dpi: number; colorMode: "color" | "grayscale" | "blackAndWhite" };
export type ScanStatus = { app: string; version: string; scannerConfigured: boolean; scannerName?: string };
type Job = { jobId: string; status: string; pagesScanned: number; error: { code: string; message: string } | null };

const ERRORS: Record<string, string> = {
  scannerBusy: "Scannern används redan av en annan scanning.",
  noScannerConfigured: "Ingen scanner är vald i ScanBridge. Högerklicka på ikonen → Settings… och välj din scanner.",
  deviceOffline: "Scannern svarar inte. Kontrollera att den är påslagen och ansluten.",
  noPages: "Inga sidor scannades. Ligger papperet i dokumentmataren?",
  canceled: "Scanningen avbröts.",
};

export class ScanError extends Error {}

async function sb(path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, targetAddressSpace: "loopback" } as RequestInit);
  } catch {
    throw new ScanError("unreachable");
  }
  if (!res.ok) {
    let code = "";
    let message = `ScanBridge-fel ${res.status}`;
    try {
      const j = await res.json();
      code = j?.error?.code ?? "";
      message = j?.error?.message ?? message;
    } catch {}
    throw new ScanError(ERRORS[code] ?? message);
  }
  return res;
}

export async function scanBridgeStatus(): Promise<ScanStatus> {
  return (await sb("/status")).json();
}

/** Runs a scan and returns the PDF as a File. onPages reports pages scanned so far. */
export async function runScan(opts: ScanOptions, onPages: (n: number) => void, signal: { canceled: boolean }): Promise<File> {
  const start = await sb("/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paperSource: opts.paperSource, dpi: opts.dpi, colorMode: opts.colorMode, pageSize: "a4" }),
  });
  const { jobId } = await start.json();
  let job: Job;
  do {
    await new Promise((r) => setTimeout(r, 1000));
    if (signal.canceled) {
      await sb(`/scans/${jobId}`, { method: "DELETE" }).catch(() => {});
      throw new ScanError(ERRORS.canceled);
    }
    job = await (await sb(`/scans/${jobId}`)).json();
    onPages(job.pagesScanned ?? 0);
  } while (!["completed", "failed", "canceled"].includes(job.status));
  if (job.status !== "completed") throw new ScanError(ERRORS[job.error?.code ?? ""] ?? job.error?.message ?? "Scanningen misslyckades");
  const blob = await (await sb(`/scans/${jobId}/document`)).blob();
  sb(`/scans/${jobId}`, { method: "DELETE" }).catch(() => {});
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
  return new File([blob], `scanning_${stamp}.pdf`, { type: "application/pdf" });
}
