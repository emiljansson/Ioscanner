import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius } from "@/src/theme";

type Props = {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: ViewStyle;
  testID?: string;
};

export function Button({ label, onPress, icon, variant = "secondary", loading, disabled, small, style, testID }: Props) {
  const v = VARIANTS[variant];
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        small && styles.small,
        { backgroundColor: v.bg, borderColor: v.border },
        (pressed || disabled) && { opacity: disabled ? 0.45 : 0.8 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={v.fg} />
      ) : (
        <View style={styles.row}>
          {icon && <Ionicons name={icon} size={small ? 15 : 17} color={v.fg} />}
          <Text style={[styles.label, small && styles.smallLabel, { color: v.fg }]} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const VARIANTS = {
  primary: { bg: colors.primary, fg: colors.primaryText, border: colors.primary },
  secondary: { bg: colors.surface, fg: colors.text, border: colors.border },
  ghost: { bg: "transparent", fg: colors.primary, border: "transparent" },
  danger: { bg: colors.surface, fg: colors.danger, border: colors.border },
};

const styles = StyleSheet.create({
  btn: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  small: { minHeight: 36, paddingHorizontal: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { fontSize: 15, fontWeight: "600" },
  smallLabel: { fontSize: 13 },
});

export function ConfidenceBadge({ value }: { value: number | null }) {
  if (value == null) return null;
  const tone = value >= 85 ? "ok" : value >= 65 ? "warn" : "danger";
  const map = {
    ok: [colors.okSoft, colors.ok, "Hög säkerhet"],
    warn: [colors.warnSoft, colors.warn, "Kontrollera"],
    danger: [colors.dangerSoft, colors.danger, "Låg säkerhet"],
  } as const;
  const [bg, fg, label] = map[tone];
  return (
    <View style={[badge.wrap, { backgroundColor: bg }]} testID="confidence-badge">
      <Text style={[badge.text, { color: fg }]}>
        {Math.round(value)}% · {label}
      </Text>
    </View>
  );
}

const badge = StyleSheet.create({
  wrap: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, alignSelf: "flex-start" },
  text: { fontSize: 12, fontWeight: "700" },
});
