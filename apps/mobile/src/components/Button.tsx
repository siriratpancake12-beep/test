import { Pressable, Text } from "react-native";
import { s } from "../theme";

export function Button({ title, onPress, ghost, disabled }: { title: string; onPress: () => void; ghost?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [ghost ? s.ghost : s.btn, { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
    >
      <Text style={ghost ? s.ghostText : s.btnText}>{title}</Text>
    </Pressable>
  );
}
