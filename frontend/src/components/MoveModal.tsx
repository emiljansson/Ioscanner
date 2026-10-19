// Dialog for moving a document to another course.
import React, { useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button } from "@/src/components/ui";
import type { Course } from "@/src/api";
import { colors, radius } from "@/src/theme";

type Props = {
  docTitle: string;
  currentCourseId: string;
  courses: Course[];
  onMove: (courseId: string) => Promise<void>;
  onClose: () => void;
};

export function MoveModal({ docTitle, currentCourseId, courses, onMove, onClose }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targets = courses.filter((c) => c.id !== currentCourseId);

  const move = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      await onMove(id);
      onClose();
    } catch (e: any) {
      setError(e.message);
      setBusy(null);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Stäng" />
        <View style={styles.card} testID="move-modal">
          <Text style={styles.h}>Flytta dokument</Text>
          <Text style={styles.sub} numberOfLines={2}>”{docTitle}” – välj kurs:</Text>
          {targets.length === 0 ? (
            <Text style={styles.sub}>Det finns ingen annan kurs. Skapa en kurs först.</Text>
          ) : (
            <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 8 }}>
              {targets.map((c) => (
                <Pressable key={c.id} testID={`move-to-${c.id}`} onPress={() => move(c.id)} disabled={!!busy} style={styles.row}>
                  <Ionicons name="folder-outline" size={18} color={colors.primary} />
                  <Text style={styles.name} numberOfLines={1}>{c.name}</Text>
                  {busy === c.id ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.count}>{c.document_count}</Text>}
                </Pressable>
              ))}
            </ScrollView>
          )}
          {error && <Text style={styles.err}>{error}</Text>}
          <View style={styles.actions}>
            <Button testID="move-cancel" label="Avbryt" onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.4)" },
  card: { width: "100%", maxWidth: 420, gap: 12, padding: 20, borderRadius: radius.lg, backgroundColor: colors.surface },
  h: { fontSize: 18, fontWeight: "700", color: colors.text },
  sub: { fontSize: 14, color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  name: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.text },
  count: { fontSize: 13, color: colors.muted },
  err: { color: colors.danger },
  actions: { flexDirection: "row", justifyContent: "flex-end" },
});
