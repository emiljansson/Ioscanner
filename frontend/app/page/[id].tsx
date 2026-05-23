import React, { useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
  TextInput,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useScans } from "@/src/store/scans";

function confColor(c: number) {
  if (c >= 90) return "#16A34A";
  if (c >= 70) return "#D97706";
  return "#DC2626";
}
function confLabel(c: number) {
  if (c >= 90) return "High confidence";
  if (c >= 70) return "Medium confidence";
  return "Low confidence";
}

// Render markdown-ish: **bold** (treat as heading lines) and lists
function StructuredText({ text }: { text: string }) {
  const lines = (text || "").split(/\r?\n/);
  return (
    <View style={{ gap: 6 }}>
      {lines.map((line, i) => {
        if (!line.trim()) return <View key={i} style={{ height: 6 }} />;
        // Whole line bold "**...**"
        const m = line.match(/^\s*\*\*(.+?)\*\*\s*$/);
        if (m) {
          return (
            <Text key={i} style={styles.heading}>
              {m[1]}
            </Text>
          );
        }
        // Inline bold inside line
        const parts = line.split(/\*\*(.+?)\*\*/g);
        return (
          <Text key={i} style={styles.body}>
            {parts.map((p, idx) =>
              idx % 2 === 1 ? (
                <Text key={idx} style={styles.bodyBold}>
                  {p}
                </Text>
              ) : (
                <Text key={idx}>{p}</Text>
              )
            )}
          </Text>
        );
      })}
    </View>
  );
}

