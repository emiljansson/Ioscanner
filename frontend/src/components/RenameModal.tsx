// Small centered dialog for renaming a course or a document (works on iOS, Android and web).
import React, { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "@/src/components/ui";
import { colors, radius } from "@/src/theme";

type Props = { title: string; initial: string; maxLength?: number; onSave: (name: string) => Promise<void>; onClose: () => void };

export function RenameModal({ title, initial, maxLength = 200, onSave, onClose }: Props) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length > 0 && name.trim() !== initial;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onSave(name.trim());
      onClose();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Stäng" />
        <View style={styles.card} testID="rename-modal">
          <Text style={styles.h}>{title}</Text>
          <TextInput
            testID="rename-input"
            style={styles.input}
            value={name}
            onChangeText={setName}
            onSubmitEditing={save}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            maxLength={maxLength}
          />
          {error && <Text style={styles.err}>{error}</Text>}
          <View style={styles.row}>
            <Button testID="rename-cancel" label="Avbryt" onPress={onClose} />
            <Button testID="rename-save" variant="primary" label="Spara" loading={busy} disabled={!valid} onPress={save} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.4)" },
  card: { width: "100%", maxWidth: 420, gap: 12, padding: 20, borderRadius: radius.lg, backgroundColor: colors.surface },
  h: { fontSize: 18, fontWeight: "700", color: colors.text },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 16, color: colors.text, backgroundColor: colors.bg },
  err: { color: colors.danger },
  row: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});
