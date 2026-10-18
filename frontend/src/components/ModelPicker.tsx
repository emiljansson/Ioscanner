// Bottom-sheet list of the models a provider offers right now; the owner pins one per reading mode.
import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { colors, radius } from "@/src/theme";

type Props = {
  provider: { id: string; label: string };
  modeLabel: string;
  current: string;
  defaultModel: string;
  onPick: (model: string | null) => void;
  onClose: () => void;
};

export function ModelPicker({ provider, modeLabel, current, defaultModel, onPick, onClose }: Props) {
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ models: string[] }>(`/settings/models/${provider.id}`)
      .then((r) => setModels(r.models))
      .catch((e) => setError(e.message));
  }, [provider.id]);

  const rows = [defaultModel, ...(models ?? []).filter((m) => m !== defaultModel)];
  // Keep a pinned model visible even if the provider no longer lists it.
  if (models && !rows.includes(current)) rows.splice(1, 0, current);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.wrap}>
        <View style={styles.head}>
          <View style={{ flex: 1 }}>
            <Text style={styles.h}>{provider.label}-modell</Text>
            <Text style={styles.sub}>Används i läget {modeLabel}</Text>
          </View>
          <Pressable onPress={onClose} style={styles.close} accessibilityLabel="Stäng" testID="model-picker-close">
            <Ionicons name="close" size={24} color={colors.text} />
          </Pressable>
        </View>
        {error ? (
          <Text style={styles.err}>{error}</Text>
        ) : !models ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 32 }} />
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(m) => m}
            contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 48 }}
            renderItem={({ item }) => {
              const on = item === current;
              return (
                <Pressable testID={`model-${item}`} onPress={() => onPick(item === defaultModel ? null : item)} style={[styles.row, on && styles.rowOn]}>
                  <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={colors.primary} />
                  <Text style={styles.name} numberOfLines={1}>{item}</Text>
                  {item === defaultModel && <Text style={styles.tag}>Standard</Text>}
                </Pressable>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  head: { flexDirection: "row", alignItems: "center", padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
  h: { fontSize: 18, fontWeight: "700", color: colors.text },
  sub: { fontSize: 14, color: colors.muted, marginTop: 2 },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  rowOn: { borderColor: colors.primary },
  name: { flex: 1, fontSize: 15, color: colors.text },
  tag: { fontSize: 12, fontWeight: "600", color: colors.muted },
  err: { color: colors.danger, padding: 24, textAlign: "center" },
});
