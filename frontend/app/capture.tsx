// iPhone capture: camera, photo library and Files → uploads straight to the server document.
import React, { useRef, useState } from "react";
import { ActivityIndicator, Image, Linking, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  const [frozen, setFrozen] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ i: number; n: number } | null>(null);
  const insets = useSafeAreaInsets();
  // Full-screen modals can report 0 insets on first render on iOS; never go under the status bar / Dynamic Island.
  const topInset = Platform.OS === "ios" ? Math.max(insets.top, 54) : insets.top;
  const { width } = useWindowDimensions();
  const frameW = Math.min(width - 24 - 48, 420);

  const target = async () => {
    if (docId) return docId;
    const r = await api<{ document: { id: string } }>("/inbox", { method: "POST" });
    setDocId(r.document.id);
    return r.document.id;
  };

  const send = async (files: PickedFile[]) => {
    if (!files.length) {
      setBusy(false);
      setFrozen(null);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const id = await target();
      for (let i = 0; i < files.length; i++) {
        setProgress({ i: i + 1, n: files.length });
        await uploadFile(id, files[i]);
        setSent((n) => n + 1);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
      setFrozen(null);
      setProgress(null);
    }
  };

  const shoot = async () => {
    if (busy) return;
    setBusy(true); // freeze the screen immediately – taking the photo itself takes a moment
    setProgress(null);
    try {
      const photo = await cam.current?.takePictureAsync({ quality: 0.9 });
      if (!photo?.uri) throw new Error("Bilden kunde inte tas");
      setFrozen(photo.uri);
      await send([{ uri: photo.uri, name: `foto_${Date.now()}.jpg`, mimeType: "image/jpeg" }]);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
      setFrozen(null);
    }
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
      <View style={[styles.top, { paddingTop: topInset + 8 }]}>
        <Pressable onPress={done} style={styles.round} accessibilityLabel="Stäng" testID="capture-close">
          <Ionicons name="close" size={24} color={colors.primaryText} />
        </Pressable>
        <View style={styles.counter}>
          {busy && <ActivityIndicator color={colors.primaryText} size="small" />}
          <Text style={styles.counterText}>{sent} skickade</Text>
        </View>
        <Pressable onPress={done} style={styles.doneBtn} accessibilityLabel="Klar" testID="capture-done">
          <Text style={styles.doneText}>Klar</Text>
        </Pressable>
      </View>
      <View style={styles.viewport}>
        {perm?.granted ? (
          <>
            <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="back" />
            <View style={styles.frameWrap} pointerEvents="none">
              <View style={[styles.frame, { width: frameW, height: frameW * 1.414 }]}>
                <View style={[styles.corner, styles.tl]} />
                <View style={[styles.corner, styles.tr]} />
                <View style={[styles.corner, styles.bl]} />
                <View style={[styles.corner, styles.br]} />
              </View>
              <Text style={styles.frameHint}>Placera sidan inom ramen</Text>
            </View>
          </>
        ) : (
          permissionView
        )}
      </View>
      {err && <Text style={styles.err}>{err}</Text>}
      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
        <Pressable onPress={library} style={styles.round} accessibilityLabel="Välj från bildbiblioteket">
          <Ionicons name="images-outline" size={24} color={colors.primaryText} />
        </Pressable>
        <Pressable onPress={shoot} disabled={!perm?.granted || busy} style={[styles.shutter, (!perm?.granted || busy) && { opacity: 0.3 }]} accessibilityLabel="Ta bild" testID="capture-shutter">
          <View style={styles.shutterInner} />
        </Pressable>
        <Pressable onPress={async () => send(await pickFiles())} style={styles.round} accessibilityLabel="Välj från Filer">
          <Ionicons name="folder-outline" size={24} color={colors.primaryText} />
        </Pressable>
      </View>
      {busy && (
        <View style={styles.busy} testID="capture-busy">
          {frozen && <Image source={{ uri: frozen }} style={StyleSheet.absoluteFill} blurRadius={18} resizeMode="cover" />}
          <View style={styles.busyDim} />
          <ActivityIndicator size="large" color={colors.primaryText} />
          <Text style={styles.busyTitle}>Vänta …</Text>
          <Text style={styles.busySub}>
            {progress ? (progress.n > 1 ? `Sparar bild ${progress.i} av ${progress.n}` : "Sparar bilden") : "Tar bilden"}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.text },
  busy: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 14 },
  busyDim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.65)" },
  busyTitle: { color: colors.primaryText, fontSize: 30, fontWeight: "800" },
  busySub: { color: colors.primaryText, fontSize: 16, opacity: 0.9 },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12 },
  viewport: { flex: 1, marginHorizontal: 12, borderRadius: radius.lg, overflow: "hidden", backgroundColor: colors.overlay },
  frameWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 12 },
  frame: { maxHeight: "85%", borderWidth: 1, borderColor: "rgba(255,255,255,0.45)", borderRadius: 4 },
  corner: { position: "absolute", width: 28, height: 28, borderColor: colors.primaryText },
  tl: { top: -2, left: -2, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 6 },
  tr: { top: -2, right: -2, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 6 },
  bl: { bottom: -2, left: -2, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 6 },
  br: { bottom: -2, right: -2, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 6 },
  frameHint: { color: colors.primaryText, fontSize: 14, fontWeight: "600", backgroundColor: colors.overlay, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, overflow: "hidden" },
  round: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.overlay, alignItems: "center", justifyContent: "center" },
  counter: { flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: colors.overlay, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  counterText: { color: colors.primaryText, fontWeight: "700" },
  doneBtn: { backgroundColor: colors.primary, paddingHorizontal: 18, minHeight: 44, borderRadius: 22, justifyContent: "center" },
  doneText: { color: colors.primaryText, fontWeight: "700", fontSize: 16 },
  bottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingTop: 16 },
  shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: colors.primaryText, alignItems: "center", justifyContent: "center" },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: colors.primaryText },
  perm: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: 32, gap: 16 },
  permTitle: { color: colors.primaryText, fontSize: 20, fontWeight: "700", textAlign: "center" },
  permText: { color: colors.primaryText, fontSize: 15, textAlign: "center", lineHeight: 22 },
  err: { marginHorizontal: 16, padding: 12, backgroundColor: colors.dangerSoft, color: colors.danger, borderRadius: radius.md },
});
