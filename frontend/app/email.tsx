import React, { useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
  KeyboardAvoidingView,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useScans } from "@/src/store/scans";

const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL!;

type Recipient = { id: string; name: string; email: string };
const RECIPIENTS: Recipient[] = [
  { id: "emil", name: "Emil", email: "Emil@jawel.se" },
  { id: "louise", name: "Louise", email: "Louise@jawel.se" },
  { id: "anton", name: "Anton", email: "Anton@jawel.se" },
  { id: "william", name: "William", email: "William@jawel.se" },
];

function initials(name: string) {
  return name.slice(0, 1).toUpperCase();
}

function confColor(c: number) {
  if (c >= 90) return "#16A34A";
  if (c >= 70) return "#D97706";
  return "#DC2626";
}

export default function EmailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { scans, clearAll } = useScans();
  const today = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  }, []);
  const [subject, setSubject] = useState(`Skannat dokument ${today}`);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState(false);
  const [sentOk, setSentOk] = useState(false);

  const body = useMemo(() => {
    if (!scans.length) return "";
    return scans
      .map((s, i) => {
        const conf = Math.round(s.confidence);
        const heading = `## Sida ${i + 1}  ·  ${conf}% tillförlitlighet`;
        return `${heading}\n\n${s.structuredText.trim()}`;
      })
      .join("\n\n---\n\n");
  }, [scans]);

  const selectedEmails = useMemo(
    () => RECIPIENTS.filter((r) => selected[r.id]).map((r) => r.email),
    [selected]
  );

  const handleSend = useCallback(async () => {
    if (!selectedEmails.length) {
      Alert.alert("Välj mottagare", "Markera minst en mottagare.");
      return;
    }
    if (!scans.length) {
      Alert.alert("Inga sidor", "Du har inga skannade sidor.");
      return;
    }
    setSending(true);
    try {
      const res = await fetch(`${BACKEND}/api/email/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: selectedEmails,
          subject,
          body_markdown: body,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Mail fel (${res.status}): ${t.slice(0, 300)}`);
      }
      setSentOk(true);
      setTimeout(() => {
        setSentOk(false);
        clearAll();
        router.replace("/");
      }, 1500);
    } catch (e: any) {
      Alert.alert("Skickning misslyckades", e?.message ?? "Okänt fel");
    } finally {
      setSending(false);
    }
  }, [selectedEmails, subject, body, scans.length, clearAll, router]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: "#FAFAFA" }}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => router.back()}
          testID="back-btn"
        >
          <Ionicons name="chevron-back" size={22} color="#09090B" />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={styles.headerTitle}>Skicka via mail</Text>
          <Text style={styles.headerSub}>{scans.length} sidor klara</Text>
        </View>
        <View style={{ width: 38 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 180, gap: 18 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Subject */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>ÄMNE</Text>
          <TextInput
            value={subject}
            onChangeText={setSubject}
            style={styles.subjectInput}
            placeholder="Skriv ett ämne…"
            placeholderTextColor="#9CA3AF"
            testID="email-subject-input"
          />
        </View>

        {/* Recipients grid */}
        <View>
          <Text style={[styles.cardLabel, { marginLeft: 4, marginBottom: 8 }]}>
            MOTTAGARE
          </Text>
          <View style={styles.grid}>
            {RECIPIENTS.map((r) => {
              const isOn = !!selected[r.id];
              return (
                <TouchableOpacity
                  key={r.id}
                  style={[styles.recipient, isOn && styles.recipientOn]}
                  onPress={() =>
                    setSelected((prev) => ({ ...prev, [r.id]: !prev[r.id] }))
                  }
                  testID={`recipient-${r.id}-btn`}
                  activeOpacity={0.85}
                >
                  <View style={[styles.avatar, isOn && styles.avatarOn]}>
                    <Text style={[styles.avatarText, isOn && { color: "#fff" }]}>
                      {initials(r.name)}
                    </Text>
                  </View>
                  <Text style={styles.recipientName}>{r.name}</Text>
                  <Text style={styles.recipientEmail}>{r.email}</Text>
                  {isOn && (
                    <View style={styles.check}>
                      <Ionicons name="checkmark" size={14} color="#fff" />
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Pages summary */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>INNEHÅLL · {scans.length} SIDOR</Text>
          <View style={{ gap: 12 }}>
            {scans.map((s, i) => (
              <View key={s.id} style={styles.pageRow}>
                <Image source={{ uri: s.imageUri }} style={styles.pageThumb} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.pageTitle}>Sida {i + 1}</Text>
                  <Text style={styles.pageSnippet} numberOfLines={2}>
                    {s.plainText || s.structuredText.replace(/\*\*/g, "")}
                  </Text>
                </View>
                <View
                  style={[
                    styles.confChip,
                    { borderColor: confColor(s.confidence), backgroundColor: confColor(s.confidence) + "18" },
                  ]}
                >
                  <Text style={[styles.confChipText, { color: confColor(s.confidence) }]}>
                    {Math.round(s.confidence)}%
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>

      {/* Send footer */}
      <View
        style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.footerLabel}>
            {selectedEmails.length
              ? `Till ${selectedEmails.length} mottagare`
              : "Välj minst en mottagare"}
          </Text>
          <Text style={styles.footerSub}>via commhub.cloud</Text>
        </View>
        <TouchableOpacity
          style={[
            styles.sendBtn,
            (!selectedEmails.length || sending) && { opacity: 0.5 },
          ]}
          onPress={handleSend}
          disabled={!selectedEmails.length || sending}
          testID="send-email-btn"
        >
          {sending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="send" size={18} color="#fff" />
              <Text style={styles.sendBtnText}>Skicka</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {sentOk && (
        <View style={styles.toast} pointerEvents="none">
          <View style={styles.toastInner}>
            <Ionicons name="checkmark-circle" size={22} color="#16A34A" />
            <Text style={styles.toastText}>Mail skickat!</Text>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#E4E4E7",
    backgroundColor: "#FFFFFF",
    gap: 8,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F4F4F5",
  },
  headerTitle: { fontWeight: "800", fontSize: 16, color: "#09090B", letterSpacing: 0.3 },
  headerSub: { color: "#71717A", fontSize: 11, marginTop: 1 },

  card: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E4E4E7",
    gap: 10,
  },
  cardLabel: { fontSize: 11, fontWeight: "900", color: "#71717A", letterSpacing: 1.4 },
  subjectInput: {
    fontSize: 18,
    fontWeight: "800",
    color: "#09090B",
    paddingVertical: 6,
  },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  recipient: {
    width: "47%",
    backgroundColor: "#fff",
    borderRadius: 20,
    borderWidth: 2,
    borderColor: "#E4E4E7",
    paddingVertical: 16,
    paddingHorizontal: 14,
    alignItems: "center",
    gap: 6,
    flexGrow: 1,
  },
  recipientOn: { borderColor: "#09090B", backgroundColor: "#FAFAFA" },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 48,
    backgroundColor: "#F4F4F5",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  avatarOn: { backgroundColor: "#09090B" },
  avatarText: { fontWeight: "900", color: "#09090B", fontSize: 20 },
  recipientName: { fontWeight: "800", color: "#09090B" },
  recipientEmail: { color: "#71717A", fontSize: 11 },
  check: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 22,
    height: 22,
    borderRadius: 22,
    backgroundColor: "#09090B",
    alignItems: "center",
    justifyContent: "center",
  },

  pageRow: { flexDirection: "row", gap: 12, alignItems: "center" },
  pageThumb: { width: 44, height: 56, borderRadius: 8, backgroundColor: "#E4E4E7" },
  pageTitle: { fontWeight: "800", color: "#09090B" },
  pageSnippet: { color: "#71717A", fontSize: 12, marginTop: 2 },
  confChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  confChipText: { fontWeight: "800", fontSize: 12 },

  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: "rgba(255,255,255,0.96)",
    borderTopWidth: 1,
    borderTopColor: "#E4E4E7",
  },
  footerLabel: { fontWeight: "800", color: "#09090B" },
  footerSub: { color: "#71717A", fontSize: 11 },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#09090B",
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 14,
  },
  sendBtnText: { color: "#fff", fontWeight: "800" },

  toast: {
    position: "absolute",
    top: 90,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  toastInner: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    backgroundColor: "#fff",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#E4E4E7",
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  toastText: { fontWeight: "800", color: "#09090B" },
});
