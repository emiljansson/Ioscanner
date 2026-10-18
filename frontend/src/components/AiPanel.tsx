// "Bearbeta med AI" panel: free instruction + saved templates.
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api, type Doc, type Template } from "@/src/api";
import { Button } from "@/src/components/ui";
import { colors, radius } from "@/src/theme";

type Props = { doc: Doc; selectedPageIds: string[]; onCreated: (d: Doc) => void; onClose: () => void };

export function AiPanel({ doc, selectedPageIds, onCreated, onClose }: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [instruction, setInstruction] = useState("");
  const [scope, setScope] = useState<"doc" | "pages">(selectedPageIds.length ? "pages" : "doc");
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Template[]>("/templates").then(setTemplates).catch(() => {});
  }, []);
  useEffect(() => {
    if (!selectedPageIds.length) setScope("doc");
  }, [selectedPageIds.length]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = scope === "pages" ? { instruction, page_ids: selectedPageIds } : { instruction, document_ids: [doc.id] };
      onCreated(await api<Doc>("/process", { body }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveTemplate = async () => {
    const t = await api<Template>("/templates", { body: { name: saveName.trim(), instruction } });
    setTemplates((x) => [...x, t]);
    setSaveName("");
  };

  return (
    <ScrollView style={styles.panel} contentContainerStyle={{ gap: 12, padding: 16 }} keyboardShouldPersistTaps="handled">
      <View style={styles.head}>
        <Ionicons name="sparkles" size={20} color={colors.primary} />
        <Text style={styles.title}>Bearbeta med AI</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={onClose} style={styles.icon} accessibilityLabel="Stäng" testID="ai-panel-close">
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
      </View>
      <Text style={styles.label}>Vad ska bearbetas?</Text>
      <View style={styles.seg}>
        <Pressable testID="scope-doc" onPress={() => setScope("doc")} style={[styles.segBtn, scope === "doc" && styles.segActive]}>
          <Text style={[styles.segText, scope === "doc" && styles.segTextActive]}>Hela dokumentet</Text>
        </Pressable>
        <Pressable testID="scope-pages" disabled={!selectedPageIds.length} onPress={() => setScope("pages")} style={[styles.segBtn, scope === "pages" && styles.segActive, !selectedPageIds.length && { opacity: 0.4 }]}>
          <Text style={[styles.segText, scope === "pages" && styles.segTextActive]}>Valda sidor ({selectedPageIds.length})</Text>
        </Pressable>
      </View>
      <Text style={styles.label}>Mallar</Text>
      <View style={styles.chips}>
        {templates.map((t) => (
          <Pressable key={t.id} onPress={() => setInstruction(t.instruction)} style={styles.chip} testID={`template-${t.name}`}>
            <Text style={styles.chipText}>{t.name}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.label}>Din instruktion</Text>
      <TextInput
        testID="ai-instruction"
        style={styles.input}
        multiline
        value={instruction}
        onChangeText={setInstruction}
        placeholder="T.ex. ”Gör en sammanfattning med de viktigaste begreppen och 10 övningsfrågor med svar.”"
        placeholderTextColor={colors.faint}
        textAlignVertical="top"
      />
      <Button testID="ai-submit" label="Skapa nytt dokument" icon="sparkles" variant="primary" onPress={submit} loading={busy} disabled={instruction.trim().length < 3} />
      <Text style={styles.hint}>Resultatet sparas som ett nytt dokument i samma kurs. Originalet lämnas orört.</Text>
      {err && <Text style={styles.err}>{err}</Text>}
      <View style={styles.saveRow}>
        <TextInput style={[styles.small]} value={saveName} onChangeText={setSaveName} placeholder="Spara instruktionen som mall…" placeholderTextColor={colors.faint} />
        <Button small label="Spara" onPress={saveTemplate} disabled={!saveName.trim() || instruction.trim().length < 3} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: colors.surface },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 18, fontWeight: "700", color: colors.text },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 12, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  seg: { flexDirection: "row", backgroundColor: colors.bg, borderRadius: radius.md, padding: 4, gap: 4 },
  segBtn: { flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  segActive: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  segText: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  segTextActive: { color: colors.text },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, minHeight: 36, justifyContent: "center", borderRadius: 999, backgroundColor: colors.primarySoft },
  chipText: { color: colors.primary, fontWeight: "600", fontSize: 13 },
  input: { minHeight: 140, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, fontSize: 15, color: colors.text },
  hint: { fontSize: 13, color: colors.muted },
  err: { color: colors.danger, backgroundColor: colors.dangerSoft, padding: 10, borderRadius: radius.md },
  saveRow: { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 8 },
  small: { flex: 1, minHeight: 40, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 14, color: colors.text },
});
