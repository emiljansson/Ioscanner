// "Bilder" panel: every extracted image of a document with preview and remove/restore.
import React, { useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { api, type Doc, type Page } from "@/src/api";
import { Button } from "@/src/components/ui";
import { colors, radius } from "@/src/theme";

type Item = { key: string; url: string; caption: string; pageLabel: string; deleted: boolean; pageId?: string; figId?: string };

export function collectFigures(doc: Doc): Item[] {
  if (doc.kind === "generated") {
    const all = { ...(doc.source_figures ?? {}), ...(doc.figures ?? {}) };
    return Object.entries(all).map(([id, url]) => ({ key: id, url, caption: doc.figure_captions?.[id] ?? "", pageLabel: "Källmaterial", deleted: false }));
  }
  const out: Item[] = [];
  (doc.pages ?? []).forEach((p, i) =>
    p.figures.forEach((f) =>
      out.push({ key: f.id, url: f.url, caption: f.caption, pageLabel: `Sida ${i + 1}`, deleted: f.deleted, pageId: p.id, figId: f.id })
    )
  );
  return out;
}

type Props = { doc: Doc; onClose: () => void; onPageChanged: (p: Page) => void; onDownloadZip: () => void };

export function FiguresPanel({ doc, onClose, onPageChanged, onDownloadZip }: Props) {
  const items = collectFigures(doc);
  const [preview, setPreview] = useState<Item | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { width, height } = useWindowDimensions();
  const active = items.filter((x) => !x.deleted).length;

  const toggle = async (it: Item) => {
    if (!it.pageId) return;
    try {
      onPageChanged(await api<Page>(`/pages/${it.pageId}/figures/${it.figId}`, { method: "PATCH", body: { deleted: !it.deleted } }));
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe} testID="figures-panel">
        <View style={styles.head}>
          <Ionicons name="images-outline" size={22} color={colors.primary} />
          <Text style={styles.title}>Bilder ({active})</Text>
          <View style={{ flex: 1 }} />
          <Button small icon="archive-outline" label="Ladda ner ZIP" onPress={onDownloadZip} testID="figures-zip" />
          <Pressable onPress={onClose} style={styles.icon} accessibilityLabel="Stäng" testID="figures-close">
            <Ionicons name="close" size={24} color={colors.text} />
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Alla utklippta bilder ingår i ZIP-filen (mappen ”bilder”). Ta bort de som inte ska vara med. Hittas ingen bild på en sida: tryck ”Förbättra sida” eller ”Nytt bildutklipp” i dokumentet.
        </Text>
        {err && <Text style={styles.err}>{err}</Text>}
        <ScrollView contentContainerStyle={styles.grid}>
          {items.length === 0 && <Text style={styles.empty}>Inga bilder hittades i dokumentet.</Text>}
          {items.map((it) => (
            <View key={it.key} style={[styles.card, it.deleted && styles.deleted]} testID="figure-item">
              <Pressable onPress={() => setPreview(it)} accessibilityLabel="Förhandsgranska bild">
                <Image source={{ uri: it.url }} style={styles.thumb} resizeMode="contain" />
              </Pressable>
              <Text style={styles.page}>{it.pageLabel}{it.deleted ? " · borttagen" : ""}</Text>
              {!!it.caption && <Text style={styles.caption} numberOfLines={2}>{it.caption}</Text>}
              <View style={styles.row}>
                <Button small icon="eye-outline" label="Förhandsgranska" onPress={() => setPreview(it)} testID="figure-preview" />
                {it.pageId && (
                  <Pressable onPress={() => toggle(it)} style={styles.icon} accessibilityLabel={it.deleted ? "Återställ" : "Ta bort"} testID="figure-item-toggle">
                    <Ionicons name={it.deleted ? "arrow-undo" : "trash-outline"} size={18} color={it.deleted ? colors.text : colors.danger} />
                  </Pressable>
                )}
              </View>
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
      {preview && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setPreview(null)}>
          <Pressable style={styles.backdrop} onPress={() => setPreview(null)} testID="figure-preview-modal">
            <Image source={{ uri: preview.url }} style={{ width: width - 32, height: height - 200 }} resizeMode="contain" />
            <Text style={styles.previewCap}>{preview.pageLabel}{preview.caption ? ` · ${preview.caption}` : ""}</Text>
            <Text style={styles.previewHint}>Tryck för att stänga</Text>
          </Pressable>
        </Modal>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  head: { flexDirection: "row", alignItems: "center", gap: 8, padding: 16 },
  title: { fontSize: 20, fontWeight: "700", color: colors.text },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  hint: { fontSize: 13, color: colors.muted, paddingHorizontal: 16, lineHeight: 18 },
  err: { margin: 16, padding: 12, color: colors.danger, backgroundColor: colors.dangerSoft, borderRadius: radius.md },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12, padding: 16 },
  card: { width: 220, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 10, gap: 6 },
  deleted: { opacity: 0.45 },
  thumb: { width: "100%", height: 150, backgroundColor: colors.bg, borderRadius: radius.sm },
  page: { fontSize: 13, fontWeight: "700", color: colors.text },
  caption: { fontSize: 12, color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  empty: { fontSize: 15, color: colors.muted },
  backdrop: { flex: 1, backgroundColor: colors.overlay, alignItems: "center", justifyContent: "center", gap: 12 },
  previewCap: { color: colors.primaryText, fontSize: 15, fontWeight: "600", textAlign: "center", paddingHorizontal: 16 },
  previewHint: { color: colors.primaryText, fontSize: 12, opacity: 0.8 },
});
