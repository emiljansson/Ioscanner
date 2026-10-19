import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api, type Course, type Doc } from "@/src/api";
import { Button } from "@/src/components/ui";
import { colors, radius } from "@/src/theme";

type Hit = { document_id: string; title: string; snippet: string; page_index?: number };

function confirm(title: string, msg: string, onYes: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${msg}`)) onYes();
  } else {
    Alert.alert(title, msg, [{ text: "Avbryt", style: "cancel" }, { text: "Ta bort", style: "destructive", onPress: onYes }]);
  }
}

export default function Archive() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [newCourse, setNewCourse] = useState("");
  const [newDoc, setNewDoc] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadCourses = useCallback(async () => {
    try {
      const c = await api<Course[]>("/courses");
      setCourses(c);
      setError(null);
      setSelected((s) => (s && c.some((x) => x.id === s) ? s : wide && c[0] ? c[0].id : s));
    } catch (e: any) {
      setError(e.message);
    }
  }, [wide]);

  const loadDocs = useCallback(async (courseId: string) => {
    try {
      setDocs(await api<Doc[]>(`/documents?course_id=${courseId}`));
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  // Reload on every return to the archive, so documents deleted elsewhere disappear directly.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useFocusEffect(
    useCallback(() => {
      loadCourses();
      if (selectedRef.current) loadDocs(selectedRef.current);
    }, [loadCourses, loadDocs])
  );
  useEffect(() => {
    setDocs(null);
    if (selected) loadDocs(selected);
  }, [selected, loadDocs]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setHits(await api<Hit[]>(`/search?q=${encodeURIComponent(q.trim())}`));
      } catch (e: any) {
        setError(e.message);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const addCourse = async () => {
    if (!newCourse.trim()) return;
    const c = await api<Course>("/courses", { body: { name: newCourse.trim() } });
    setNewCourse("");
    await loadCourses();
    setSelected(c.id);
  };

  const addDoc = async () => {
    if (!newDoc.trim() || !selected) return;
    const d = await api<Doc>("/documents", { body: { course_id: selected, title: newDoc.trim() } });
    setNewDoc("");
    router.push(`/doc/${d.id}`);
  };

  const course = courses?.find((c) => c.id === selected);

  const header = (
    <>
      <View style={styles.brandRow}>
        <View style={styles.logo}>
          <Ionicons name="document-text" size={18} color={colors.primaryText} />
        </View>
        <Text style={styles.brand}>CopyThat</Text>
        <View style={{ flex: 1 }} />
        <Pressable testID="open-settings" onPress={() => router.push("/settings")} style={styles.iconBtn} accessibilityLabel="Inställningar">
          <Ionicons name="settings-outline" size={20} color={colors.text} />
        </Pressable>
      </View>
      <View style={styles.search}>
        <Ionicons name="search" size={16} color={colors.muted} />
        <TextInput
          testID="search-input"
          style={styles.searchInput}
          placeholder="Sök i hela arkivet"
          placeholderTextColor={colors.faint}
          value={q}
          onChangeText={setQ}
        />
        {!!q && (
          <Pressable onPress={() => setQ("")}>
            <Ionicons name="close-circle" size={16} color={colors.muted} />
          </Pressable>
        )}
      </View>
    </>
  );

  const sidebar = (
    <View style={[styles.sidebar, wide ? styles.sidebarWide : styles.sidebarNarrow]}>
      {header}
      <Text style={styles.section}>Kurser</Text>
      {courses === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        courses.map((c) => (
          <Pressable
            key={c.id}
            testID={`course-${c.id}`}
            onPress={() => {
              setQ("");
              setSelected(c.id);
            }}
            style={[styles.courseRow, selected === c.id && wide && styles.courseActive]}
          >
            <Ionicons name="folder-outline" size={18} color={selected === c.id && wide ? colors.primary : colors.muted} />
            <Text style={styles.courseName} numberOfLines={1}>
              {c.name}
            </Text>
            <Text style={styles.count}>{c.document_count}</Text>
          </Pressable>
        ))
      )}
      {courses?.length === 0 && <Text style={styles.empty}>Skapa din första kurs, t.ex. ”Fysik 2”.</Text>}
      <View style={styles.inlineAdd}>
        <TextInput
          testID="new-course-input"
          style={styles.addInput}
          placeholder="Ny kurs…"
          placeholderTextColor={colors.faint}
          value={newCourse}
          onChangeText={setNewCourse}
          onSubmitEditing={addCourse}
        />
        <Button testID="new-course-btn" label="Lägg till" small onPress={addCourse} disabled={!newCourse.trim()} style={{ flexShrink: 0 }} />
      </View>
    </View>
  );

  const searchResults = (
    <View style={styles.main}>
      <Text style={styles.h1}>Sökresultat</Text>
      {hits === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : hits.length === 0 ? (
        <Text style={styles.empty}>Inga träffar för ”{q}”.</Text>
      ) : (
        <FlatList
          data={hits}
          keyExtractor={(h, i) => `${h.document_id}-${i}`}
          renderItem={({ item }) => (
            <Pressable style={styles.docCard} onPress={() => router.push(`/doc/${item.document_id}`)} testID="search-hit">
              <Text style={styles.docTitle}>
                {item.title}
                {item.page_index ? ` · sida ${item.page_index}` : ""}
              </Text>
              <Text style={styles.snippet} numberOfLines={3}>
                {item.snippet}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );

  const docList = course && (
    <View style={styles.main}>
      <View style={styles.mainHeader}>
        {!wide && (
          <Pressable onPress={() => setSelected(null)} style={styles.iconBtn} accessibilityLabel="Tillbaka">
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
        )}
        <Text style={styles.h1} numberOfLines={1}>
          {course.name}
        </Text>
        <View style={{ flex: 1 }} />
        <Pressable
          testID="delete-course"
          style={styles.iconBtn}
          accessibilityLabel="Ta bort kurs"
          onPress={() =>
            confirm("Ta bort kurs?", `”${course.name}” och alla dess dokument tas bort permanent.`, async () => {
              try {
                await api(`/courses/${course.id}`, { method: "DELETE" });
              } catch (e: any) {
                if (e?.status !== 404) return setError(e.message);
              }
              setCourses((cs) => cs.filter((x) => x.id !== course.id));
              setSelected(null);
              loadCourses();
            })
          }
        >
          <Ionicons name="trash-outline" size={20} color={colors.danger} />
        </Pressable>
      </View>
      <View style={styles.inlineAdd}>
        <TextInput
          testID="new-doc-input"
          style={styles.addInput}
          placeholder="Nytt dokument, t.ex. ”Kapitel 3 – Rörelse”"
          placeholderTextColor={colors.faint}
          value={newDoc}
          onChangeText={setNewDoc}
          onSubmitEditing={addDoc}
        />
        <Button testID="new-doc-btn" label="Skapa dokument" variant="primary" icon="add" small onPress={addDoc} disabled={!newDoc.trim()} />
      </View>
      {docs === null ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
      ) : (
        <FlatList
          data={docs}
          keyExtractor={(d) => d.id}
          contentContainerStyle={{ gap: 10, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await loadDocs(course.id); setRefreshing(false); }} />}
          ListEmptyComponent={<Text style={styles.empty}>Inga dokument än. Skapa ett och ladda upp bilder eller PDF:er.</Text>}
          renderItem={({ item }) => <DocCard doc={item} onPress={() => router.push(`/doc/${item.id}`)} />}
        />
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {error && <Text style={styles.error}>{error}</Text>}
      {wide ? (
        <View style={styles.row}>
          {sidebar}
          {hits !== null || q.trim().length >= 2 ? searchResults : docList || <View style={styles.main}><Text style={styles.empty}>Välj eller skapa en kurs.</Text></View>}
        </View>
      ) : q.trim().length >= 2 ? (
        <View style={{ flex: 1 }}>
          <View style={styles.sidebar}>{header}</View>
          {searchResults}
        </View>
      ) : selected && course ? (
        docList
      ) : (
        sidebar
      )}
    </SafeAreaView>
  );
}

function DocCard({ doc, onPress }: { doc: Doc; onPress: () => void }) {
  const c = doc.page_counts ?? {};
  const pending = (c.queued ?? 0) + (c.processing ?? 0);
  return (
    <Pressable style={styles.docCard} onPress={onPress} testID={`doc-${doc.id}`}>
      <View style={styles.docRow}>
        <Ionicons name={doc.kind === "generated" ? "sparkles-outline" : "document-text-outline"} size={20} color={colors.primary} />
        <Text style={styles.docTitle} numberOfLines={1}>
          {doc.title}
        </Text>
      </View>
      <Text style={styles.meta}>
        {doc.kind === "generated"
          ? doc.status === "processing"
            ? "AI bearbetar…"
            : doc.status === "error"
              ? "Bearbetningen misslyckades"
              : "AI-bearbetat dokument"
          : `${doc.page_total ?? 0} sidor${pending ? ` · ${pending} läses` : ""}${c.error ? ` · ${c.error} fel` : ""}`}
        {"  ·  "}
        {new Date(doc.updated_at).toLocaleDateString("sv-SE")}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  row: { flex: 1, flexDirection: "row" },
  sidebar: { padding: 16, gap: 8 },
  sidebarWide: { width: 340, backgroundColor: colors.sidebar, borderRightWidth: 1, borderRightColor: colors.border },
  sidebarNarrow: { flex: 1 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  logo: { width: 32, height: 32, borderRadius: 9, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  brand: { fontSize: 20, fontWeight: "800", color: colors.text },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  search: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, minHeight: 44 },
  searchInput: { flex: 1, fontSize: 15, color: colors.text, minHeight: 42 },
  section: { fontSize: 12, fontWeight: "700", color: colors.muted, textTransform: "uppercase", marginTop: 12, letterSpacing: 0.5 },
  courseRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, minHeight: 44, borderRadius: radius.md },
  courseActive: { backgroundColor: colors.primarySoft },
  courseName: { flex: 1, fontSize: 15, color: colors.text, fontWeight: "500" },
  count: { fontSize: 13, color: colors.muted },
  inlineAdd: { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 8 },
  addInput: { flex: 1, minWidth: 0, minHeight: 40, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 15, color: colors.text, backgroundColor: colors.surface },
  main: { flex: 1, padding: 24, gap: 12, maxWidth: 1000 },
  mainHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text, flexShrink: 1 },
  docCard: { backgroundColor: colors.surface, borderRadius: radius.md, padding: 16, borderWidth: 1, borderColor: colors.border, gap: 6 },
  docRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  docTitle: { fontSize: 16, fontWeight: "600", color: colors.text, flex: 1 },
  meta: { fontSize: 13, color: colors.muted },
  snippet: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  empty: { fontSize: 15, color: colors.muted, marginTop: 8 },
  error: { margin: 12, padding: 12, color: colors.danger, backgroundColor: colors.dangerSoft, borderRadius: radius.md },
});
