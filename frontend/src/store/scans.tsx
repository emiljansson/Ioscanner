import React, { createContext, useContext, useState, useCallback, ReactNode } from "react";

export type Scan = {
  id: string;
  imageUri: string;
  structuredText: string;
  plainText: string;
  confidence: number;
  errorEstimate: number;
  attempts: number;
};

type Ctx = {
  scans: Scan[];
  addScan: (s: Scan) => void;
  updateScan: (id: string, patch: Partial<Scan>) => void;
  removeScan: (id: string) => void;
  clearAll: () => void;
  getScan: (id: string) => Scan | undefined;
};

const ScansContext = createContext<Ctx | null>(null);

export function ScansProvider({ children }: { children: ReactNode }) {
  const [scans, setScans] = useState<Scan[]>([]);

  const addScan = useCallback((s: Scan) => {
    setScans((prev) => [...prev, s]);
  }, []);

  const updateScan = useCallback((id: string, patch: Partial<Scan>) => {
    setScans((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const removeScan = useCallback((id: string) => {
    setScans((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const clearAll = useCallback(() => setScans([]), []);

  const getScan = useCallback(
    (id: string) => scans.find((s) => s.id === id),
    [scans]
  );

  return (
    <ScansContext.Provider
      value={{ scans, addScan, updateScan, removeScan, clearAll, getScan }}
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
