import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { api, type User } from "@/src/api";
import { useAuth } from "@/src/auth";
import { Button } from "@/src/components/ui";
import { colors, radius } from "@/src/theme";

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/auth/request-code", { body: { email } });
      setStep("code");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; user: User }>("/auth/verify", { body: { email, code } });
      await signIn(r.token, r.user);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.center} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <View style={styles.logo}>
              <Ionicons name="document-text" size={28} color={colors.primaryText} />
            </View>
            <Text style={styles.title}>CopyThat</Text>
            <Text style={styles.sub}>AI-läsning av kurs- och studiematerial</Text>

            {step === "email" ? (
              <>
                <Text style={styles.label}>E-postadress</Text>
                <TextInput
                  testID="login-email"
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  placeholder="namn@exempel.se"
                  placeholderTextColor={colors.faint}
                  onSubmitEditing={sendCode}
                  returnKeyType="send"
                />
                <Button testID="login-send-code" label="Skicka kod" variant="primary" onPress={sendCode} loading={busy} disabled={!email.includes("@")} />
              </>
            ) : (
              <>
                <Text style={styles.info}>Vi har skickat en sexsiffrig kod till {email}. Koden gäller i 10 minuter.</Text>
                <Text style={styles.label}>Kod</Text>
                <TextInput
                  testID="login-code"
                  style={[styles.input, styles.codeInput]}
                  value={code}
                  onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  placeholderTextColor={colors.faint}
                  onSubmitEditing={verify}
                />
                <Button testID="login-verify" label="Logga in" variant="primary" onPress={verify} loading={busy} disabled={code.length !== 6} />
                <Button label="Byt e-post eller skicka ny kod" variant="ghost" onPress={() => { setStep("email"); setCode(""); }} />
              </>
            )}
            {error && (
              <Text style={styles.error} testID="login-error">
                {error}
              </Text>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  card: { width: "100%", maxWidth: 420, backgroundColor: colors.surface, borderRadius: radius.lg, padding: 32, gap: 12, borderWidth: 1, borderColor: colors.border },
  logo: { width: 52, height: 52, borderRadius: 14, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", alignSelf: "center" },
  title: { fontSize: 28, fontWeight: "800", color: colors.text, textAlign: "center" },
  sub: { fontSize: 15, color: colors.muted, textAlign: "center", marginBottom: 12 },
  label: { fontSize: 13, fontWeight: "600", color: colors.muted },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: colors.text, backgroundColor: colors.surface },
  codeInput: { fontSize: 24, letterSpacing: 8, textAlign: "center" },
  info: { fontSize: 14, color: colors.text, lineHeight: 20 },
  error: { color: colors.danger, backgroundColor: colors.dangerSoft, padding: 12, borderRadius: radius.md, fontSize: 14 },
});
