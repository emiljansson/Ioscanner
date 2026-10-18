import React, { useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api, type Page } from "@/src/api";
import { Button, ConfidenceBadge } from "@/src/components/ui";
import { MarkdownView } from "@/src/components/MarkdownView";
import { CropEditor } from "@/src/components/CropEditor";
import { colors, radius } from "@/src/theme";

type Props = {
  page: Page;
  index: number;
  total: number;
  selected: boolean;
  onToggleSelect: () => void;
  onChanged: (p?: Page) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
};

const PROVIDER_LABEL: Record<string, string> = { openai: "OpenAI", gemini: "Gemini", anthropic: "Claude" };

export function PageCard({ page, index, total, selected, onToggleSelect, onChanged, onDelete, onMove }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(page.markdown);
  const [showOriginal, setShowOriginal] = useState(false);
  const [crop, setCrop] = useState<{ figId?: string; box?: number[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const figMap: Record<string, { url: string; caption: string }> = {};
  page.figures.filter((f) => !f.deleted).forEach((f) => (figMap[`n${f.n}`] = { url: f.url, caption: f.caption }));

  return (
    <View style={styles.card} testID={`page-${index + 1}`}>
      <View style={styles.head}>
        <Pressable onPress={onToggleSelect} style={styles.check} testID={`page-select-${index + 1}`} accessibilityLabel="Välj sida">
          <Ionicons name={selected ? "checkbox" : "square-outline"} size={22} color={selected ? colors.primary : colors.muted} />
        </Pressable>
        <Text style={styles.pageNo}>
          Sida {index + 1}
          {page.page_number != null ? ` (tryckt nr ${page.page_number})` : ""}
        </Text>
        <ConfidenceBadge value={page.status === "done" ? page.confidence : null} />
        <View style={{ flex: 1 }} />
        <Pressable disabled={index === 0} onPress={() => onMove(-1)} style={styles.icon} accessibilityLabel="Flytta upp">
          <Ionicons name="arrow-up" size={18} color={index === 0 ? colors.border : colors.muted} />
        </Pressable>
        <Pressable disabled={index === total - 1} onPress={() => onMove(1)} style={styles.icon} accessibilityLabel="Flytta ner">
          <Ionicons name="arrow-down" size={18} color={index === total - 1 ? colors.border : colors.muted} />
        </Pressable>
        <Pressable onPress={onDelete} style={styles.icon} accessibilityLabel="Ta bort sida" testID={`page-delete-${index + 1}`}>
          <Ionicons name="trash-outline" size={18} color={colors.danger} />
        </Pressable>
      </View>

      {(page.status === "queued" || page.status === "processing") && (
        <View style={styles.pending}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.pendingText}>{page.status === "queued" ? "I kö…" : "AI läser sidan och letar efter bilder…"}</Text>
        </View>
      )}

      {page.status === "error" && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{page.error || "Något gick fel"}</Text>
          <Button small label="Försök igen" icon="refresh" onPress={() => run("rescan", async () => { await api(`/pages/${page.id}/rescan`, { method: "POST" }); onChanged(); })} loading={busy === "rescan"} />
        </View>
      )}

      {page.status === "done" && (
        <>
          {showOriginal && <Image source={{ uri: page.image_url }} style={[styles.original, { aspectRatio: page.width / page.height }]} resizeMode="contain" />}
          {editing ? (
            <TextInput testID="page-editor" style={styles.editor} multiline value={draft} onChangeText={setDraft} textAlignVertical="top" />
          ) : (
            <View style={styles.paper}>
              {page.markdown ? <MarkdownView markdown={page.markdown} figures={figMap} /> : <Text style={styles.muted}>Ingen text hittades på sidan.</Text>}
            </View>
          )}
          {page.figures.length > 0 && (
            <View style={styles.figs}>
              {page.figures.map((f) => (
                <View key={f.id} style={[styles.fig, f.deleted && { opacity: 0.4 }]}>
                  <Image source={{ uri: f.url }} style={styles.figThumb} resizeMode="cover" />
                  <View style={styles.figActions}>
                    <Pressable onPress={() => setCrop({ figId: f.id, box: f.box_2d })} style={styles.icon} accessibilityLabel="Justera utklipp" testID="figure-adjust">
                      <Ionicons name="crop" size={16} color={colors.text} />
                    </Pressable>
                    <Pressable
                      testID="figure-toggle"
                      style={styles.icon}
                      accessibilityLabel={f.deleted ? "Återställ bild" : "Ta bort bild"}
                      onPress={() => run("fig", async () => onChanged(await api<Page>(`/pages/${page.id}/figures/${f.id}`, { method: "PATCH", body: { deleted: !f.deleted } })))}
                    >
                      <Ionicons name={f.deleted ? "arrow-undo" : "close"} size={16} color={f.deleted ? colors.text : colors.danger} />
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          )}
          <View style={styles.actions}>
            {editing ? (
              <>
                <Button small label="Avbryt" onPress={() => { setDraft(page.markdown); setEditing(false); }} />
                <Button
                  testID="page-save"
                  small
                  variant="primary"
                  label="Spara text"
                  loading={busy === "save"}
                  onPress={() => run("save", async () => { onChanged(await api<Page>(`/pages/${page.id}`, { method: "PATCH", body: { markdown: draft } })); setEditing(false); })}
                />
              </>
            ) : (
              <>
                <Button testID="page-edit" small icon="create-outline" label="Redigera" onPress={() => { setDraft(page.markdown); setEditing(true); }} />
                <Button small icon={showOriginal ? "eye-off-outline" : "image-outline"} label={showOriginal ? "Dölj original" : "Visa original"} onPress={() => setShowOriginal((s) => !s)} />
                <Button small icon="crop" label="Nytt bildutklipp" onPress={() => setCrop({})} />
                <Button
                  testID="page-rescan"
                  small
                  icon="sparkles-outline"
                  label="Förbättra sida"
                  loading={busy === "rescan"}
                  onPress={() => run("rescan", async () => { await api(`/pages/${page.id}/rescan`, { method: "POST" }); onChanged(); })}
                />
              </>
            )}
          </View>
          {!!page.ai && (
            <Text style={styles.meta}>
              Läst av {PROVIDER_LABEL[page.ai.provider] ?? page.ai.provider} ({page.ai.mode === "fast" ? "Snabb" : page.ai.mode === "balanced" ? "Balanserad" : "Bäst"})
              {page.ai.verifiers?.length ? ` · kontrollerad av ${page.ai.verifiers.filter((v: any) => v.ok).map((v: any) => PROVIDER_LABEL[v.provider]).join(", ") || "–"}` : ""}
              {page.ai.coherence_note ? ` · ${page.ai.coherence_note}` : ""}
              {page.edited ? " · redigerad" : ""}
            </Text>
          )}
        </>
      )}
      {err && <Text style={styles.errorText}>{err}</Text>}

      {crop && (
        <CropEditor
          visible
          imageUrl={page.image_url}
          imgW={page.width}
          imgH={page.height}
          initialBox={crop.box}
          onCancel={() => setCrop(null)}
          onSave={async (box) => {
            try {
              const p = crop.figId
                ? await api<Page>(`/pages/${page.id}/figures/${crop.figId}`, { method: "PATCH", body: { box_2d: box } })
                : await api<Page>(`/pages/${page.id}/figures`, { body: { box_2d: box, caption: "" } });
              onChanged(p);
              setCrop(null);
            } catch (e: any) {
              setErr(e.message);
              setCrop(null);
            }
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 16, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  check: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  pageNo: { fontSize: 15, fontWeight: "700", color: colors.text },
  icon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  pending: { flexDirection: "row", gap: 12, alignItems: "center", padding: 16, backgroundColor: colors.primarySoft, borderRadius: radius.md },
  pendingText: { color: colors.primary, fontSize: 14, fontWeight: "600" },
  errorBox: { gap: 10, padding: 12, backgroundColor: colors.dangerSoft, borderRadius: radius.md, alignItems: "flex-start" },
  errorText: { color: colors.danger, fontSize: 14 },
  original: { width: "100%", maxHeight: 900, backgroundColor: colors.bg, borderRadius: radius.md },
  paper: { paddingHorizontal: 8, paddingVertical: 4 },
  editor: { minHeight: 320, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, fontSize: 14, fontFamily: "monospace", color: colors.text, backgroundColor: colors.bg },
  muted: { color: colors.muted, fontStyle: "italic" },
  figs: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  fig: { width: 120, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.bg },
  figThumb: { width: 120, height: 90 },
  figActions: { flexDirection: "row", justifyContent: "space-between" },
  actions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  meta: { fontSize: 12, color: colors.faint },
});
