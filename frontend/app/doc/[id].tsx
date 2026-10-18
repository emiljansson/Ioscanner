import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { api, exportUrl, uploadFile, type Doc, type Page, type PickedFile } from "@/src/api";
import { Button } from "@/src/components/ui";
import { PageCard } from "@/src/components/PageCard";
import { AiPanel } from "@/src/components/AiPanel";
import { MarkdownView } from "@/src/components/MarkdownView";
import { ScanModal } from "@/src/components/ScanModal";
import { FiguresPanel, collectFigures } from "@/src/components/FiguresPanel";
import { pickFiles, useDropzone } from "@/src/files";
import { colors, radius } from "@/src/theme";

type UploadState = { name: string; progress: number; error?: string; done?: boolean };

export default function DocScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const wide = width >= 1100;
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [editingGen, setEditingGen] = useState(false);
  const [genDraft, setGenDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [figsOpen, setFigsOpen] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await api<Doc>(`/documents/${id}`);
      if (!mounted.current) return;
      setDoc(d);
      setTitle((t) => t || d.title);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      mounted.current = true;
      load();
      return () => {
        mounted.current = false;
      };
    }, [load])
  );

  const pending =
    doc?.status === "processing" || (doc?.pages ?? []).some((p) => p.status === "queued" || p.status === "processing");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [pending, load]);

  const startUploads = useCallback(
    async (files: PickedFile[]) => {
      if (!files.length || !id) return;
      setUploads(files.map((f) => ({ name: f.name, progress: 0 })));
      for (let i = 0; i < files.length; i++) {
        try {
          await uploadFile(id, files[i], (p) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, progress: p } : x))));
          setUploads((u) => u.map((x, j) => (j === i ? { ...x, progress: 1, done: true } : x)));
        } catch (e: any) {
          setUploads((u) => u.map((x, j) => (j === i ? { ...x, error: e.message } : x)));
        }
        load();
      }
      setTimeout(() => setUploads((u) => u.filter((x) => x.error)), 2500);
    },
    [id, load]
  );

  const dragging = useDropzone(startUploads, doc?.kind === "scan");

  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(null), 2500);
  };

  const saveTitle = async () => {
    if (doc && title.trim() && title.trim() !== doc.title) {
      setDoc(await api<Doc>(`/documents/${doc.id}`, { method: "PATCH", body: { title: title.trim() } }));
    }
  };

  const copyAll = async () => {
    const r = await api<{ markdown: string }>(`/documents/${id}/markdown`);
    await Clipboard.setStringAsync(r.markdown.replace(/!\[[^\]]*\]\(fig:[a-f0-9]+\)/g, ""));
    flash("All text är kopierad");
  };

  const download = (fmt: "docx" | "zip") => {
    const url = exportUrl(id!, fmt);
    if (Platform.OS === "web") window.open(url, "_blank");
    else Linking.openURL(url);
  };

  const deleteDoc = () => {
    const go = async () => {
      await api(`/documents/${id}`, { method: "DELETE" });
      router.back();
    };
    if (Platform.OS === "web") {
      if (window.confirm("Ta bort dokumentet permanent?")) go();
    } else Alert.alert("Ta bort dokument?", "Dokumentet och alla sidor tas bort permanent.", [{ text: "Avbryt", style: "cancel" }, { text: "Ta bort", style: "destructive", onPress: go }]);
  };

  const updatePage = (p?: Page) => {
    if (p && doc) setDoc({ ...doc, pages: doc.pages?.map((x) => (x.id === p.id ? p : x)) });
    else load();
  };

  const movePage = async (idx: number, dir: -1 | 1) => {
    const ids = (doc?.pages ?? []).map((p) => p.id);
    const j = idx + dir;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    setDoc(await api<Doc>(`/documents/${id}/reorder`, { body: { page_ids: ids } }));
  };

  const deletePage = async (pid: string) => {
    await api(`/pages/${pid}`, { method: "DELETE" });
    setSelected((s) => s.filter((x) => x !== pid));
    load();
  };

  if (!doc) {
    return (
      <SafeAreaView style={styles.safe}>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />}
      </SafeAreaView>
    );
  }

  const pages = doc.pages ?? [];
  const counts = doc.page_counts ?? {};
  const inProgress = (counts.queued ?? 0) + (counts.processing ?? 0);
  const isGen = doc.kind === "generated";
  const genFigs: Record<string, { url: string; caption: string }> = {};
  Object.entries(doc.figures ?? {}).forEach(([k, url]) => (genFigs[k] = { url, caption: "" }));

  const panel = (
    <AiPanel
      doc={doc}
      selectedPageIds={selected}
      onClose={() => setAiOpen(false)}
      onCreated={(d) => {
        setAiOpen(false);
        router.push(`/doc/${d.id}`);
      }}
    />
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.topbar}>
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace("/archive"))} style={styles.icon} accessibilityLabel="Tillbaka" testID="doc-back">
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <TextInput testID="doc-title" style={styles.title} value={title} onChangeText={setTitle} onBlur={saveTitle} onSubmitEditing={saveTitle} />
        <Pressable onPress={deleteDoc} style={styles.icon} accessibilityLabel="Ta bort dokument" testID="doc-delete">
          <Ionicons name="trash-outline" size={20} color={colors.danger} />
        </Pressable>
      </View>
      <View style={styles.toolbar}>
        {!isGen && <Button testID="upload-btn" small variant="primary" icon="cloud-upload-outline" label="Lägg till material" onPress={async () => startUploads(await pickFiles())} />}
        {!isGen && Platform.OS !== "web" && <Button small icon="camera-outline" label="Kamera" onPress={() => router.push(`/capture?doc=${doc.id}`)} />}
        {!isGen && Platform.OS === "web" && <Button testID="scan-btn" small icon="print-outline" label="Scanna" onPress={() => setScanOpen(true)} />}
        <Button testID="ai-open" small icon="sparkles-outline" label="Bearbeta med AI" onPress={() => setAiOpen((o) => !o)} />
        <Button testID="download-docx" small icon="document-outline" label="Word" onPress={() => download("docx")} />
        <Button testID="download-zip" small icon="archive-outline" label="ZIP" onPress={() => download("zip")} />
        <Button testID="figures-open" small icon="images-outline" label={`Bilder (${collectFigures(doc).filter((f) => !f.deleted).length})`} onPress={() => setFigsOpen(true)} />
        <Button testID="copy-all" small icon="copy-outline" label="Kopiera text" onPress={copyAll} />
        {!isGen && pages.length > 1 && <Button small icon="swap-vertical" label="Sortera efter sidnummer" onPress={async () => setDoc(await api<Doc>(`/documents/${id}/sort`, { method: "POST" }))} />}
      </View>
      {notice && <Text style={styles.notice}>{notice}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.body}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>
          {uploads.map((u, i) => (
            <View key={i} style={styles.upload}>
              <Ionicons name={u.error ? "alert-circle" : u.done ? "checkmark-circle" : "cloud-upload-outline"} size={18} color={u.error ? colors.danger : colors.primary} />
              <Text style={styles.uploadName} numberOfLines={1}>{u.name}</Text>
              <Text style={[styles.uploadState, u.error && { color: colors.danger }]}>{u.error ?? (u.done ? "Uppladdad" : `${Math.round(u.progress * 100)}%`)}</Text>
            </View>
          ))}
          {!isGen && inProgress > 0 && (
            <View style={styles.progress}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.progressText}>
                AI läser {inProgress} av {pages.length} sidor · ca {Math.max(1, Math.ceil((inProgress * 20) / 3 / 60))} min kvar
              </Text>
            </View>
          )}
          {isGen ? (
            <View style={styles.genCard}>
              <Text style={styles.instr}>Instruktion: {doc.instruction}</Text>
              {doc.status === "processing" ? (
                <View style={styles.progress}>
                  <ActivityIndicator color={colors.primary} />
                  <Text style={styles.progressText}>AI bearbetar materialet… det kan ta någon minut.</Text>
                </View>
              ) : doc.status === "error" ? (
                <Text style={styles.error}>{doc.error}</Text>
              ) : editingGen ? (
                <>
                  <TextInput style={styles.editor} multiline value={genDraft} onChangeText={setGenDraft} textAlignVertical="top" />
                  <View style={styles.row}>
                    <Button small label="Avbryt" onPress={() => setEditingGen(false)} />
                    <Button small variant="primary" label="Spara" onPress={async () => { setDoc(await api<Doc>(`/documents/${id}`, { method: "PATCH", body: { markdown: genDraft } })); setEditingGen(false); }} />
                  </View>
                </>
              ) : (
                <>
                  <MarkdownView markdown={doc.markdown ?? ""} figures={genFigs} />
                  <Button small icon="create-outline" label="Redigera" onPress={() => { setGenDraft(doc.markdown ?? ""); setEditingGen(true); }} style={{ alignSelf: "flex-start" }} />
                </>
              )}
            </View>
          ) : pages.length === 0 ? (
            <Pressable style={styles.drop} onPress={async () => startUploads(await pickFiles())} testID="dropzone">
              <Ionicons name="cloud-upload-outline" size={40} color={colors.primary} />
              <Text style={styles.dropTitle}>{Platform.OS === "web" ? "Dra in bilder eller PDF:er hit" : "Lägg till material"}</Text>
              <Text style={styles.dropSub}>JPG, PNG, HEIC, WebP, TIFF eller flersidiga PDF:er (max 200 sidor per fil)</Text>
            </Pressable>
          ) : (
            pages.map((p, i) => (
              <PageCard
                key={p.id + p.status}
                page={p}
                index={i}
                total={pages.length}
                selected={selected.includes(p.id)}
                onToggleSelect={() => setSelected((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))}
                onChanged={updatePage}
                onDelete={() => deletePage(p.id)}
                onMove={(d) => movePage(i, d)}
              />
            ))
          )}
        </ScrollView>
        {aiOpen && wide && <View style={styles.side}>{panel}</View>}
      </View>
      {aiOpen && !wide && (
        <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setAiOpen(false)}>
          <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>{panel}</SafeAreaView>
        </Modal>
      )}
      {figsOpen && <FiguresPanel doc={doc} onClose={() => setFigsOpen(false)} onPageChanged={updatePage} onDownloadZip={() => download("zip")} />}
      {scanOpen && (
        <ScanModal
          visible
          onClose={() => setScanOpen(false)}
          onScanned={(file) => startUploads([{ name: file.name, size: file.size, uri: "", file, mimeType: file.type }])}
        />
      )}
      {dragging && (
        <View style={styles.dragOverlay} pointerEvents="none">
          <Ionicons name="cloud-upload" size={56} color={colors.primaryText} />
          <Text style={styles.dragText}>Släpp filerna för att ladda upp</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  topbar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, gap: 4 },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, fontSize: 22, fontWeight: "800", color: colors.text, minHeight: 44, paddingHorizontal: 4 },
  toolbar: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  body: { flex: 1, flexDirection: "row" },
  content: { padding: 16, gap: 16, maxWidth: 900, width: "100%", alignSelf: "center", paddingBottom: 64 },
  side: { width: 380, borderLeftWidth: 1, borderLeftColor: colors.border },
  upload: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.surface, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  uploadName: { flex: 1, color: colors.text, fontSize: 14 },
  uploadState: { color: colors.muted, fontSize: 13 },
  progress: { flexDirection: "row", gap: 12, alignItems: "center", padding: 14, backgroundColor: colors.primarySoft, borderRadius: radius.md },
  progressText: { color: colors.primary, fontWeight: "600", fontSize: 14, flexShrink: 1 },
  genCard: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 24, gap: 16 },
  instr: { fontSize: 13, color: colors.muted, fontStyle: "italic" },
  editor: { minHeight: 400, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, fontSize: 14, fontFamily: "monospace", color: colors.text, backgroundColor: colors.bg },
  row: { flexDirection: "row", gap: 8 },
  drop: { borderWidth: 2, borderStyle: "dashed", borderColor: colors.primary, borderRadius: radius.lg, padding: 48, alignItems: "center", gap: 10, backgroundColor: colors.surface },
  dropTitle: { fontSize: 18, fontWeight: "700", color: colors.text, textAlign: "center" },
  dropSub: { fontSize: 14, color: colors.muted, textAlign: "center" },
  dragOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.overlay, alignItems: "center", justifyContent: "center", gap: 12 },
  dragText: { color: colors.primaryText, fontSize: 20, fontWeight: "700" },
  notice: { marginHorizontal: 16, marginTop: 8, padding: 10, backgroundColor: colors.okSoft, color: colors.ok, borderRadius: radius.md, fontWeight: "600" },
  error: { margin: 16, padding: 12, color: colors.danger, backgroundColor: colors.dangerSoft, borderRadius: radius.md },
});
