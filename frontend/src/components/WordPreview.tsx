// In-app preview of the Word export with Save and Print — the user never leaves the app.
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { Ionicons } from "@expo/vector-icons";
import { exportUrl } from "@/src/api";
import { Button } from "@/src/components/ui";
import { colors } from "@/src/theme";

type Props = { docId: string; title: string; onClose: () => void };

const fileName = (t: string) => `${(t || "dokument").replace(/[^\w\-. åäöÅÄÖ]/g, "").trim() || "dokument"}.docx`;

export function WordPreview({ docId, title, onClose }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "print" | null>(null);
  const frame = useRef<any>(null);

  useEffect(() => {
    fetch(exportUrl(docId, "html"))
      .then(async (r) => {
        if (!r.ok) throw new Error("Förhandsvisningen kunde inte skapas");
        setHtml(await r.text());
      })
      .catch((e) => setError(e.message));
  }, [docId]);

  const save = async () => {
    setBusy("save");
    try {
      const url = exportUrl(docId, "docx");
      if (Platform.OS === "web") {
        const blob = await (await fetch(url)).blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileName(title);
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } else {
        const dest = new File(Paths.cache, fileName(title));
        if (dest.exists) dest.delete();
        const file = await File.downloadFileAsync(url, dest);
        await Sharing.shareAsync(file.uri, {
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          UTI: "org.openxmlformats.wordprocessingml.document",
          dialogTitle: "Spara Word-dokument",
        });
      }
    } catch (e: any) {
      Alert.alert("Kunde inte spara", e.message);
    } finally {
      setBusy(null);
    }
  };

  const print = async () => {
    if (!html) return;
    setBusy("print");
    try {
      if (Platform.OS === "web") frame.current?.contentWindow?.print();
      else await Print.printAsync({ html });
    } catch (e: any) {
      if (!/cancel/i.test(e?.message ?? "")) Alert.alert("Kunde inte skriva ut", e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={["top", "bottom", "left", "right"]}>
        <View style={styles.bar}>
          <Pressable onPress={onClose} style={styles.close} accessibilityLabel="Stäng" testID="word-preview-close">
            <Ionicons name="close" size={24} color={colors.text} />
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <Button testID="word-preview-save" small variant="primary" icon="download-outline" label="Spara" loading={busy === "save"} onPress={save} />
          <Button testID="word-preview-print" small icon="print-outline" label="Skriv ut" onPress={print} />
        </View>
        <View style={styles.body}>
          {error ? (
            <Text style={styles.error}>{error}</Text>
          ) : !html ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={styles.wait}>Skapar Word-dokumentet…</Text>
            </View>
          ) : Platform.OS === "web" ? (
            React.createElement("iframe", { ref: frame, srcDoc: html, title: "Word-förhandsvisning", "data-testid": "word-preview-frame", style: { border: 0, width: "100%", height: "100%" } })
          ) : (
            <WebView testID="word-preview-frame" originWhitelist={["*"]} source={{ html }} style={styles.web} />
          )}
        </View>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, fontSize: 16, fontWeight: "600", color: colors.text },
  body: { flex: 1, backgroundColor: colors.bg },
  web: { flex: 1, backgroundColor: "transparent" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  wait: { color: colors.muted, fontSize: 15 },
  error: { color: colors.danger, padding: 24, textAlign: "center" },
});
