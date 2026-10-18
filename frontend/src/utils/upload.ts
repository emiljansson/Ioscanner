import { Platform } from "react-native";

type FilePart = { uri?: string; blob?: Blob; name: string; mimeType?: string };

/** Multipart upload that works on web and native (expo/fetch). Never sets Content-Type. */
export async function uploadForm(
  url: string,
  opts: { headers?: Record<string, string>; fields?: Record<string, string | number>; files: Record<string, FilePart> }
): Promise<Response> {
  const form = new FormData();
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, String(v));
  for (const [field, f] of Object.entries(opts.files)) {
    let blob = f.blob;
    if (!blob && f.uri) {
      if (Platform.OS === "web") {
        blob = await (await fetch(f.uri)).blob();
      } else {
        const { fetch: expoFetch } = await import("expo/fetch");
        blob = (await (await expoFetch(f.uri)).blob()) as unknown as Blob;
      }
    }
    if (!blob) throw new Error("Filen kunde inte läsas");
    form.append(field, blob as any, f.name);
  }
  return fetch(url, { method: "POST", headers: opts.headers, body: form });
}
