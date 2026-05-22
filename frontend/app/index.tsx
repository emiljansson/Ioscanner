import React, { useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useScans, type Scan } from "@/src/store/scans";

const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL!;

function confColor(c: number) {
  if (c >= 90) return "#16A34A";
  if (c >= 70) return "#D97706";
  return "#DC2626";
}

export default function Index() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { scans, addScan } = useScans();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    setError(null);
    setBusy(true);
    try {
      // 1) take photo
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: true,
      });
      if (!photo?.uri) throw new Error("Ingen bild togs");

      // 2) downscale + jpeg to keep payload small
      const manipulated = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1600 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      const b64 = manipulated.base64;
      if (!b64) throw new Error("Kunde inte koda bilden");

      // 3) call backend OCR
      const res = await fetch(`${BACKEND}/api/ocr/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: b64 }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`OCR misslyckades (${res.status}): ${t.slice(0, 200)}`);
      }
      const data = await res.json();
      const scan: Scan = {
        id: data.id,
        imageUri: manipulated.uri,
        structuredText: data.structured_text || "",
        plainText: data.plain_text || "",
        confidence: data.confidence_percent || 0,
        errorEstimate: data.error_estimate_percent || 0,
        attempts: data.attempts || 1,
      };
      addScan(scan);
      router.push(`/page/${scan.id}`);
    } catch (e: any) {
      console.error(e);
      setError(e?.message ?? "Något gick fel");
      Alert.alert("Scan misslyckades", e?.message ?? "Okänt fel");
    } finally {
      setBusy(false);
    }
  }, [busy, addScan, router]);

  // Permission states
  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#09090B" />
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={[styles.center, { padding: 24 }]}>
        <Ionicons name="camera-outline" size={56} color="#09090B" />
        <Text style={styles.h1}>Kameraåtkomst krävs</Text>
        <Text style={styles.bodyMuted}>
          Vi behöver kameran för att kunna läsa och analysera text från dokument.
        </Text>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={requestPermission}
          testID="grant-camera-btn"
        >
          <Text style={styles.primaryBtnText}>Tillåt kamera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
      />

      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.brand}>JAWEL SCANNER</Text>
        <Text style={styles.brandSub}>OCR · AI · Mail</Text>
      </View>

      {/* Frame overlay */}
      <View pointerEvents="none" style={styles.frameWrap}>
        <View style={styles.frame} />
        <Text style={styles.frameHint}>Rikta kameran mot dokumentet</Text>
      </View>

      {/* Bottom controls */}
      <View
        style={[
          styles.bottomBar,
          { paddingBottom: Math.max(insets.bottom, 16) + 8 },
        ]}
      >
        {/* Scanned pages preview */}
        <TouchableOpacity
          style={styles.pagesPill}
          onPress={() => scans.length && router.push(`/page/${scans[scans.length - 1].id}`)}
          disabled={!scans.length}
          testID="scanned-pages-pill"
        >
          {scans.length > 0 ? (
            <>
              <Image source={{ uri: scans[scans.length - 1].imageUri }} style={styles.pillThumb} />
              <View>
                <Text style={styles.pillCount}>{scans.length} sidor</Text>
                <Text
                  style={[
                    styles.pillConf,
                    { color: confColor(scans[scans.length - 1].confidence) },
                  ]}
                >
                  {Math.round(scans[scans.length - 1].confidence)}%
                </Text>
              </View>
            </>
          ) : (
            <>
              <Ionicons name="document-outline" size={20} color="#fff" />
              <Text style={styles.pillCount}>0 sidor</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Shutter */}
        <TouchableOpacity
          style={[styles.shutter, busy && { opacity: 0.6 }]}
          onPress={handleCapture}
          disabled={busy}
          testID="camera-capture-btn"
          activeOpacity={0.85}
        >
          <View style={styles.shutterInner}>
            {busy ? <ActivityIndicator color="#09090B" /> : null}
          </View>
        </TouchableOpacity>

        {/* Mail button */}
        <TouchableOpacity
          style={[
            styles.mailBtn,
            { opacity: scans.length ? 1 : 0.4 },
          ]}
          onPress={() => scans.length && router.push("/email")}
          disabled={!scans.length}
          testID="open-email-btn"
        >
          <Ionicons name="mail" size={22} color="#fff" />
          <Text style={styles.mailBtnText}>Mail</Text>
        </TouchableOpacity>
      </View>

      {busy && (
        <View style={styles.busyOverlay} pointerEvents="none">
          <View style={styles.busyCard}>
            <ActivityIndicator color="#3B82F6" size="large" />
            <Text style={styles.busyTitle}>Dualhead AI läser…</Text>
            <Text style={styles.busySub}>GPT-5.2 + Gemini 3.1 Pro</Text>
          </View>
        </View>
      )}

      {error && (
        <View style={[styles.errBanner, { top: insets.top + 60 }]}>
          <Text style={styles.errText}>{error}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#FAFAFA", gap: 12 },
  h1: { fontSize: 22, fontWeight: "800", color: "#09090B", marginTop: 8, textAlign: "center" },
  bodyMuted: { color: "#71717A", textAlign: "center", fontSize: 15, lineHeight: 22, maxWidth: 320 },
  primaryBtn: {
    backgroundColor: "#09090B",
    paddingVertical: 16,
    paddingHorizontal: 28,
    borderRadius: 16,
    marginTop: 16,
  },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },

  topBar: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  brand: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 16,
    letterSpacing: 2,
    textShadowColor: "rgba(0,0,0,0.4)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  brandSub: { color: "#fff", opacity: 0.8, fontSize: 12, letterSpacing: 1.2 },

  frameWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  frame: {
    width: "82%",
    aspectRatio: 3 / 4,
    borderWidth: 3,
    borderColor: "#3B82F6",
    borderRadius: 24,
    backgroundColor: "transparent",
    ...Platform.select({
      ios: { shadowColor: "#3B82F6", shadowOpacity: 0.5, shadowRadius: 14 },
      default: {},
    }),
  },
  frameHint: {
    color: "#fff",
    fontSize: 13,
    letterSpacing: 0.5,
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },

  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 12,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  pagesPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 10,
    minWidth: 110,
  },
  pillThumb: { width: 32, height: 40, borderRadius: 6, backgroundColor: "#333" },
  pillCount: { color: "#fff", fontWeight: "700", fontSize: 13 },
  pillConf: { fontSize: 11, fontWeight: "700", marginTop: 2 },

  shutter: {
    width: 78,
    height: 78,
    borderRadius: 78,
    borderWidth: 5,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 62,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },

  mailBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#09090B",
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  mailBtnText: { color: "#fff", fontWeight: "700" },

  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  busyCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingVertical: 24,
    paddingHorizontal: 32,
    alignItems: "center",
    gap: 8,
  },
  busyTitle: { fontWeight: "800", fontSize: 16, color: "#09090B" },
  busySub: { color: "#71717A", fontSize: 13 },

  errBanner: {
    position: "absolute",
    left: 16,
    right: 16,
    backgroundColor: "#FEE2E2",
    borderColor: "#FCA5A5",
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  errText: { color: "#991B1B", fontSize: 13 },
});
