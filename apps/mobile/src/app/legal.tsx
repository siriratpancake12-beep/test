import { router, Stack, useLocalSearchParams } from "expo-router";
import { useRef } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import { isLegalKey, LEGAL_DOCS, LEGAL_KEYS } from "../legal";
import { parseInline } from "../legal/inline";
import type { LegalBlock, LegalDoc, LegalKey } from "../legal/types";
import { color, s } from "../theme";

/**
 * 协议页:/legal?doc=terms | privacy | renewal | minors | sdk | permissions;不带 doc 是协议列表
 * (设置页的"协议与隐私"可以直接链到这里)。正文来自 docs/legal/*.md,见 src/legal/types.ts。
 * 【公司名称】这类占位符按原样显示,定稿后改 Markdown 重新生成即可。
 */
const DESC: Record<LegalKey, string> = {
  terms: "使用语途的规则,以及你和我们各自的权利和义务",
  privacy: "我们收集哪些信息、怎么使用和保护、你有哪些权利",
  renewal: "会员价格、免费试用、扣费前提醒、取消和退款",
  minors: "未满 18 周岁的用户和监护人请阅读",
  sdk: "App 里的第三方 SDK,以及会接收信息的第三方",
  permissions: "会用到哪些手机权限、什么时候申请、怎么关闭",
};

export default function Legal() {
  const { doc } = useLocalSearchParams<{ doc?: string }>();
  if (isLegalKey(doc)) return <LegalDocView key={doc} doc={LEGAL_DOCS[doc]} />;
  return <LegalIndex missing={!!doc} />;
}

function LegalIndex({ missing }: { missing: boolean }) {
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Stack.Screen options={{ title: "协议与隐私" }} />
      {missing && <Text style={[s.sub, { color: color.warn }]}>没有找到这份文件,下面是全部协议。</Text>}
      {LEGAL_KEYS.map((k) => (
        <Pressable key={k} accessibilityRole="button" onPress={() => router.push(`/legal?doc=${k}`)} style={s.card}>
          <Text style={s.h2}>{LEGAL_DOCS[k].short}</Text>
          <Text style={s.sub}>{DESC[k]}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/**
 * 长文本:标题层级 + 目录(二级标题多于 3 个时显示,点了滚到对应位置)。
 * 文首的提示(草稿、更新日期)放在目录前面。
 * 目录一直展开、不做折叠:内容排好后各标题的位置就不再变,记下的位置才准。
 */
function LegalDocView({ doc }: { doc: LegalDoc }) {
  const scroll = useRef<ScrollViewInstance>(null);
  const offsets = useRef<Record<number, number>>({});
  const toc = doc.blocks.flatMap((b, i) => (b.t === "h2" ? [{ i, text: b.text }] : []));
  const lead = doc.blocks.findIndex((b) => b.t !== "note");
  const head = lead < 0 ? doc.blocks.length : lead;

  return (
    <ScrollView ref={scroll} style={s.screen} contentContainerStyle={[s.pad, { paddingBottom: 48 }]}>
      <Stack.Screen options={{ title: doc.short }} />
      <Text style={s.h1} accessibilityRole="header">{doc.title}</Text>
      {doc.blocks.slice(0, head).map((b, i) => <BlockView key={`lead${i}`} block={b} />)}
      {toc.length > 3 && (
        <View style={[s.card, { gap: 2 }]}>
          <Text style={s.sub}>目录</Text>
          {toc.map((h) => (
            <Text key={h.i} style={st.tocItem} accessibilityRole="link"
              onPress={() => scroll.current?.scrollTo({ y: Math.max(0, (offsets.current[h.i] ?? 0) - 8), animated: true })}>
              {plain(h.text)}
            </Text>
          ))}
        </View>
      )}
      {doc.blocks.map((b, i) => i < head ? null : (
        <BlockView key={i} block={b} onLayoutY={b.t === "h2" ? (y) => { offsets.current[i] = y; } : undefined} />
      ))}
    </ScrollView>
  );
}

function BlockView({ block: b, onLayoutY }: { block: LegalBlock; onLayoutY?: (y: number) => void }) {
  switch (b.t) {
    case "h2":
      return (
        <Text style={st.h2} accessibilityRole="header" onLayout={onLayoutY && ((e) => onLayoutY(e.nativeEvent.layout.y))}>
          <Inline text={b.text} />
        </Text>
      );
    case "h3":
      return <Text style={st.h3} accessibilityRole="header"><Inline text={b.text} /></Text>;
    case "p":
      return <Text style={s.body} selectable><Inline text={b.text} /></Text>;
    case "note":
      return (
        <View style={[s.card, st.note]}>
          {b.lines.map((l, i) => <Text key={i} style={s.body} selectable><Inline text={l} /></Text>)}
        </View>
      );
    case "li":
      return (
        <View style={[st.li, b.level === 2 && st.li2]}>
          <Text style={[s.body, st.mark]}>{b.mark}</Text>
          <Text style={[s.body, st.liText]} selectable><Inline text={b.text} /></Text>
        </View>
      );
    case "table":
      // 手机上放不下多列表格:每行一张卡片,第一列当标题,其余列写成"表头:内容"
      return (
        <View style={{ gap: 8 }}>
          {b.rows.map((row, r) => (
            <View key={r} style={[s.card, st.row]}>
              <Text style={st.rowTitle} selectable><Inline text={row[0] ?? ""} /></Text>
              {row.slice(1).map((cell, c) => (
                <Text key={c} style={st.cell} selectable>
                  <Text style={st.cellHead}>{plain(b.head[c + 1] ?? "")}:</Text>
                  <Inline text={cell} />
                </Text>
              ))}
            </View>
          ))}
        </View>
      );
  }
}

/** 行内的加粗和链接。必须放在一个 <Text> 里面用,才能和前后的文字排在同一段 */
function Inline({ text }: { text: string }) {
  return (
    <Text>
      {parseInline(text).map((sp, i) =>
        sp.link ? (
          <Text key={i} style={[sp.bold && st.bold, st.link]} accessibilityRole="link" onPress={() => open(sp.link!)}>{sp.text}</Text>
        ) : (
          <Text key={i} style={sp.bold ? st.bold : undefined}>{sp.text}</Text>
        ),
      )}
    </Text>
  );
}

const plain = (text: string) => parseInline(text).map((sp) => sp.text).join("");

function open(link: string) {
  if (link.startsWith("doc:")) router.push(`/legal?doc=${link.slice(4)}`);
  else Linking.openURL(link).catch(() => {});
}

const st = StyleSheet.create({
  h2: { fontSize: 19, fontWeight: "700", color: color.text, marginTop: 12, lineHeight: 26 },
  h3: { fontSize: 16, fontWeight: "700", color: color.text, marginTop: 4, lineHeight: 22 },
  bold: { fontWeight: "700" },
  link: { color: color.primary },
  note: { borderColor: color.warn, backgroundColor: "#FFF8E8", gap: 4 },
  li: { flexDirection: "row", gap: 6 },
  li2: { paddingLeft: 22 },
  mark: { minWidth: 18, color: color.sub },
  liText: { flex: 1 },
  row: { gap: 4, padding: 12 },
  rowTitle: { fontSize: 16, fontWeight: "600", color: color.text, lineHeight: 22 },
  cell: { fontSize: 15, color: color.text, lineHeight: 21 },
  cellHead: { color: color.sub },
  tocItem: { fontSize: 15, color: color.primary, paddingVertical: 4 },
});
