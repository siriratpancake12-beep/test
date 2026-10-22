import { Pressable, Text } from "react-native";
import { color, s } from "../theme";

/** 一个可以点选的大卡片选项 */
export function Option({ title, sub, selected, onPress }: { title: string; sub?: string; selected?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[s.card, selected ? { borderColor: color.primary, borderWidth: 2 } : null]}>
      <Text style={s.h2}>{title}</Text>
      {!!sub && <Text style={s.sub}>{sub}</Text>}
    </Pressable>
  );
}
