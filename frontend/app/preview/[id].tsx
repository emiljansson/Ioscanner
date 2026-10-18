import React from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { WordPreview } from "@/src/components/WordPreview";

// Regular stack screen (not an RN Modal) so the iOS share sheet's "Spara i Filer" can present.
export default function PreviewScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const router = useRouter();
  return (
    <WordPreview
      docId={id!}
      title={title ?? ""}
      onClose={() => (router.canGoBack() ? router.back() : router.replace(`/doc/${id}`))}
    />
  );
}
