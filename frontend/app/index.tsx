import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
  Image,
  Animated,
  Easing,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useScans, type Scan } from "@/src/store/scans";
import {
  runOcrScan,
  runOcrRescan,
  type ScanProgressEvent,
  type ScanStage,
  type ScanProgressFn,
} from "@/src/lib/ai";
import { getEta } from "@/src/lib/scanStats";
import { type ProviderId } from "@/src/lib/aiSettings";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyError } = require("@/src/lib/errorMessages");

function confColor(c: number) {
  if (c >= 90) return "#16A34A";
  if (c >= 70) return "#D97706";
  return "#DC2626";
}

type VerifierChip = {
  id: ProviderId;
  label: string;
  status: "pending" | "ok" | "fail";
};

type ProgressState = {
  stageLabel: string;
  stage: ScanStage | "compress";
  verifiers: VerifierChip[];
  startedAt: number;
};

function formatSeconds(s: number): string {
  if (!isFinite(s) || s < 0) return "0s";
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}m ${sec}s`;
}

function SmartProgressOverlay({
  progress,
  etaSeconds,
  etaSamples,
}: {
  progress: ProgressState;
  etaSeconds: number;
  etaSamples: number;
}) {
  // Tick the elapsed timer every 250ms.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed((Date.now() - progress.startedAt) / 1000);
    }, 250);
    return () => clearInterval(id);
  }, [progress.startedAt]);

  // Animate progress bar toward ETA, but never beyond 95% until the call
  // actually finishes (component unmounts).
  const widthAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const eta = Math.max(etaSeconds, 4);
    // Target = elapsed / eta (capped at 0.95) so the bar slows down as it
    // approaches the prediction; it'll never look "stuck at 100%".
    const target = Math.min(0.95, elapsed / eta);
    Animated.timing(widthAnim, {
      toValue: target,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [elapsed, etaSeconds, widthAnim]);

  const remaining = Math.max(0, etaSeconds - elapsed);
  const overtime = elapsed > etaSeconds + 2;

  return (
    <View style={overlay.root} pointerEvents="none">
      <View style={overlay.card}>
        {/* Stage label + spinner */}
        <View style={overlay.row}>
          <ActivityIndicator color="#3B82F6" />
          <View style={{ flex: 1 }}>
            <Text style={overlay.stageLabel} numberOfLines={2}>
              {progress.stageLabel}
            </Text>
            <Text style={overlay.timer}>
              {formatSeconds(elapsed)} elapsed
              {!overtime && remaining > 0
                ? ` · ~${formatSeconds(remaining)} left`
                : overtime
                ? " · taking longer than usual"
                : ""}
            </Text>
          </View>
        </View>

        {/* Progress bar */}
        <View style={overlay.barTrack}>
          <Animated.View
            style={[
              overlay.barFill,
              {
                width: widthAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["0%", "100%"],
                }),
                backgroundColor: overtime ? "#D97706" : "#3B82F6",
              },
            ]}
          />
        </View>

        {/* Verifier chips (only when consensus mode is on) */}
        {progress.verifiers.length > 0 && (
          <View style={overlay.chipsRow}>
            <Text style={overlay.chipsLabel}>Cross-check</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, flex: 1 }}>
              {progress.verifiers.map((v) => {
                const c =
                  v.status === "ok"
                    ? "#16A34A"
                    : v.status === "fail"
                    ? "#DC2626"
                    : "#71717A";
                const icon =
                  v.status === "ok"
                    ? "checkmark-circle"
                    : v.status === "fail"
                    ? "close-circle"
                    : "ellipse-outline";
                return (
                  <View
                    key={v.id}
                    style={[
                      overlay.chip,
                      { borderColor: c + "55", backgroundColor: c + "12" },
                    ]}
                  >
                    <Ionicons name={icon as any} size={12} color={c} />
                    <Text style={[overlay.chipText, { color: c }]}>{v.label}</Text>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        <Text style={overlay.help}>
          {etaSamples > 0
            ? `Estimate based on your last ${etaSamples} scan${etaSamples === 1 ? "" : "s"}.`
            : "First scan — estimate will improve over time."}
        </Text>
      </View>
    </View>
  );
}

export default function Index() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { rescanId } = useLocalSearchParams<{ rescanId?: string }>();
  const { scans, addScan, updateScan, getScan } = useScans();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [etaSeconds, setEtaSeconds] = useState(18);
  const [etaSamples, setEtaSamples] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<"off" | "auto" | "on">("auto");

  const cycleFlash = useCallback(() => {
    setFlash((f) => (f === "off" ? "auto" : f === "auto" ? "on" : "off"));
  }, []);
  const flashIcon =
    flash === "on" ? "flash" : flash === "auto" ? "flash-outline" : "flash-off";
  const flashLabel = flash === "on" ? "ON" : flash === "auto" ? "AUTO" : "OFF";

  const rescanTarget = rescanId ? getScan(rescanId) : undefined;
  const rescanIdx = rescanTarget
    ? scans.findIndex((s) => s.id === rescanTarget.id)
    : -1;

  // Refresh ETA prediction when the screen mounts and after every scan.
  const refreshEta = useCallback(async () => {
    try {
      const info = await getEta();
      setEtaSeconds(info.seconds);
      setEtaSamples(info.samples);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    refreshEta();
  }, [refreshEta]);

  const handleProgress: ScanProgressFn = useCallback((e: ScanProgressEvent) => {
    setProgress((prev) => {
      if (!prev) return prev;
      if (e.kind === "stage") {
        return { ...prev, stage: e.stage, stageLabel: e.label };
      }
      // verifier event – upsert by providerId
      const existing = prev.verifiers.findIndex((v) => v.id === e.providerId);
      const next = [...prev.verifiers];
      if (existing >= 0) {
        next[existing] = { id: e.providerId, label: e.label, status: e.status };
      } else {
        next.push({ id: e.providerId, label: e.label, status: e.status });
      }
      return { ...prev, verifiers: next };
    });
  }, []);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    setError(null);
    setBusy(true);
    // Initial progress state – set BEFORE the camera shutter so the user
    // sees feedback immediately.
    setProgress({
      stage: "compress",
      stageLabel: "Capturing photo…",
      verifiers: [],
      startedAt: Date.now(),
    });
    try {
      // 1) take photo
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: true,
      });
      if (!photo?.uri) throw new Error("No image captured");

      setProgress((p) =>
        p ? { ...p, stage: "compress", stageLabel: "Compressing image…" } : p
      );

      // 2) downscale + jpeg to keep payload small
      const manipulated = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1600 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      const b64 = manipulated.base64;
      if (!b64) throw new Error("Could not encode image");

      // 3a) RESCAN mode — improve an existing page with a new photo
      if (rescanTarget) {
        const data = await runOcrRescan(
          b64,
          rescanTarget.structuredText,
          rescanTarget.confidence,
          rescanTarget.attempts,
          handleProgress
        );
        await updateScan(rescanTarget.id, {
          imageUri: manipulated.uri,
          structuredText: data.structured_text || rescanTarget.structuredText,
          plainText: data.plain_text || rescanTarget.plainText,
          confidence: data.confidence_percent || rescanTarget.confidence,
          errorEstimate:
            data.error_estimate_percent || rescanTarget.errorEstimate,
          coherenceScore:
            data.coherence_score ?? rescanTarget.coherenceScore,
          coherenceNote:
            data.coherence_note ?? rescanTarget.coherenceNote,
          pageNumber:
            data.page_number ?? rescanTarget.pageNumber,
          pageSource:
            data.page_source || rescanTarget.pageSource,
          pageNote: data.page_note ?? rescanTarget.pageNote,
          attempts: data.attempts || rescanTarget.attempts + 1,
          consensusScore: data.consensus_score,
          verifierCount: data.verifier_count,
          verifierLabels: data.verifier_labels,
        });
        await refreshEta();
        router.replace(`/page/${rescanTarget.id}`);
        return;
      }

      // 3b) NEW SCAN mode
      const data = await runOcrScan(b64, handleProgress);
      const scan: Scan = {
        id: data.id,
        imageUri: manipulated.uri,
        structuredText: data.structured_text || "",
        plainText: data.plain_text || "",
        confidence: data.confidence_percent || 0,
        errorEstimate: data.error_estimate_percent || 0,
        coherenceScore: data.coherence_score || 0,
        coherenceNote: data.coherence_note || "",
        pageNumber: data.page_number ?? null,
        pageSource: data.page_source || "missing",
        pageNote: data.page_note || "",
        attempts: data.attempts || 1,
        consensusScore: data.consensus_score,
        verifierCount: data.verifier_count,
        verifierLabels: data.verifier_labels,
      };
      await addScan(scan);
      await refreshEta();
      router.push(`/page/${scan.id}`);
    } catch (e: any) {
      const classified = classifyError(e?.message ?? String(e));
      // Inline banner: just the short title.
      setError(classified.title);
      // Build a contextual Alert with actions tailored to the error type.
      const buttons: any[] = [];
      if (classified.billingUrl) {
        buttons.push({
          text: "Top up credit",
          onPress: () => Linking.openURL(classified.billingUrl).catch(() => {}),
        });
      }
      if (classified.openSettings) {
        buttons.push({
          text: "Open Settings",
          onPress: () => router.push("/settings"),
        });
      }
      // Always offer a dismiss button. Use "cancel" style so it's bolded
      // on iOS and acts as the default tap zone.
      buttons.push({ text: "OK", style: "cancel" });
      Alert.alert(classified.title, classified.detail, buttons);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [busy, addScan, updateScan, router, rescanTarget, handleProgress, refreshEta]);

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
        <Text style={styles.h1}>Camera access required</Text>
        <Text style={styles.bodyMuted}>
          We need your camera to read and analyse text from documents.
        </Text>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={requestPermission}
          testID="grant-camera-btn"
        >
          <Text style={styles.primaryBtnText}>Allow camera</Text>
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
        flash={flash}
      />

      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View>
          <Text style={styles.brand}>
            {rescanTarget ? `IMPROVE PAGE ${rescanIdx + 1}` : "COPYTHAT"}
          </Text>
          <Text style={styles.brandSub}>
            {rescanTarget
              ? `Attempt ${rescanTarget.attempts + 1} · take new photo`
              : "OCR · AI · Copy"}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TouchableOpacity
            style={styles.flashPill}
            onPress={cycleFlash}
            testID="flash-toggle-btn"
            activeOpacity={0.8}
          >
            <Ionicons name={flashIcon as any} size={16} color="#fff" />
            <Text style={styles.flashPillText}>{flashLabel}</Text>
          </TouchableOpacity>
          {!rescanTarget && (
            <TouchableOpacity
              style={styles.flashPill}
              onPress={() => router.push("/settings")}
              testID="open-settings-btn"
              activeOpacity={0.8}
            >
              <Ionicons name="settings-outline" size={16} color="#fff" />
            </TouchableOpacity>
          )}
          {rescanTarget ? (
            <TouchableOpacity
              style={styles.cancelPill}
              onPress={() => router.replace(`/page/${rescanTarget.id}`)}
              testID="cancel-rescan-btn"
            >
              <Text style={styles.cancelPillText}>Cancel</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* Frame overlay */}
      <View pointerEvents="none" style={styles.frameWrap}>
        <View style={styles.frame} />
        <Text style={styles.frameHint}>Point the camera at the document</Text>
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
              <Text style={styles.pillCount}>0 pages</Text>
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

        {/* Pages button — always tappable so the user can review past scans
            even before taking a new one. Shows the scan count when > 0. */}
        <TouchableOpacity
          style={styles.mailBtn}
          onPress={() => router.push("/pages")}
          testID="open-pages-btn"
          activeOpacity={0.8}
        >
          <Ionicons name="copy-outline" size={20} color="#fff" />
          <Text style={styles.mailBtnText}>Pages</Text>
          {scans.length > 0 && (
            <View style={styles.mailBtnBadge}>
              <Text style={styles.mailBtnBadgeText}>{scans.length}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {busy && progress && (
        <SmartProgressOverlay
          progress={progress}
          etaSeconds={etaSeconds}
          etaSamples={etaSamples}
        />
      )}

      {error && (
        <TouchableOpacity
          style={[styles.errBanner, { top: insets.top + 60 }]}
          onPress={() => setError(null)}
          activeOpacity={0.85}
          testID="error-banner"
        >
          <Ionicons name="alert-circle" size={18} color="#991B1B" />
          <Text style={styles.errText} numberOfLines={2}>
            {error}
          </Text>
          <Ionicons name="close" size={16} color="#991B1B" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const overlay = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#fff",
    borderRadius: 22,
    paddingVertical: 20,
    paddingHorizontal: 18,
    gap: 14,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 14 },
  stageLabel: {
    fontWeight: "800",
    fontSize: 15,
    color: "#09090B",
    lineHeight: 20,
  },
  timer: {
    color: "#52525B",
    fontSize: 12,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  barTrack: {
    height: 8,
    backgroundColor: "#F4F4F5",
    borderRadius: 999,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 999,
  },
  chipsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  chipsLabel: {
    color: "#71717A",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
    width: 78,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { fontSize: 11, fontWeight: "800" },
  help: {
    color: "#A1A1AA",
    fontSize: 11,
    textAlign: "center",
    lineHeight: 16,
  },
});

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
  cancelPill: {
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  cancelPillText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  flashPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  flashPillText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 11,
    letterSpacing: 1,
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
  mailBtnBadge: {
    backgroundColor: "#3B82F6",
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 2,
  },
  mailBtnBadgeText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },

  errBanner: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#FEE2E2",
    borderColor: "#FCA5A5",
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  errText: { flex: 1, color: "#991B1B", fontSize: 13, fontWeight: "700" },
});
