import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api, API_URL, getToken, type Course, type Template, type User } from "@/src/api";
import { useAuth } from "@/src/auth";
import { ModelPicker } from "@/src/components/ModelPicker";
import { Button } from "@/src/components/ui";
import { colors, radius } from "@/src/theme";

type Settings = {
  speed_mode: "fast" | "balanced" | "best";
  primary_provider: string;
  providers: { id: string; label: string; has_key: boolean; models: Record<string, string>; default_models: Record<string, string> }[];
  is_owner: boolean;
};

type Scanner = { key: string; course_id: string | null; course_name: string };

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
  const [scanner, setScanner] = useState<Scanner | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [copied, setCopied] = useState(false);
  const [picking, setPicking] = useState<Settings["providers"][number] | null>(null);

  const load = useCallback(async () => {
    try {
      const st = await api<Settings>("/settings");
      setS(st);
      setTemplates(await api<Template[]>("/templates"));
      setScanner(await api<Scanner>("/scanner"));
      setCourses(await api<Course[]>("/courses"));
      if (st.is_owner) setUsers(await api<User[]>("/admin/users"));
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const update = async (body: Partial<Settings> | { model_override: { provider: string; mode: string; model: string | null } }) => {
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

  const setScanFolder = async (course_id: string) => {
    try {
      setScanner(await api<Scanner>("/scanner", { method: "PUT", body: { course_id } }));
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const scriptBase = () => (API_URL.startsWith("http") ? API_URL.replace(/\/api$/, "") : window.location.origin);
  const [mailingScript, setMailingScript] = useState(false);
  const [scriptMsg, setScriptMsg] = useState<string | null>(null);
  const emailScript = async () => {
    setMailingScript(true);
    setScriptMsg(null);
    try {
      const r = await api<{ email: string }>(`/scanner/script/email?base=${encodeURIComponent(scriptBase())}`, { method: "POST" });
      setScriptMsg(`Skriptet är skickat till ${r.email}. Öppna mejlet på Windows-datorn.`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setMailingScript(false);
    }
  };

  const downloadScript = async () => {
    try {
      const base = scriptBase();
      const r = await fetch(`${API_URL}/scanner/script?base=${encodeURIComponent(base)}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!r.ok) throw new Error("Skriptet kunde inte laddas ner");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await r.blob());
      a.download = "copythat-skanna.cmd";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
          <Text style={styles.muted}>Nycklarna finns bara på servern och visas aldrig här. Gemini rekommenderas som huvud-AI, eftersom den är bäst på att hitta bilder. Tryck på modellnamnet för att välja version för läget {MODES.find((m) => m.id === s.speed_mode)?.label}.</Text>
          {s.providers.map((p) => (
            <Pressable key={p.id} testID={`provider-${p.id}`} disabled={!s.is_owner} onPress={() => update({ primary_provider: p.id })} style={[styles.option, s.primary_provider === p.id && styles.optionActive]}>
              <Ionicons name={s.primary_provider === p.id ? "radio-button-on" : "radio-button-off"} size={20} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.optLabel}>{p.label}{s.primary_provider === p.id ? " · huvud-AI" : ""}</Text>
                {s.is_owner && p.has_key ? (
                  <Pressable testID={`model-pick-${p.id}`} onPress={() => setPicking(p)} style={styles.modelBtn} accessibilityLabel={`Välj modell för ${p.label}`}>
                    <Text style={styles.modelText} numberOfLines={1}>{p.models[s.speed_mode]}</Text>
                    <Ionicons name="chevron-down" size={14} color={colors.primary} />
                  </Pressable>
                ) : (
                  <Text style={styles.muted}>{p.models[s.speed_mode]}</Text>
                )}
              </View>
              <Text style={[styles.pill, p.has_key ? styles.pillOk : styles.pillMissing]}>{p.has_key ? "Nyckel finns" : "Nyckel saknas"}</Text>
            </Pressable>
          ))}
        </View>

        {picking && (
          <ModelPicker
            provider={picking}
            modeLabel={MODES.find((m) => m.id === s.speed_mode)?.label ?? ""}
            current={picking.models[s.speed_mode]}
            defaultModel={picking.default_models[s.speed_mode]}
            onClose={() => setPicking(null)}
            onPick={async (model) => {
              setPicking(null);
              await update({ model_override: { provider: picking.id, mode: s.speed_mode, model } });
            }}
          />
        )}

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

        {scanner && (
          <View style={styles.card} testID="scanner-card">
            <Text style={styles.h2}>Skanner (NAPS2)</Text>
            <Text style={styles.muted}>Skanna på Windows-datorn med ett dubbelklick. Varje skanning blir ett nytt dokument i mappen du väljer här, och AI-läsningen startar direkt.</Text>
            <Text style={styles.optLabel}>Mapp för skanningar</Text>
            <View style={styles.chips}>
              {courses.map((c) => {
                const on = (scanner.course_id ?? courses.find((x) => x.name === "Inkorg")?.id) === c.id;
                return (
                  <Pressable key={c.id} testID={`scan-folder-${c.id}`} onPress={() => setScanFolder(c.id)} style={[styles.chip, on && styles.chipOn]}>
                    <Ionicons name={on ? "folder-open" : "folder-outline"} size={16} color={on ? colors.primaryText : colors.text} />
                    <Text style={[styles.chipText, on && { color: colors.primaryText }]}>{c.name}</Text>
                  </Pressable>
                );
              })}
            </View>
            {!scanner.course_id && <Text style={styles.muted}>Ingen mapp vald – skanningar hamnar i Inkorg.</Text>}
            <Text style={styles.optLabel}>Skannernyckel</Text>
            <View style={styles.row}>
              <Text testID="scan-key" style={styles.key} numberOfLines={1} selectable>{scanner.key}</Text>
              <Pressable style={styles.icon} accessibilityLabel="Kopiera nyckel" onPress={async () => { await Clipboard.setStringAsync(scanner.key); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                <Ionicons name={copied ? "checkmark" : "copy-outline"} size={18} color={colors.primary} />
              </Pressable>
              <Button testID="scan-new-key" small label="Ny nyckel" onPress={async () => setScanner(await api<Scanner>("/scanner/key", { method: "POST" }))} />
            </View>
            <Text style={styles.muted}>Nyckeln finns inbakad i skriptet. Byter du nyckel slutar gamla skript att fungera – ladda då ner skriptet igen.</Text>
            <View style={styles.chips}>
              {Platform.OS === "web" && (
                <Button testID="scan-script" variant="primary" icon="download-outline" label="Ladda ner skript för Windows" onPress={downloadScript} />
              )}
              <Button testID="scan-script-email" variant={Platform.OS === "web" ? "secondary" : "primary"} icon="mail-outline" label="Mejla skriptet till mig" loading={mailingScript} onPress={emailScript} />
            </View>
            {scriptMsg && <Text style={styles.ok}>{scriptMsg}</Text>}
            <Text style={styles.muted}>
              Så här gör du:{"\n"}1. Installera NAPS2 och ställ in din skanner i NAPS2-profilen.{"\n"}2. Ladda ner skriptet (eller mejla det till dig och öppna mejlet på datorn) och lägg det t.ex. på skrivbordet.{"\n"}3. Dubbelklicka på skriptet – det skannar och skickar till CopyThat. Du kan också dra PDF:er eller bilder till skriptet.
            </Text>
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
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, minHeight: 40, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 14, fontWeight: "600", color: colors.text },
  key: { flex: 1, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 13, color: colors.text, backgroundColor: colors.bg, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8 },
  modelBtn: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: 32, marginTop: 2 },
  modelText: { fontSize: 14, color: colors.primary, fontWeight: "600", textDecorationLine: "underline" },
  ok: { padding: 12, color: colors.ok, backgroundColor: colors.okSoft, borderRadius: radius.md },
  err: { padding: 12, color: colors.danger, backgroundColor: colors.dangerSoft, borderRadius: radius.md },
});
