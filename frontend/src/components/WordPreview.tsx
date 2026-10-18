// In-app preview of the Word / PDF export with Save and Print — the user never leaves the app.
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { Ionicons } from "@expo/vector-icons";
import { exportUrl } from "@/src/api";
import { colors, radius } from "@/src/theme";

type Mode = "docx" | "pdf";
type Props = { docId: string; title: string; onClose: () => void };

const MIME: Record<Mode, { mime: string; uti: string; label: string }> = {
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", uti: "org.openxmlformats.wordprocessingml.document", label: "Word" },
  pdf: { mime: "application/pdf", uti: "com.adobe.pdf", label: "PDF" },
};
const fileName = (t: string, ext: Mode) => `${(t || "dokument").replace(/[^\w\-. åäöÅÄÖ]/g, "").trim() || "dokument"}.${ext}`;

export function WordPreview({ docId, title, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("docx");
  const [html, setHtml] = useState<string | null>(null);
  const [pdfUri, setPdfUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const frame = useRef<any>(null);

  useEffect(() => {
    fetch(exportUrl(docId, "html"))
      .then(async (r) => {
        if (!r.ok) throw new Error("Förhandsvisningen kunde inte skapas");
        setHtml(await r.text());
      })
      .catch((e) => setError(e.message));
  }, [docId]);

  // Fetch the PDF once, the first time the PDF tab is opened.
  useEffect(() => {
    if (mode !== "pdf" || pdfUri) return;
    (async () => {
      try {
        if (Platform.OS === "web") {
          const r = await fetch(exportUrl(docId, "pdf"));
          if (!r.ok) throw new Error("PDF:en kunde inte skapas");
          setPdfUri(URL.createObjectURL(await r.blob()));
        } else {
          setPdfUri((await download("pdf")).uri);
        }
      } catch (e: any) {
        setError(e.message);
      }
    })();
  }, [mode, pdfUri, docId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (Platform.OS === "web" && pdfUri) URL.revokeObjectURL(pdfUri);
  }, [pdfUri]);

  const download = async (fmt: Mode) => {
    const dest = new File(Paths.cache, fileName(title, fmt));
    if (dest.exists) dest.delete();
    return File.downloadFileAsync(exportUrl(docId, fmt), dest);
  };

  const save = async () => {
    setBusy(true);
    try {
      if (Platform.OS === "web") {
        const href = mode === "pdf" && pdfUri ? pdfUri : URL.createObjectURL(await (await fetch(exportUrl(docId, mode))).blob());
        const a = document.createElement("a");
        a.href = href;
        a.download = fileName(title, mode);
        a.click();
        if (href !== pdfUri) setTimeout(() => URL.revokeObjectURL(href), 5000);
      } else {
        const uri = mode === "pdf" && pdfUri ? pdfUri : (await download(mode)).uri;
        await Sharing.shareAsync(uri, { mimeType: MIME[mode].mime, UTI: MIME[mode].uti, dialogTitle: `Spara ${MIME[mode].label}-dokument` });
      }
    } catch (e: any) {
      Alert.alert("Kunde inte spara", e.message);
    } finally {
      setBusy(false);
    }
  };

  const print = async () => {
    try {
      if (Platform.OS === "web") frame.current?.contentWindow?.print();
      else if (mode === "pdf" && pdfUri) await Print.printAsync({ uri: pdfUri });
      else if (html) await Print.printAsync({ html });
    } catch (e: any) {
      if (!/cancel/i.test(e?.message ?? "")) Alert.alert("Kunde inte skriva ut", e.message);
    }
  };

  const ready = mode === "pdf" ? pdfUri : html;
  const preview = !ready ? (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} size="large" />
      <Text style={styles.wait}>{mode === "pdf" ? "Skapar PDF:en…" : "Skapar Word-dokumentet…"}</Text>
    </View>
  ) : Platform.OS === "web" ? (
    React.createElement("iframe", {
      key: mode, ref: frame, title: `${MIME[mode].label}-förhandsvisning`, "data-testid": `${mode}-preview-frame`,
      ...(mode === "pdf" ? { src: pdfUri } : { srcDoc: html }),
      style: { border: 0, width: "100%", height: "100%" },
    })
  ) : (
    <WebView
      key={mode}
      testID={`${mode}-preview-frame`}
      originWhitelist={["*"]}
      source={mode === "pdf" ? { uri: pdfUri! } : { html: html! }}
      allowingReadAccessToURL={mode === "pdf" ? Paths.cache.uri : undefined}
      allowFileAccess
      style={styles.web}
    />
  );

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.safe} edges={["top", "bottom", "left", "right"]}>
          <View style={styles.bar}>
            <Pressable onPress={onClose} style={styles.close} accessibilityLabel="Stäng" testID="word-preview-close">
              <Ionicons name="close" size={24} color={colors.text} />
            </Pressable>
            <View style={styles.segment}>
              {(["docx", "pdf"] as Mode[]).map((m) => (
                <Pressable key={m} testID={`preview-mode-${m}`} onPress={() => setMode(m)} style={[styles.segBtn, mode === m && styles.segOn]}>
                  <Text style={[styles.segText, mode === m && styles.segTextOn]}>{MIME[m].label}</Text>
                </Pressable>
              ))}
            </View>
            <View style={{ flex: 1 }} />
            <Pressable testID="word-preview-save" accessibilityLabel="Spara" disabled={!ready || busy} onPress={save} style={[styles.iconBtn, styles.iconPrimary, !ready && styles.dim]}>
              {busy ? <ActivityIndicator color={colors.primaryText} /> : <Ionicons name="download-outline" size={22} color={colors.primaryText} />}
            </Pressable>
            <Pressable testID="word-preview-print" accessibilityLabel="Skriv ut" disabled={!ready} onPress={print} style={[styles.iconBtn, styles.iconSecondary, !ready && styles.dim]}>
              <Ionicons name="print-outline" size={22} color={colors.text} />
            </Pressable>
          </View>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <View style={styles.body}>{error ? <Text style={styles.error}>{error}</Text> : preview}</View>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingTop: 8 },
  iconBtn: { width: 44, height: 44, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  iconPrimary: { backgroundColor: colors.primary },
  iconSecondary: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  dim: { opacity: 0.4 },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  segment: { flexDirection: "row", backgroundColor: colors.bg, borderRadius: radius.md, padding: 3 },
  segBtn: { paddingHorizontal: 14, minHeight: 36, justifyContent: "center", borderRadius: radius.sm },
  segOn: { backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  segText: { fontSize: 14, fontWeight: "600", color: colors.muted },
  segTextOn: { color: colors.text },
  title: { fontSize: 15, fontWeight: "600", color: colors.text, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  body: { flex: 1, backgroundColor: colors.bg },
  web: { flex: 1, backgroundColor: "transparent" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  wait: { color: colors.muted, fontSize: 15 },
  error: { color: colors.danger, padding: 24, textAlign: "center" },
});
