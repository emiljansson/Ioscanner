// File picking (Files/iCloud/OneDrive on iOS, file dialog on web) + web drag & drop.
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import type { PickedFile } from "@/src/api";

export const ACCEPTED = ["image/*", "application/pdf"];

export async function pickFiles(): Promise<PickedFile[]> {
  const res = await DocumentPicker.getDocumentAsync({ type: ACCEPTED, multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return [];
  return (res.assets ?? []).map((a) => ({
    name: a.name || "fil",
    size: a.size,
    uri: a.uri,
    mimeType: a.mimeType,
    file: (a as any).file as File | undefined,
  }));
}

/** Web-only: returns `dragging` and calls onFiles when files are dropped anywhere on the page. */
export function useDropzone(onFiles: (files: PickedFile[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "web" || !enabled || typeof window === "undefined") return;
    let depth = 0;
    const over = (e: DragEvent) => {
      e.preventDefault();
    };
    const enter = (e: DragEvent) => {
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const list = Array.from(e.dataTransfer?.files ?? []).filter(
        (f) => f.type.startsWith("image/") || f.type === "application/pdf" || /\.(pdf|heic|heif|tiff?|jpe?g|png|webp)$/i.test(f.name)
      );
      if (list.length) onFiles(list.map((f) => ({ name: f.name, size: f.size, uri: "", file: f, mimeType: f.type })));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [onFiles, enabled]);
  return dragging;
}
