// Lightweight Markdown preview: headings, lists, quotes, tables, math (raw LaTeX) and inline figures.
import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { colors } from "@/src/theme";

type Props = { markdown: string; figures?: Record<string, { url: string; caption: string }> };

function Inline({ text, style }: { text: string; style?: any }) {
  // **bold** and $math$
  const parts = text.split(/(\*\*[^*]+\*\*|\$[^$]+\$)/g).filter(Boolean);
  return (
    <Text style={style}>
      {parts.map((p, i) =>
        p.startsWith("**") ? (
          <Text key={i} style={styles.bold}>{p.slice(2, -2)}</Text>
        ) : p.startsWith("$") ? (
          <Text key={i} style={styles.math}>{p.slice(1, -1)}</Text>
        ) : (
          <Text key={i}>{p}</Text>
        )
      )}
    </Text>
  );
}

export function MarkdownView({ markdown, figures = {} }: Props) {
  const blocks = (markdown || "").replace(/<\/?(div|span|br|p|hr|center|font)\b[^>]*>/gi, "").split(/\n{2,}/);
  return (
    <View style={styles.wrap}>
      {blocks.map((block, bi) => {
        const b = block.trim();
        if (!b) return null;
        const fig = b.match(/^\[\[FIGURE:(\d+)\]\]$/) || b.match(/^!\[([^\]]*)\]\(fig:([a-f0-9]+)\)$/);
        if (fig) {
          const f = figures[fig[2] ?? `n${fig[1]}`] ?? figures[`n${fig[1]}`];
          if (!f) return null;
          return (
            <View key={bi} style={styles.figure}>
              <Image source={{ uri: f.url }} style={styles.figImg} resizeMode="contain" />
              {!!f.caption && <Text style={styles.caption}>{f.caption}</Text>}
            </View>
          );
        }
        if (b.startsWith("$$")) return <Text key={bi} style={styles.displayMath}>{b.replace(/\$\$/g, "").trim()}</Text>;
        const h = b.match(/^(#{1,4})\s+(.*)$/);
        if (h && !b.includes("\n")) {
          const lvl = h[1].length;
          return <Inline key={bi} text={h[2]} style={[styles.h, lvl === 1 ? styles.h1 : lvl === 2 ? styles.h2 : styles.h3]} />;
        }
        if (b.startsWith("|")) {
          const rows = b.split("\n").filter((r) => r.trim() && !/^\|?\s*:?-{2,}/.test(r.trim()));
          return (
            <View key={bi} style={styles.tableWrap}>
              {rows.map((r, ri) => (
                <View key={ri} style={[styles.tr, ri === 0 && styles.th]}>
                  {r.trim().replace(/^\||\|$/g, "").split("|").map((cell, ci) => (
                    <Inline key={ci} text={cell.trim()} style={[styles.td, ri === 0 && styles.bold]} />
                  ))}
                </View>
              ))}
            </View>
          );
        }
        if (b.startsWith(">")) return <Inline key={bi} text={b.replace(/^>\s?/gm, "")} style={styles.quote} />;
        if (/^([-*+]|\d+[.)])\s/.test(b)) {
          return (
            <View key={bi} style={styles.list}>
              {b.split("\n").map((line, li) => {
                const m = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
                return (
                  <View key={li} style={styles.li}>
                    <Text style={styles.bullet}>{m ? (/\d/.test(m[1]) ? m[1] : "•") : ""}</Text>
                    <Inline text={m ? m[2] : line} style={styles.p} />
                  </View>
                );
              })}
            </View>
          );
        }
        return <Inline key={bi} text={b.replace(/\n/g, " ")} style={styles.p} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  p: { fontSize: 16, lineHeight: 25, color: colors.text, flexShrink: 1 },
  bold: { fontWeight: "700" },
  math: { fontFamily: "monospace", color: colors.primary },
  displayMath: { fontFamily: "monospace", fontSize: 15, color: colors.primary, textAlign: "center", paddingVertical: 4 },
  h: { color: colors.text, fontWeight: "700" },
  h1: { fontSize: 24, lineHeight: 30 },
  h2: { fontSize: 20, lineHeight: 26 },
  h3: { fontSize: 17, lineHeight: 23 },
  tableWrap: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, overflow: "hidden" },
  tr: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.border },
  th: { backgroundColor: colors.bg, borderTopWidth: 0 },
  td: { flex: 1, padding: 8, fontSize: 14, color: colors.text },
  quote: { fontSize: 15, lineHeight: 22, color: colors.muted, borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 12, fontStyle: "italic" },
  list: { gap: 4 },
  li: { flexDirection: "row", gap: 8 },
  bullet: { fontSize: 16, lineHeight: 25, color: colors.muted, minWidth: 16 },
  figure: { alignItems: "center", gap: 6 },
  figImg: { width: "100%", height: 260, backgroundColor: colors.bg },
  caption: { fontSize: 13, color: colors.muted, fontStyle: "italic", textAlign: "center" },
});
