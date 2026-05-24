import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
// expo-file-system 19 split the classic API into `/legacy`. We use the
// legacy module because it still exposes documentDirectory / getInfoAsync /
// copyAsync / makeDirectoryAsync / deleteAsync which is everything we need.
import * as FileSystem from "expo-file-system/legacy";

export type PageSource = "found" | "inferred" | "missing";

export type Scan = {
  id: string;
  imageUri: string;
  structuredText: string;
  plainText: string;
  confidence: number;
  errorEstimate: number;
  coherenceScore: number;
  coherenceNote: string;
  pageNumber: number | null;
  pageSource: PageSource;
  pageNote: string;
  attempts: number;
  consensusScore: number | null;
  verifierCount: number;
  verifierLabels: string;
};

type Ctx = {
  scans: Scan[];
  hydrated: boolean;
  addScan: (s: Scan) => Promise<void>;
  updateScan: (id: string, patch: Partial<Scan>) => Promise<void>;
  removeScan: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  getScan: (id: string) => Scan | undefined;
};

const ScansContext = createContext<Ctx | null>(null);

const STORAGE_KEY = "copythat.scans.v1";
const IMAGES_DIR = `${FileSystem.documentDirectory ?? ""}scans/`;

/** Ensure the persistent images directory exists. */
async function ensureImagesDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(IMAGES_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(IMAGES_DIR, { intermediates: true });
    }
  } catch (e) {
    console.warn("[scans] ensureImagesDir failed", e);
  }
}

/** Copy a (cache) image URI to documentDirectory so it survives app restart.
 *  Returns the new persistent URI, or the original on failure / if already
 *  persistent. */
async function persistImage(uri: string, scanId: string): Promise<string> {
  if (!uri) return uri;
  // Already in our persistent dir? Skip.
  if (uri.startsWith(IMAGES_DIR)) return uri;
  // Only copy local file:// URIs. http(s) / data: are left alone.
  if (!uri.startsWith("file://") && !uri.startsWith("/")) return uri;
  try {
    await ensureImagesDir();
    // Try to keep the original extension; fall back to .jpg.
    const m = uri.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
    const ext = m ? m[1].toLowerCase() : "jpg";
    const dest = `${IMAGES_DIR}${scanId}.${ext}`;
    // Remove any stale copy first (e.g. on rescan).
    try {
      const info = await FileSystem.getInfoAsync(dest);
      if (info.exists) await FileSystem.deleteAsync(dest, { idempotent: true });
    } catch {
      /* ignore */
    }
    await FileSystem.copyAsync({ from: uri, to: dest });
    return dest;
  } catch (e) {
    console.warn("[scans] persistImage failed", e);
    return uri;
  }
}

/** Best-effort delete of a stored image. */
async function deleteImage(uri: string | undefined): Promise<void> {
  if (!uri) return;
  if (!uri.startsWith(IMAGES_DIR)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (e) {
    console.warn("[scans] deleteImage failed", e);
  }
}

export function ScansProvider({ children }: { children: ReactNode }) {
  const [scans, setScans] = useState<Scan[]>([]);
  const [hydrated, setHydrated] = useState(false);
  // Always-fresh ref so writes never race with the async hydration.
  const scansRef = useRef<Scan[]>([]);
  scansRef.current = scans;

  // Hydrate from AsyncStorage on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (cancelled) return;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            // Validate that each scan's imageUri still exists; drop the URI
            // (but keep the scan) if the file is gone — the text is still
            // useful.
            const cleaned: Scan[] = [];
            for (const s of parsed) {
              if (!s || typeof s !== "object" || !s.id) continue;
              let img = String(s.imageUri || "");
              if (img.startsWith("file://") || img.startsWith("/")) {
                try {
                  const info = await FileSystem.getInfoAsync(img);
                  if (!info.exists) img = "";
                } catch {
                  img = "";
                }
              }
              cleaned.push({
                id: String(s.id),
                imageUri: img,
                structuredText: String(s.structuredText ?? ""),
                plainText: String(s.plainText ?? ""),
                confidence: Number(s.confidence ?? 0) || 0,
                errorEstimate: Number(s.errorEstimate ?? 0) || 0,
                coherenceScore: Number(s.coherenceScore ?? 0) || 0,
                coherenceNote: String(s.coherenceNote ?? ""),
                pageNumber:
                  s.pageNumber == null ? null : Number(s.pageNumber) || null,
                pageSource: (["found", "inferred", "missing"] as const).includes(
                  s.pageSource
                )
                  ? s.pageSource
                  : "missing",
                pageNote: String(s.pageNote ?? ""),
                attempts: Number(s.attempts ?? 1) || 1,
                consensusScore:
                  s.consensusScore == null ? null : Number(s.consensusScore),
                verifierCount: Number(s.verifierCount ?? 0) || 0,
                verifierLabels: String(s.verifierLabels ?? ""),
              });
            }
            setScans(cleaned);
          }
        }
      } catch (e) {
        console.warn("[scans] hydrate failed", e);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fire-and-forget persistence. Uses the latest scans array via ref so we
  // never race with React state batching.
  const persist = useCallback(async (next: Scan[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn("[scans] persist failed", e);
    }
  }, []);

  const addScan = useCallback(
    async (s: Scan) => {
      const persistedUri = await persistImage(s.imageUri, s.id);
      const finalScan: Scan = { ...s, imageUri: persistedUri };
      const next = [...scansRef.current, finalScan];
      setScans(next);
      await persist(next);
    },
    [persist]
  );

  const updateScan = useCallback(
    async (id: string, patch: Partial<Scan>) => {
      let nextScan: Scan | null = null;
      let oldImage: string | undefined;
      // If the patch contains a new imageUri (rescan), persist it first and
      // remember to delete the old one.
      let finalPatch: Partial<Scan> = patch;
      if (patch.imageUri !== undefined) {
        const existing = scansRef.current.find((s) => s.id === id);
        oldImage = existing?.imageUri;
        const newUri = await persistImage(patch.imageUri, id);
        finalPatch = { ...patch, imageUri: newUri };
      }
      const next = scansRef.current.map((s) => {
        if (s.id !== id) return s;
        nextScan = { ...s, ...finalPatch };
        return nextScan;
      });
      setScans(next);
      await persist(next);
      // Best-effort cleanup of the replaced image (only if different).
      if (oldImage && nextScan && oldImage !== nextScan.imageUri) {
        await deleteImage(oldImage);
      }
    },
    [persist]
  );

  const removeScan = useCallback(
    async (id: string) => {
      const target = scansRef.current.find((s) => s.id === id);
      const next = scansRef.current.filter((s) => s.id !== id);
      setScans(next);
      await persist(next);
      await deleteImage(target?.imageUri);
    },
    [persist]
  );

  const clearAll = useCallback(async () => {
    const old = scansRef.current;
    setScans([]);
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.warn("[scans] clearAll persist failed", e);
    }
    // Delete images (best-effort, in parallel)
    await Promise.allSettled(old.map((s) => deleteImage(s.imageUri)));
  }, []);

  const getScan = useCallback(
    (id: string) => scans.find((s) => s.id === id),
    [scans]
  );

  return (
    <ScansContext.Provider
      value={{
        scans,
        hydrated,
        addScan,
        updateScan,
        removeScan,
        clearAll,
        getScan,
      }}
    >
      {children}
    </ScansContext.Provider>
  );
}

export function useScans() {
  const ctx = useContext(ScansContext);
  if (!ctx) throw new Error("useScans must be used within ScansProvider");
  return ctx;
}
