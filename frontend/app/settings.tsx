import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Linking,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  PROVIDERS,
  ProviderId,
  getActiveProvider,
  setActiveProvider,
  getApiKey,
  setApiKey,
  getVerifier,
  setVerifier,
  maskKey,
} from "@/src/lib/aiSettings";
import { testConnection } from "@/src/lib/ai";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyError } = require("@/src/lib/errorMessages");

type Row = {
  id: ProviderId;
  value: string;
  visible: boolean;
  saving: boolean;
  testing: boolean;
  verify: boolean;
  status?: string;
  error?: string;
};

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [active, setActive] = useState<ProviderId>("openai");
  const [rows, setRows] = useState<Row[]>(
    PROVIDERS.map((p) => ({
      id: p.id,
      value: "",
      visible: false,
      saving: false,
      testing: false,
      verify: false,
    }))
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const cur = await getActiveProvider();
      setActive(cur);
      const next: Row[] = [];
      for (const p of PROVIDERS) {
        const [v, ver] = await Promise.all([getApiKey(p.id), getVerifier(p.id)]);
        next.push({
          id: p.id,
          value: v || "",
          visible: false,
          saving: false,
          testing: false,
          verify: ver,
        });
      }
      setRows(next);
      setLoaded(true);
    })();
  }, []);

  const updateRow = (id: ProviderId, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const handleSave = useCallback(async (id: ProviderId, value: string) => {
    updateRow(id, { saving: true, status: undefined, error: undefined });
    try {
      await setApiKey(id, value);
      updateRow(id, { saving: false, status: value ? "Saved" : "Cleared" });
      setTimeout(() => updateRow(id, { status: undefined }), 1500);
    } catch (e: any) {
      updateRow(id, { saving: false, error: e?.message ?? "Could not save" });
    }
  }, []);

  const handleTest = useCallback(async (id: ProviderId, value: string) => {
    if (!value.trim()) {
      Alert.alert("No key", "Paste your API key first.");
      return;
    }
    updateRow(id, { testing: true, status: undefined, error: undefined });
    try {
      // Save before testing so callProvider picks the same key
      await setApiKey(id, value.trim());
      // Force active to this one for test, then restore
      const prevActive = await getActiveProvider();
      await setActiveProvider(id);
      try {
        const msg = await testConnection(id, value.trim());
        updateRow(id, { testing: false, status: msg });
        setTimeout(() => updateRow(id, { status: undefined }), 2200);
      } finally {
        await setActiveProvider(prevActive);
      }
    } catch (e: any) {
      const c = classifyError(e?.message ?? "Test failed");
      updateRow(id, { testing: false, error: c.title });
    }
  }, []);

  const handleSelectActive = useCallback(async (id: ProviderId) => {
    const row = rows.find((r) => r.id === id);
    if (!row?.value) {
      Alert.alert(
        "Add a key first",
        `Paste your ${PROVIDERS.find((p) => p.id === id)?.label} key before selecting this provider.`
      );
      return;
    }
    setActive(id);
    await setActiveProvider(id);
  }, [rows]);

  const handleToggleVerify = useCallback(async (id: ProviderId, on: boolean) => {
    updateRow(id, { verify: on });
    await setVerifier(id, on);
  }, []);

  if (!loaded) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color="#09090B" />
      </View>
    );
  }

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
          <Text style={styles.headerTitle}>AI Settings</Text>
          <Text style={styles.headerSub}>
            Keys stay on this device (Keychain / Keystore)
          </Text>
        </View>
        <View style={{ width: 38 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 80 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={18} color="#3F3F46" />
          <Text style={styles.infoText}>
            Paste an API key for one or more providers below, then tap a card to
            choose which one CopyThat should use for OCR. You only need one to use the app.
          </Text>
        </View>

        {PROVIDERS.map((p) => {
          const row = rows.find((r) => r.id === p.id)!;
          const isActive = active === p.id;
          const hasKey = !!row.value;
          return (
            <View
              key={p.id}
              style={[styles.card, isActive && styles.cardActive]}
              testID={`provider-card-${p.id}`}
            >
              <TouchableOpacity
                style={styles.cardHead}
                onPress={() => handleSelectActive(p.id)}
                activeOpacity={0.7}
                testID={`select-${p.id}-btn`}
              >
                <View style={{ flex: 1 }}>
                  <View style={styles.cardTitleRow}>
                    <Text style={styles.cardTitle}>{p.label}</Text>
                    {isActive && (
                      <View style={styles.activePill}>
                        <Ionicons name="checkmark" size={12} color="#fff" />
                        <Text style={styles.activePillText}>ACTIVE</Text>
                      </View>
                    )}
                    {!isActive && hasKey && (
                      <View style={styles.readyPill}>
                        <Text style={styles.readyPillText}>READY</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.cardModel}>Model: {p.model}</Text>
                  <Text style={styles.cardHint}>{p.hint}</Text>
                </View>
                <View
                  style={[
                    styles.radioOuter,
                    isActive && styles.radioOuterOn,
                  ]}
                >
                  {isActive && <View style={styles.radioInner} />}
                </View>
              </TouchableOpacity>

              <View style={styles.keyRow}>
                <TextInput
                  value={row.value}
                  onChangeText={(v) => updateRow(p.id, { value: v, error: undefined })}
                  placeholder={`Paste ${p.label} API key (${p.keyPrefix}…)`}
                  placeholderTextColor="#9CA3AF"
                  style={styles.input}
                  secureTextEntry={!row.visible}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  testID={`key-input-${p.id}`}
                />
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => updateRow(p.id, { visible: !row.visible })}
                  testID={`toggle-visibility-${p.id}`}
                >
                  <Ionicons
                    name={row.visible ? "eye-off-outline" : "eye-outline"}
                    size={20}
                    color="#52525B"
                  />
                </TouchableOpacity>
              </View>

              {hasKey && !row.visible && (
                <Text style={styles.maskedHint}>
                  Stored: {maskKey(row.value)}
                </Text>
              )}

              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.testBtn, row.testing && { opacity: 0.6 }]}
                  onPress={() => handleTest(p.id, row.value)}
                  disabled={row.testing || row.saving}
                  testID={`test-${p.id}-btn`}
                >
                  {row.testing ? (
                    <ActivityIndicator size="small" color="#09090B" />
                  ) : (
                    <>
                      <Ionicons name="flash-outline" size={16} color="#09090B" />
                      <Text style={styles.actionBtnText}>Test</Text>
                    </>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.actionBtn, styles.saveBtn, row.saving && { opacity: 0.6 }]}
                  onPress={() => handleSave(p.id, row.value)}
                  disabled={row.testing || row.saving}
                  testID={`save-${p.id}-btn`}
                >
                  {row.saving ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="save-outline" size={16} color="#fff" />
                      <Text style={styles.saveBtnText}>
                        {row.value ? "Save" : "Clear"}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>

              {row.status && (
                <View style={styles.statusOk} testID={`status-${p.id}`}>
                  <Ionicons name="checkmark-circle" size={16} color="#16A34A" />
                  <Text style={styles.statusOkText}>{row.status}</Text>
                </View>
              )}
              {row.error && (
                <View style={styles.statusErr} testID={`error-${p.id}`}>
                  <Ionicons name="alert-circle" size={16} color="#DC2626" />
                  <Text style={styles.statusErrText}>{row.error}</Text>
                </View>
              )}

              <TouchableOpacity
                onPress={() => Linking.openURL(p.consoleUrl)}
                style={styles.linkBtn}
                testID={`get-key-link-${p.id}`}
              >
                <Ionicons name="open-outline" size={14} color="#3B82F6" />
                <Text style={styles.linkText}>Get key from {p.label}</Text>
              </TouchableOpacity>

              {/* Verifier toggle — disabled if no key or if this is the active provider */}
              <TouchableOpacity
                style={[
                  styles.verifyRow,
                  (!hasKey || isActive) && { opacity: 0.45 },
                ]}
                onPress={() => {
                  if (!hasKey || isActive) return;
                  handleToggleVerify(p.id, !row.verify);
                }}
                activeOpacity={0.7}
                testID={`verify-toggle-${p.id}`}
                disabled={!hasKey || isActive}
              >
                <View
                  style={[
                    styles.checkBox,
                    row.verify && hasKey && !isActive && styles.checkBoxOn,
                  ]}
                >
                  {row.verify && hasKey && !isActive && (
                    <Ionicons name="checkmark" size={14} color="#fff" />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.verifyLabel}>Use for verification</Text>
                  <Text style={styles.verifySub}>
                    {isActive
                      ? "This is the primary – can't verify itself."
                      : !hasKey
                      ? "Add a key above to enable."
                      : "Runs in parallel and cross-checks the primary's reading."}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          );
        })}

        <View style={styles.footerNote}>
          <Ionicons name="lock-closed-outline" size={14} color="#71717A" />
          <Text style={styles.footerNoteText}>
            Keys are stored in the iOS Keychain / Android Keystore on your
            device and never leave it except to call the chosen provider.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
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

  infoBox: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: "#F4F4F5",
    borderRadius: 14,
    padding: 12,
  },
  infoText: { flex: 1, color: "#3F3F46", fontSize: 13, lineHeight: 18 },

  card: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 16,
    borderWidth: 2,
    borderColor: "#E4E4E7",
    gap: 12,
  },
  cardActive: { borderColor: "#09090B", backgroundColor: "#FFF" },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 18, fontWeight: "900", color: "#09090B" },
  cardModel: { color: "#52525B", fontSize: 12, marginTop: 2, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
  cardHint: { color: "#71717A", fontSize: 13, marginTop: 4, lineHeight: 18 },

  activePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#09090B",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  activePillText: { color: "#fff", fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  readyPill: {
    backgroundColor: "#D1FAE5",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  readyPillText: { color: "#065F46", fontSize: 10, fontWeight: "900", letterSpacing: 1 },

  radioOuter: {
    width: 24,
    height: 24,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: "#A1A1AA",
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuterOn: { borderColor: "#09090B" },
  radioInner: { width: 12, height: 12, borderRadius: 12, backgroundColor: "#09090B" },

  keyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#E4E4E7",
    borderRadius: 12,
    paddingHorizontal: 10,
    backgroundColor: "#FAFAFA",
  },
  input: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 14,
    color: "#09090B",
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
  eyeBtn: { padding: 6 },
  maskedHint: { color: "#71717A", fontSize: 11, marginTop: -4 },

  actionRow: { flexDirection: "row", gap: 8 },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
  },
  testBtn: { backgroundColor: "#F4F4F5", borderWidth: 1, borderColor: "#E4E4E7" },
  actionBtnText: { color: "#09090B", fontWeight: "700" },
  saveBtn: { backgroundColor: "#09090B" },
  saveBtnText: { color: "#fff", fontWeight: "800" },

  statusOk: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    backgroundColor: "#D1FAE5",
    borderColor: "#A7F3D0",
    borderWidth: 1,
    borderRadius: 10,
    padding: 8,
  },
  statusOkText: { color: "#065F46", fontWeight: "700", fontSize: 12 },
  statusErr: {
    flexDirection: "row",
    gap: 6,
    alignItems: "flex-start",
    backgroundColor: "#FEE2E2",
    borderColor: "#FCA5A5",
    borderWidth: 1,
    borderRadius: 10,
    padding: 8,
  },
  statusErrText: { color: "#991B1B", fontSize: 12, flex: 1 },

  linkBtn: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" },
  linkText: { color: "#3B82F6", fontSize: 12, fontWeight: "700" },

  verifyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "#F4F4F5",
    borderRadius: 12,
    marginTop: 4,
  },
  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#A1A1AA",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  checkBoxOn: { backgroundColor: "#09090B", borderColor: "#09090B" },
  verifyLabel: { fontWeight: "800", color: "#09090B", fontSize: 14 },
  verifySub: { color: "#71717A", fontSize: 12, marginTop: 2, lineHeight: 16 },

  footerNote: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    padding: 12,
  },
  footerNoteText: { flex: 1, color: "#71717A", fontSize: 12, lineHeight: 17 },
});
