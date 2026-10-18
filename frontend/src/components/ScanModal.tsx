// "Scanna" dialog for the web: talks to ScanBridge on this computer, then hands the PDF to the uploader.
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button } from "@/src/components/ui";
import { runScan, scanBridgeStatus, ScanError, SCANBRIDGE_DOWNLOAD, type ScanOptions, type ScanStatus } from "@/src/scanbridge";
import { colors, radius } from "@/src/theme";

type Props = { visible: boolean; onClose: () => void; onScanned: (file: File) => void };

const SOURCES = [
  { id: "duplex", label: "Dubbelsidigt", hint: "Dokumentmataren, båda sidor" },
  { id: "feeder", label: "Enkelsidigt", hint: "Dokumentmataren, framsidor" },
  { id: "flatbed", label: "Glas", hint: "En sida i taget" },
] as const;
const DPIS = [200, 300, 600];
const COLORS = [
  { id: "color", label: "Färg" },
  { id: "grayscale", label: "Gråskala" },
  { id: "blackAndWhite", label: "Svartvitt" },
] as const;

function Seg<T extends string | number>({ items, value, onChange, testPrefix }: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void; testPrefix: string }) {
  return (
    <View style={styles.seg}>
      {items.map((it) => (
        <Pressable key={String(it.id)} testID={`${testPrefix}-${it.id}`} onPress={() => onChange(it.id)} style={[styles.segBtn, value === it.id && styles.segActive]}>
          <Text style={[styles.segText, value === it.id && styles.segTextActive]}>{it.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function ScanModal({ visible, onClose, onScanned }: Props) {
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [state, setState] = useState<"checking" | "missing" | "ready" | "scanning">("checking");
  const [opts, setOpts] = useState<ScanOptions>({ paperSource: "duplex", dpi: 300, colorMode: "color" });
  const [pages, setPages] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const signal = useRef({ canceled: false });

  const check = async () => {
    setState("checking");
    setErr(null);
    try {
      setStatus(await scanBridgeStatus());
      setState("ready");
    } catch {
      setState("missing");
    }
  };

  useEffect(() => {
    if (visible) check();
  }, [visible]);

  const scan = async () => {
    signal.current = { canceled: false };
    setPages(0);
    setErr(null);
    setState("scanning");
    try {
      const file = await runScan(opts, setPages, signal.current);
      onScanned(file);
      onClose();
    } catch (e: any) {
      setErr(e instanceof ScanError && e.message === "unreachable" ? "Kontakten med ScanBridge bröts. Är programmet igång?" : e.message);
    }
    setState("ready");
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card} testID="scan-modal">
          <View style={styles.head}>
            <Ionicons name="print-outline" size={22} color={colors.primary} />
            <Text style={styles.title}>Scanna</Text>
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => { signal.current.canceled = true; onClose(); }} style={styles.icon} accessibilityLabel="Stäng" testID="scan-close">
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>

          {state === "checking" && <ActivityIndicator color={colors.primary} />}

          {state === "missing" && (
            <View style={styles.box} testID="scanbridge-missing">
              <Text style={styles.boxTitle}>ScanBridge hittades inte på den här datorn</Text>
              <Text style={styles.text}>1. Installera ScanBridge (gratis, Windows) och starta det. Ikonen syns nere vid klockan.</Text>
              <Text style={styles.text}>2. Högerklicka på ikonen → Settings…: välj din scanner (WIA eller ESCL) och lägg till den här adressen under ”Allowed website origins”:</Text>
              <Text style={styles.code} selectable>{typeof window !== "undefined" ? window.location.origin : ""}</Text>
              <Text style={styles.text}>3. Använd Chrome, Edge eller Firefox. Klicka ”Tillåt” om webbläsaren frågar om åtkomst till enheter.</Text>
              <View style={styles.row}>
                <Button small icon="download-outline" label="Ladda ner ScanBridge" onPress={() => Linking.openURL(SCANBRIDGE_DOWNLOAD)} />
                <Button testID="scan-retry" small variant="primary" icon="refresh" label="Försök igen" onPress={check} />
              </View>
            </View>
          )}

          {(state === "ready" || state === "scanning") && (
            <>
              <Text style={styles.muted}>
                Scanner: {status?.scannerConfigured ? status.scannerName ?? "vald" : "ingen vald i ScanBridge"}
              </Text>
              <Text style={styles.label}>Papperskälla</Text>
              <Seg testPrefix="source" items={SOURCES.map((s) => ({ id: s.id, label: s.label }))} value={opts.paperSource} onChange={(v) => setOpts({ ...opts, paperSource: v })} />
              <Text style={styles.muted}>{SOURCES.find((s) => s.id === opts.paperSource)?.hint}</Text>
              <Text style={styles.label}>Upplösning</Text>
              <Seg testPrefix="dpi" items={DPIS.map((d) => ({ id: d, label: `${d} dpi` }))} value={opts.dpi} onChange={(v) => setOpts({ ...opts, dpi: v })} />
              <Text style={styles.label}>Färg</Text>
              <Seg testPrefix="color" items={COLORS.map((c) => ({ id: c.id, label: c.label }))} value={opts.colorMode} onChange={(v) => setOpts({ ...opts, colorMode: v })} />
              {state === "scanning" ? (
                <View style={styles.progress}>
                  <ActivityIndicator color={colors.primary} />
                  <Text style={styles.progressText}>Scannar… {pages} sidor</Text>
                  <View style={{ flex: 1 }} />
                  <Button small label="Avbryt" onPress={() => (signal.current.canceled = true)} />
                </View>
              ) : (
                <Button testID="scan-start" variant="primary" icon="print-outline" label="Starta scanning" onPress={scan} />
              )}
            </>
          )}
          {err && <Text style={styles.err} testID="scan-error">{err}</Text>}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.overlay, alignItems: "center", justifyContent: "center", padding: 16 },
  card: { width: "100%", maxWidth: 520, backgroundColor: colors.surface, borderRadius: radius.lg, padding: 20, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 20, fontWeight: "700", color: colors.text },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  box: { gap: 10, backgroundColor: colors.warnSoft, padding: 16, borderRadius: radius.md },
  boxTitle: { fontSize: 16, fontWeight: "700", color: colors.warn },
  text: { fontSize: 14, color: colors.text, lineHeight: 20 },
  code: { fontFamily: "monospace", fontSize: 14, backgroundColor: colors.surface, padding: 8, borderRadius: radius.sm, color: colors.text },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  muted: { fontSize: 13, color: colors.muted },
  label: { fontSize: 12, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  seg: { flexDirection: "row", backgroundColor: colors.bg, borderRadius: radius.md, padding: 4, gap: 4 },
  segBtn: { flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  segActive: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  segText: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  segTextActive: { color: colors.text },
  progress: { flexDirection: "row", gap: 12, alignItems: "center", padding: 12, backgroundColor: colors.primarySoft, borderRadius: radius.md },
  progressText: { color: colors.primary, fontWeight: "600" },
  err: { color: colors.danger, backgroundColor: colors.dangerSoft, padding: 12, borderRadius: radius.md },
});
