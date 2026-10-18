import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api, type Template, type User } from "@/src/api";
import { useAuth } from "@/src/auth";
import { Button } from "@/src/components/ui";
import { colors, radius } from "@/src/theme";

type Settings = {
  speed_mode: "fast" | "balanced" | "best";
  primary_provider: string;
  providers: { id: string; label: string; has_key: boolean; models: Record<string, string> }[];
  is_owner: boolean;
};

const MODES = [
  { id: "fast", label: "Snabb", hint: "En AI läser sidan. Billigast." },
  { id: "balanced", label: "Balanserad", hint: "Bättre modell + kontroll av en andra AI." },
  { id: "best", label: "Bäst", hint: "Bästa modellen + consensus mellan alla AI:er." },
] as const;

export default function SettingsScreen() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [s, setS] = useState<Settings | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [invite, setInvite] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const st = await api<Settings>("/settings");
      setS(st);
      setTemplates(await api<Template[]>("/templates"));
      if (st.is_owner) setUsers(await api<User[]>("/admin/users"));
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const update = async (body: Partial<Settings>) => {
    try {
      setS(await api<Settings>("/settings", { method: "PUT", body }));
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const doInvite = async () => {
    try {
      await api("/admin/users", { body: { email: invite } });
      setInvite("");
      setUsers(await api<User[]>("/admin/users"));
    } catch (e: any) {
      setErr(e.message);
    }
  };

  if (!s) return <SafeAreaView style={styles.safe}>{err ? <Text style={styles.err}>{err}</Text> : <ActivityIndicator style={{ marginTop: 48 }} color={colors.primary} />}</SafeAreaView>;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.top}>
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace("/archive"))} style={styles.icon} accessibilityLabel="Tillbaka" testID="settings-back">
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.h1}>Inställningar</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {err && <Text style={styles.err}>{err}</Text>}
        <View style={styles.card}>
          <Text style={styles.h2}>Läsläge</Text>
          {!s.is_owner && <Text style={styles.muted}>Endast ägaren kan ändra läsläget.</Text>}
          {MODES.map((m) => (
            <Pressable key={m.id} testID={`mode-${m.id}`} disabled={!s.is_owner} onPress={() => update({ speed_mode: m.id })} style={[styles.option, s.speed_mode === m.id && styles.optionActive]}>
              <Ionicons name={s.speed_mode === m.id ? "radio-button-on" : "radio-button-off"} size={20} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.optLabel}>{m.label}</Text>
                <Text style={styles.muted}>{m.hint}</Text>
              </View>
            </Pressable>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>AI-tjänster</Text>
          <Text style={styles.muted}>Nycklarna finns bara på servern och visas aldrig här. Gemini rekommenderas som huvud-AI, eftersom den är bäst på att hitta bilder.</Text>
          {s.providers.map((p) => (
            <Pressable key={p.id} testID={`provider-${p.id}`} disabled={!s.is_owner} onPress={() => update({ primary_provider: p.id })} style={[styles.option, s.primary_provider === p.id && styles.optionActive]}>
              <Ionicons name={s.primary_provider === p.id ? "radio-button-on" : "radio-button-off"} size={20} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.optLabel}>{p.label}{s.primary_provider === p.id ? " · huvud-AI" : ""}</Text>
                <Text style={styles.muted}>{p.models[s.speed_mode]}</Text>
              </View>
              <Text style={[styles.pill, p.has_key ? styles.pillOk : styles.pillMissing]}>{p.has_key ? "Nyckel finns" : "Nyckel saknas"}</Text>
            </Pressable>
          ))}
        </View>

        {s.is_owner && (
          <View style={styles.card}>
            <Text style={styles.h2}>Användare</Text>
            <Text style={styles.muted}>Bara inbjudna e-postadresser kan logga in.</Text>
            {users.map((u) => (
              <View key={u.id} style={styles.userRow}>
                <Ionicons name="person-circle-outline" size={22} color={colors.muted} />
                <Text style={styles.userEmail} numberOfLines={1}>{u.email}</Text>
                <Text style={styles.muted}>{u.role === "owner" ? "Ägare" : "Medlem"}</Text>
                {u.role !== "owner" && (
                  <Pressable style={styles.icon} accessibilityLabel="Ta bort användare" onPress={async () => { await api(`/admin/users/${u.id}`, { method: "DELETE" }); setUsers(await api<User[]>("/admin/users")); }}>
                    <Ionicons name="close" size={18} color={colors.danger} />
                  </Pressable>
                )}
              </View>
            ))}
            <View style={styles.row}>
              <TextInput testID="invite-email" style={styles.input} value={invite} onChangeText={setInvite} placeholder="E-post att bjuda in" placeholderTextColor={colors.faint} autoCapitalize="none" keyboardType="email-address" />
              <Button testID="invite-btn" small variant="primary" label="Bjud in" onPress={doInvite} disabled={!invite.includes("@")} />
            </View>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.h2}>Sparade mallar</Text>
          {templates.map((t) => (
            <View key={t.id} style={styles.userRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.optLabel}>{t.name}</Text>
                <Text style={styles.muted} numberOfLines={2}>{t.instruction}</Text>
              </View>
              <Pressable style={styles.icon} accessibilityLabel="Ta bort mall" onPress={async () => { await api(`/templates/${t.id}`, { method: "DELETE" }); setTemplates((x) => x.filter((y) => y.id !== t.id)); }}>
                <Ionicons name="trash-outline" size={18} color={colors.danger} />
              </Pressable>
            </View>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>Konto</Text>
          <Text style={styles.muted}>Inloggad som {user?.email}</Text>
          <Button testID="logout" label="Logga ut" variant="danger" icon="log-out-outline" onPress={signOut} style={{ alignSelf: "flex-start" }} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  top: { flexDirection: "row", alignItems: "center", padding: 8 },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  h1: { fontSize: 24, fontWeight: "800", color: colors.text },
  content: { padding: 16, gap: 16, maxWidth: 720, width: "100%", alignSelf: "center", paddingBottom: 64 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 16, gap: 10 },
  h2: { fontSize: 17, fontWeight: "700", color: colors.text },
  muted: { fontSize: 13, color: colors.muted, lineHeight: 18 },
  option: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, minHeight: 56 },
  optionActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  optLabel: { fontSize: 15, fontWeight: "600", color: colors.text },
  pill: { fontSize: 12, fontWeight: "700", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: "hidden" },
  pillOk: { backgroundColor: colors.okSoft, color: colors.ok },
  pillMissing: { backgroundColor: colors.warnSoft, color: colors.warn },
  userRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  userEmail: { flex: 1, fontSize: 15, color: colors.text },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: { flex: 1, minHeight: 40, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 15, color: colors.text },
  err: { padding: 12, color: colors.danger, backgroundColor: colors.dangerSoft, borderRadius: radius.md },
});
