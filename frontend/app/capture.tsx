// iPhone capture: camera, photo library and Files → uploads straight to the server document.
import React, { useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { api, uploadFile, type PickedFile } from "@/src/api";
import { pickFiles } from "@/src/files";
import { Button } from "@/src/components/ui";
import { colors, radius } from "@/src/theme";

export default function Capture() {
  const { doc } = useLocalSearchParams<{ doc?: string }>();
  const router = useRouter();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [sent, setSent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(doc ?? null);

  const target = async () => {
    if (docId) return docId;
    const r = await api<{ document: { id: string } }>("/inbox", { method: "POST" });
    setDocId(r.document.id);
    return r.document.id;
  };

  const send = async (files: PickedFile[]) => {
    if (!files.length) return;
    setBusy(true);
    setErr(null);
    try {
      const id = await target();
      for (const f of files) {
        await uploadFile(id, f);
        setSent((n) => n + 1);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const shoot = async () => {
    const photo = await cam.current?.takePictureAsync({ quality: 0.9 });
    if (photo?.uri) send([{ uri: photo.uri, name: `foto_${Date.now()}.jpg`, mimeType: "image/jpeg" }]);
  };

  const library = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 50, quality: 1 });
    if (!r.canceled) send(r.assets.map((a, i) => ({ uri: a.uri, name: a.fileName ?? `bild_${i + 1}.jpg`, mimeType: a.mimeType ?? "image/jpeg" })));
  };

  const done = () => (docId ? router.replace(`/doc/${docId}`) : router.back());

  const permissionView = !perm ? null : !perm.granted ? (
    <View style={styles.perm}>
      <Ionicons name="camera-outline" size={48} color={colors.primaryText} />
      <Text style={styles.permTitle}>Fotografera ditt studiematerial</Text>
      <Text style={styles.permText}>CopyThat behöver kameran för att fota sidor som AI:n sedan läser av. Du kan också välja bilder eller filer nedan.</Text>
      {perm.canAskAgain ? (
        <Button label="Tillåt kamera" variant="primary" onPress={requestPerm} />
      ) : (
        <Button label="Öppna Inställningar" variant="primary" icon="settings-outline" onPress={() => Linking.openSettings()} />
      )}
    </View>
  ) : null;

  return (
    <View style={styles.root}>
      {perm?.granted ? <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="back" /> : permissionView}
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.top}>
          <Pressable onPress={done} style={styles.round} accessibilityLabel="Stäng" testID="capture-close">
            <Ionicons name="close" size={24} color={colors.primaryText} />
          </Pressable>
          <View style={styles.counter}>
            {busy && <ActivityIndicator color={colors.primaryText} size="small" />}
            <Text style={styles.counterText}>{sent} skickade</Text>
          </View>
          <Pressable onPress={done} style={styles.doneBtn} accessibilityLabel="Klar">
            <Text style={styles.doneText}>Klar</Text>
          </Pressable>
        </View>
        {err && <Text style={styles.err}>{err}</Text>}
        <View style={styles.bottom}>
          <Pressable onPress={library} style={styles.round} accessibilityLabel="Välj från bildbiblioteket">
            <Ionicons name="images-outline" size={24} color={colors.primaryText} />
          </Pressable>
          <Pressable onPress={shoot} disabled={!perm?.granted} style={[styles.shutter, !perm?.granted && { opacity: 0.3 }]} accessibilityLabel="Ta bild">
            <View style={styles.shutterInner} />
          </Pressable>
          <Pressable onPress={async () => send(await pickFiles())} style={styles.round} accessibilityLabel="Välj från Filer">
            <Ionicons name="folder-outline" size={24} color={colors.primaryText} />
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.text },
  overlay: { flex: 1, justifyContent: "space-between" },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 },
  round: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.overlay, alignItems: "center", justifyContent: "center" },
  counter: { flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: colors.overlay, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  counterText: { color: colors.primaryText, fontWeight: "700" },
  doneBtn: { backgroundColor: colors.primary, paddingHorizontal: 18, minHeight: 44, borderRadius: 22, justifyContent: "center" },
  doneText: { color: colors.primaryText, fontWeight: "700", fontSize: 16 },
  bottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingBottom: 24 },
  shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: colors.primaryText, alignItems: "center", justifyContent: "center" },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: colors.primaryText },
  perm: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: 32, gap: 16 },
  permTitle: { color: colors.primaryText, fontSize: 20, fontWeight: "700", textAlign: "center" },
  permText: { color: colors.primaryText, fontSize: 15, textAlign: "center", lineHeight: 22 },
  err: { marginHorizontal: 16, padding: 12, backgroundColor: colors.dangerSoft, color: colors.danger, borderRadius: radius.md },
});
