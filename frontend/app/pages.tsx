import React, { useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Image,
  Alert,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useScans, type Scan } from "@/src/store/scans";
import { runOrganize } from "@/src/lib/ai";

// The OCR text is already cleaned by textCleanup in ai.ts: hyphen rejoins,
// heading detection and paragraph reflow have all happened. For the clipboard
// we just need to strip the `**...**` markdown markers so the output is plain
// text that Word/Notes/etc. can wrap to A4 width naturally.
function reflowForClipboard(structured: string): string {
  if (!structured) return "";
  return (
    structured
      // Headings on their own line: strip the asterisks.
      .replace(/^[ \t]*\*\*(.+?)\*\*[ \t]*$/gm, "$1")
      // Inline bold inside body lines: strip too.
      .replace(/\*\*(.+?)\*\*/g, "$1")
      // Normalise any accidental triple+ blank lines.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function confColor(c: number) {
  if (c >= 90) return "#16A34A";
  if (c >= 70) return "#D97706";
  return "#DC2626";
}

type Resolved = Scan & {
  resolvedNumber: number;
  resolvedSource: "found" | "inferred";
  resolvedNote: string;
};

export default function PagesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { scans, updateScan, clearAll } = useScans();
  const [query, setQuery] = useState("");
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);

  // Build a deterministic local resolution (used for sorting + display)
  // until AI organize is called.
  const resolved: Resolved[] = useMemo(() => {
    const used = new Set<number>(
      scans.map((s) => s.pageNumber).filter((n): n is number => n != null)
    );
    let next = 1;
    const out: Resolved[] = [];
    for (const s of scans) {
      if (s.pageNumber != null) {
        out.push({
          ...s,
          resolvedNumber: s.pageNumber,
          resolvedSource: "found",
          resolvedNote: s.pageNote,
        });
      } else {
        while (used.has(next)) next++;
        used.add(next);
        out.push({
          ...s,
          resolvedNumber: next,
          resolvedSource: "inferred",
          resolvedNote: "No page number found – auto-assigned (loose).",
        });
        next++;
      }
    }
    return out.sort((a, b) => a.resolvedNumber - b.resolvedNumber);
  }, [scans]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return resolved;
    return resolved.filter(
      (p) =>
        p.plainText.toLowerCase().includes(q) ||
        p.structuredText.toLowerCase().includes(q) ||
        String(p.resolvedNumber) === q
    );
  }, [resolved, query]);

  const handleCopy = useCallback(async () => {
    if (!scans.length) return;
    setCopying(true);
    try {
      // Ask AI to do the smart organize/numbering across all pages
      let aiMap: Record<string, { page_number: number; source: string; note: string }> = {};
      try {
        const out = await runOrganize(
          scans.map((s, i) => ({
            id: s.id,
            plain_text: s.plainText || s.structuredText.replace(/\*\*/g, ""),
            detected_page_number: s.pageNumber ?? null,
            capture_order: i,
          }))
        );
        for (const p of out) {
          aiMap[p.id] = {
            page_number: p.page_number,
            source: p.source,
            note: p.note || "",
          };
        }
      } catch (e) {
        // fallback to local resolution
      }

      // Persist AI-resolved numbers back into scans (so detail view shows them)
      for (const s of scans) {
        const a = aiMap[s.id];
        if (!a) continue;
        if (s.pageNumber !== a.page_number || s.pageSource !== a.source) {
          updateScan(s.id, {
            pageNumber: a.page_number,
            pageSource: a.source === "found" ? "found" : "inferred",
            pageNote: a.note || s.pageNote,
          });
        }
      }

      // Build copy payload sorted by resolved page number
      const list = scans
        .map((s) => {
          const a = aiMap[s.id];
          const num =
            a?.page_number ??
            resolved.find((r) => r.id === s.id)?.resolvedNumber ??
            0;
          const src =
            a?.source ??
            resolved.find((r) => r.id === s.id)?.resolvedSource ??
            "inferred";
          return { s, num, src };
        })
        .sort((a, b) => a.num - b.num);

      const out = list
        .map(({ s, num, src }) => {
          const tag = src === "found" ? "" : " (loose)";
          const heading = `Page ${num}${tag}`;
          const body = reflowForClipboard(s.structuredText || s.plainText);
          return `${heading}\n${"-".repeat(heading.length)}\n${body}`;
        })
        .join("\n\n");

      await Clipboard.setStringAsync(out);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        Alert.alert(
          "Text copied!",
          "Start a new scan session, or keep these pages to add more?",
          [
            {
              text: "Keep pages",
              style: "cancel",
            },
            {
              text: "Start new",
              style: "destructive",
              onPress: () => {
                clearAll();
                router.replace("/");
              },
            },
          ]
        );
      }, 900);
    } catch (e: any) {
      Alert.alert("Couldn't copy", e?.message ?? "Unknown error");
    } finally {
      setCopying(false);
    }
  }, [scans, resolved, updateScan]);

  const handleClear = useCallback(() => {
    if (!scans.length) return;
    Alert.alert("Clear all pages?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          clearAll();
          router.replace("/");
        },
      },
    ]);
  }, [scans.length, clearAll, router]);

  const inferredCount = resolved.filter((r) => r.resolvedSource === "inferred").length;

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
          <Text style={styles.headerTitle}>Pages</Text>
          <Text style={styles.headerSub}>
            {scans.length} total
            {inferredCount ? ` · ${inferredCount} loose` : ""}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={handleClear}
          testID="clear-all-btn"
        >
          <Ionicons name="trash-outline" size={20} color="#DC2626" />
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchWrap}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={18} color="#71717A" />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search page content or page number"
            placeholderTextColor="#9CA3AF"
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            testID="search-input"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery("")} testID="clear-search-btn">
              <Ionicons name="close-circle" size={18} color="#A1A1AA" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 160, gap: 10 }}
        keyboardShouldPersistTaps="handled"
      >
        {filtered.length === 0 && (
          <View style={styles.emptyCard}>
            <Ionicons name="document-text-outline" size={32} color="#A1A1AA" />
            <Text style={styles.emptyText}>
              {query
                ? "No pages match the search."
                : "No scanned pages yet."}
            </Text>
          </View>
        )}

        {filtered.map((p) => {
          const c = confColor(p.confidence);
          const snippet = (p.plainText || p.structuredText.replace(/\*\*/g, ""))
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 140);
          return (
            <TouchableOpacity
              key={p.id}
              style={styles.pageRow}
              onPress={() => router.push(`/page/${p.id}`)}
              activeOpacity={0.85}
              testID={`page-row-${p.id}`}
            >
              <Image source={{ uri: p.imageUri }} style={styles.thumb} />
              <View style={{ flex: 1, gap: 4 }}>
                <View style={styles.rowTop}>
                  <View
                    style={[
                      styles.numBadge,
                      p.resolvedSource === "found"
                        ? styles.numBadgeFound
                        : styles.numBadgeInferred,
                    ]}
                  >
                    <Text
                      style={[
                        styles.numText,
                        {
                          color:
                            p.resolvedSource === "found" ? "#065F46" : "#92400E",
                        },
                      ]}
                    >
                      Page {p.resolvedNumber}
                      {p.resolvedSource === "inferred" ? " · loose" : ""}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.confChip,
                      { borderColor: c, backgroundColor: c + "18" },
                    ]}
                  >
                    <Text style={[styles.confChipText, { color: c }]}>
                      {Math.round(p.confidence)}%
                    </Text>
                  </View>
                </View>
                <Text style={styles.snippet} numberOfLines={2}>
                  {snippet || "(empty page)"}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Footer */}
      <View
        style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}
      >
        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={() => router.replace("/")}
          testID="add-page-btn"
        >
          <Ionicons name="add" size={20} color="#09090B" />
          <Text style={styles.secondaryBtnText}>New page</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.copyBtn,
            (!scans.length || copying) && { opacity: 0.5 },
          ]}
          onPress={handleCopy}
          disabled={!scans.length || copying}
          testID="copy-all-btn"
        >
          {copying ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="copy" size={18} color="#fff" />
              <Text style={styles.copyBtnText}>Copy all text</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {copied && (
        <View style={styles.toast} pointerEvents="none">
          <View style={styles.toastInner}>
            <Ionicons name="checkmark-circle" size={22} color="#16A34A" />
            <Text style={styles.toastText}>Copied!</Text>
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

  searchWrap: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: "#FAFAFA" },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E4E4E7",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: "#09090B",
    paddingVertical: 0,
  },

  emptyCard: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 64,
    gap: 8,
  },
  emptyText: { color: "#71717A", fontSize: 14 },

  pageRow: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: "#E4E4E7",
  },
  thumb: {
    width: 60,
    height: 76,
    borderRadius: 8,
    backgroundColor: "#E4E4E7",
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  numBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  numBadgeFound: { backgroundColor: "#D1FAE5", borderColor: "#A7F3D0" },
  numBadgeInferred: { backgroundColor: "#FEF3C7", borderColor: "#FDE68A" },
  numText: { fontWeight: "800", fontSize: 12 },
  confChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  confChipText: { fontWeight: "800", fontSize: 11 },
  snippet: { color: "#52525B", fontSize: 13, lineHeight: 18 },

  footer: {
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
  copyBtn: {
    flex: 1.4,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#09090B",
    borderRadius: 14,
    paddingVertical: 14,
  },
  copyBtnText: { color: "#fff", fontWeight: "800" },

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