export default function PageDetail() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { scans, getScan, updateScan, removeScan } = useScans();
  const scan = getScan(id || "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(scan?.structuredText || "");

  const idx = useMemo(
    () => scans.findIndex((s) => s.id === id),
    [scans, id]
  );

  const handleRescan = useCallback(() => {
    if (!scan) return;
    // Open the camera to take a NEW photo. The capture flow on the camera
    // screen will call /api/ocr/rescan with the previous text and update
    // this scan in-place.
    router.push(`/?rescanId=${scan.id}`);
  }, [scan, router]);

  const handleDelete = useCallback(() => {
    if (!scan) return;
    Alert.alert("Delete page?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          removeScan(scan.id);
          router.back();
        },
      },
    ]);
  }, [scan, removeScan, router]);

  if (!scan) {
    return (
      <View style={[styles.center, { paddingTop: insets.top + 20 }]}>
        <Text style={styles.muted}>This page no longer exists.</Text>
        <TouchableOpacity onPress={() => router.replace("/")} style={styles.primaryBtn}>
          <Text style={styles.primaryBtnText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const color = confColor(scan.confidence);
  const lowConf = scan.confidence < 90 || scan.coherenceScore < 70;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: "#FAFAFA" }}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => router.back()}
          testID="back-btn"
        >
          <Ionicons name="chevron-back" size={22} color="#09090B" />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={styles.headerTitle}>
            Page {idx >= 0 ? idx + 1 : "?"} / {scans.length}
          </Text>
          <Text style={styles.headerSub}>Attempt {scan.attempts}</Text>
        </View>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={handleDelete}
          testID="delete-page-btn"
        >
          <Ionicons name="trash-outline" size={20} color="#DC2626" />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 160, gap: 16 }}
        showsVerticalScrollIndicator={false}
      >
        <Image source={{ uri: scan.imageUri }} style={styles.docPreview} />

        {/* Confidence card */}
        <View style={styles.confCard}>
          <View style={styles.confRow}>
            <View
              style={[styles.confBadge, { backgroundColor: color + "20", borderColor: color }]}
              testID="confidence-badge"
            >
              <View style={[styles.confDot, { backgroundColor: color }]} />
              <Text style={[styles.confText, { color }]}>
                {Math.round(scan.confidence)}%
              </Text>
            </View>
            <Text style={styles.confLabel}>{confLabel(scan.confidence)}</Text>
          </View>
          <Text style={styles.confMuted}>
            Estimated error: ~{Math.round(scan.errorEstimate)}% of the text may be incorrect.
          </Text>

          {/* Semantic coherence sub-row */}
          <View style={styles.cohRow}>
            <View
              style={[
                styles.cohDot,
                {
                  backgroundColor:
                    scan.coherenceScore >= 80
                      ? "#16A34A"
                      : scan.coherenceScore >= 60
                      ? "#D97706"
                      : "#DC2626",
                },
              ]}
            />
            <Text style={styles.cohLabel}>
              Content plausibility:{" "}
              <Text style={styles.cohValue}>
                {Math.round(scan.coherenceScore)}%
              </Text>
            </Text>
          </View>
          {scan.coherenceScore < 70 && (
            <View style={styles.cohWarn} testID="coherence-warning">
              <Ionicons name="warning-outline" size={16} color="#92400E" />
              <Text style={styles.cohWarnText}>
                {scan.coherenceNote
                  ? scan.coherenceNote
                  : "The text doesn't look like a coherent document – please review the content."}
              </Text>
            </View>
          )}

          {lowConf && (
            <TouchableOpacity
              style={[
                styles.rescanBtn,
                scan.confidence < 70 && styles.rescanBtnUrgent,
              ]}
              onPress={handleRescan}
              testID="rescan-btn"
            >
              <Ionicons name="camera-reverse" size={18} color="#DC2626" />
              <Text style={styles.rescanBtnText}>
                Take new photo (improve)
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* OCR result */}
        <View style={styles.ocrCard}>
          <View style={styles.ocrHeader}>
            <Text style={styles.cardTitle}>Extracted text</Text>
            <TouchableOpacity
              onPress={() => {
                if (editing) {
                  updateScan(scan.id, { structuredText: draft });
                }
                setEditing((v) => !v);
              }}
              style={styles.editBtn}
              testID="edit-toggle-btn"
            >
              <Ionicons
                name={editing ? "checkmark" : "create-outline"}
                size={16}
                color="#09090B"
              />
              <Text style={styles.editBtnText}>{editing ? "Save" : "Edit"}</Text>
            </TouchableOpacity>
          </View>
          {editing ? (
            <TextInput
              multiline
              value={draft}
              onChangeText={setDraft}
              style={styles.textArea}
              placeholder="Type text…"
              placeholderTextColor="#9CA3AF"
              testID="ocr-text-input"
            />
          ) : (
            <StructuredText text={scan.structuredText} />
          )}
        </View>
      </ScrollView>

      {/* Bottom actions */}
      <View
        style={[
          styles.bottomActions,
          { paddingBottom: Math.max(insets.bottom, 12) + 8 },
        ]}
      >
        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={() => router.replace("/")}
          testID="add-page-btn"
        >
          <Ionicons name="add" size={20} color="#09090B" />
          <Text style={styles.secondaryBtnText}>Add page</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.primaryBtnRow}
          onPress={() => router.push("/pages")}
          testID="continue-btn"
        >
          <Text style={styles.primaryBtnText}>All pages</Text>
          <Ionicons name="arrow-forward" size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  muted: { color: "#71717A" },
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

  docPreview: {
    width: "100%",
    height: 220,
    borderRadius: 16,
    backgroundColor: "#E4E4E7",
    resizeMode: "cover",
  },

  confCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E4E4E7",
    gap: 10,
  },
  confRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  confBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  confDot: { width: 8, height: 8, borderRadius: 4 },
  confText: { fontWeight: "800", fontSize: 16 },
  confLabel: { fontWeight: "700", color: "#09090B" },
  confMuted: { color: "#71717A", fontSize: 13, lineHeight: 18 },

  rescanBtn: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#FEF2F2",
    borderColor: "#FECACA",
    borderWidth: 1,
    paddingVertical: 12,
    borderRadius: 14,
  },
  rescanBtnUrgent: { backgroundColor: "#FEE2E2", borderColor: "#FCA5A5" },
  rescanBtnText: { color: "#DC2626", fontWeight: "700" },

  cohRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
  },
  cohDot: { width: 8, height: 8, borderRadius: 4 },
  cohLabel: { color: "#71717A", fontSize: 13 },
  cohValue: { color: "#09090B", fontWeight: "800" },
  cohWarn: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "#FEF3C7",
    borderColor: "#FDE68A",
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 4,
  },
  cohWarnText: { flex: 1, color: "#92400E", fontSize: 13, lineHeight: 18 },

  pageNumCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E4E4E7",
    gap: 6,
  },
  pageNumBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  pageNumBadgeFound: { backgroundColor: "#D1FAE5", borderColor: "#A7F3D0" },
  pageNumBadgeInferred: { backgroundColor: "#FEF3C7", borderColor: "#FDE68A" },
  pageNumBadgeMissing: { backgroundColor: "#F4F4F5", borderColor: "#E4E4E7" },
  pageNumText: { fontWeight: "800", fontSize: 14 },
  pageNumSub: { color: "#71717A", fontSize: 13 },
  pageNumNote: { color: "#52525B", fontSize: 12, fontStyle: "italic" },

  ocrCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: "#E4E4E7",
    gap: 12,
  },
  ocrHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: { fontWeight: "800", fontSize: 14, color: "#09090B", letterSpacing: 1 },
  editBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#F4F4F5",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  editBtnText: { fontWeight: "700", color: "#09090B", fontSize: 12 },

  textArea: {
    minHeight: 220,
    borderWidth: 1,
    borderColor: "#E4E4E7",
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    color: "#09090B",
    textAlignVertical: "top",
    backgroundColor: "#FAFAFA",
  },

  heading: {
    fontSize: 17,
    fontWeight: "900",
    color: "#09090B",
    marginTop: 8,
    marginBottom: 2,
    letterSpacing: 0.2,
  },
  body: { fontSize: 15, color: "#09090B", lineHeight: 22 },
  bodyBold: { fontWeight: "800", color: "#09090B" },

  bottomActions: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: 10,
    padding: 12,
    backgroundColor: "rgba(255,255,255,0.96)",
    borderTopWidth: 1,
    borderTopColor: "#E4E4E7",
  },
  secondaryBtn: {
    flex: 1,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F4F4F5",
    borderRadius: 14,
    paddingVertical: 14,
  },
  secondaryBtnText: { fontWeight: "700", color: "#09090B" },
  primaryBtnRow: {
    flex: 1.2,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#09090B",
    borderRadius: 14,
    paddingVertical: 14,
  },
  primaryBtn: {
    backgroundColor: "#09090B",
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: 14,
  },
  primaryBtnText: { fontWeight: "800", color: "#fff" },
});
