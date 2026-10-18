// Modal editor for a figure crop: drag the two corner handles over the page image.
import React, { useMemo, useRef, useState } from "react";
import { Image, Modal, PanResponder, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Button } from "@/src/components/ui";
import { colors, radius } from "@/src/theme";

type Props = {
  visible: boolean;
  imageUrl: string;
  imgW: number;
  imgH: number;
  initialBox?: number[]; // [ymin, xmin, ymax, xmax] 0-1000
  onCancel: () => void;
  onSave: (box: number[]) => Promise<void>;
};

export function CropEditor({ visible, imageUrl, imgW, imgH, initialBox, onCancel, onSave }: Props) {
  const { width, height } = useWindowDimensions();
  const maxW = Math.min(width - 48, 820);
  const maxH = height - 220;
  const scale = Math.min(maxW / imgW, maxH / imgH);
  const W = imgW * scale;
  const H = imgH * scale;
  const [box, setBox] = useState<number[]>(initialBox ?? [250, 250, 750, 750]);
  const [saving, setSaving] = useState(false);
  const boxRef = useRef(box);
  boxRef.current = box;

  const makeHandle = (corner: "tl" | "br") =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useMemo(() => {
      let start: number[] = [];
      return PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          start = [...boxRef.current];
        },
        onPanResponderMove: (_e, g) => {
          const dy = (g.dy / H) * 1000;
          const dx = (g.dx / W) * 1000;
          const b = [...start];
          if (corner === "tl") {
            b[0] = Math.max(0, Math.min(b[2] - 20, start[0] + dy));
            b[1] = Math.max(0, Math.min(b[3] - 20, start[1] + dx));
          } else {
            b[2] = Math.min(1000, Math.max(b[0] + 20, start[2] + dy));
            b[3] = Math.min(1000, Math.max(b[1] + 20, start[3] + dx));
          }
          setBox(b);
        },
      });
    }, [corner]);

  const tl = makeHandle("tl");
  const br = makeHandle("br");
  const [ymin, xmin, ymax, xmax] = box;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Justera bildutklipp</Text>
          <Text style={styles.hint}>Dra i hörnen för att markera bilden.</Text>
          <View style={{ width: W, height: H }}>
            <Image source={{ uri: imageUrl }} style={{ width: W, height: H }} />
            <View
              pointerEvents="none"
              style={[styles.box, { top: (ymin / 1000) * H, left: (xmin / 1000) * W, width: ((xmax - xmin) / 1000) * W, height: ((ymax - ymin) / 1000) * H }]}
            />
            <View {...tl.panHandlers} style={[styles.handle, { top: (ymin / 1000) * H - 14, left: (xmin / 1000) * W - 14 }]} testID="crop-handle-tl" />
            <View {...br.panHandlers} style={[styles.handle, { top: (ymax / 1000) * H - 14, left: (xmax / 1000) * W - 14 }]} testID="crop-handle-br" />
          </View>
          <View style={styles.actions}>
            <Button label="Avbryt" onPress={onCancel} />
            <Button
              testID="crop-save"
              label="Spara utklipp"
              variant="primary"
              loading={saving}
              onPress={async () => {
                setSaving(true);
                try {
                  await onSave(box.map((v) => Math.round(v)));
                } finally {
                  setSaving(false);
                }
              }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.overlay, alignItems: "center", justifyContent: "center", padding: 16 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: 16, gap: 12, alignItems: "center" },
  title: { fontSize: 18, fontWeight: "700", color: colors.text },
  hint: { fontSize: 13, color: colors.muted },
  box: { position: "absolute", borderWidth: 2, borderColor: colors.cropBox, backgroundColor: colors.cropFill },
  handle: { position: "absolute", width: 28, height: 28, borderRadius: 14, backgroundColor: colors.cropBox, borderWidth: 3, borderColor: colors.surface },
  actions: { flexDirection: "row", gap: 12, alignSelf: "flex-end" },
});
