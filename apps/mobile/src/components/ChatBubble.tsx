import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { color, s } from "../theme";

/**
 * 对话气泡:课文对话、角色扮演、AI 对话共用。左边是对方,右边是学习者(或第二个说话人)。
 * 宽度按百分比,320 宽的手机上也不会超出屏幕。
 */
export function ChatBubble({ side, name, text, zh, tag, highlight, onPress, onLongPress, children }: {
  side: "left" | "right";
  /** 说话人的名字 */
  name?: string;
  text?: string;
  /** 中文翻译(要显示时才传) */
  zh?: string;
  /** 右上角的小标签,比如"AI 生成" */
  tag?: string;
  /** 正在读的这一句 */
  highlight?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  children?: ReactNode;
}) {
  const mine = side === "right";
  const style = [bubble, mine ? me : other, highlight ? { borderColor: color.primary, borderWidth: 2 } : null];
  const content = (
    <>
      {(!!name || !!tag) && (
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          {!!name && <Text style={s.sub}>{name}</Text>}
          {!!tag && <Text style={tagStyle}>{tag}</Text>}
        </View>
      )}
      {!!text && <Text style={[s.target, { fontSize: 20 }]}>{text}</Text>}
      {!!zh && <Text style={s.sub}>{zh}</Text>}
      {children}
    </>
  );
  // 不能点的气泡用普通 View:禁用的 Pressable 会把里面的按钮也标成"不可用"(读屏软件、网页上都是)
  return (
    <View style={{ alignItems: mine ? "flex-end" : "flex-start" }}>
      {onPress || onLongPress ? <Pressable onPress={onPress} onLongPress={onLongPress} style={style}>{content}</Pressable> : <View style={style}>{content}</View>}
    </View>
  );
}

const bubble = { maxWidth: "88%", borderRadius: 16, padding: 12, gap: 4, borderWidth: 1 } as const;
const other = { backgroundColor: color.card, borderColor: color.line, borderTopLeftRadius: 4 } as const;
const me = { backgroundColor: "#EEF1FF", borderColor: "#D5DCFF", borderTopRightRadius: 4 } as const;
const tagStyle = { fontSize: 11, color: color.sub, borderWidth: 1, borderColor: color.line, borderRadius: 6, paddingHorizontal: 4 } as const;
