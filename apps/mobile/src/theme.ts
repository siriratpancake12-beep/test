import { StyleSheet } from "react-native";

export const color = {
  bg: "#F7F7FA",
  card: "#FFFFFF",
  text: "#1C1C28",
  sub: "#6B6B80",
  primary: "#3355FF",
  good: "#1E9E5A",
  warn: "#D98A00",
  bad: "#D63B3B",
  line: "#E4E4EC",
};

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  pad: { padding: 16, gap: 12 },
  card: { backgroundColor: color.card, borderRadius: 14, padding: 16, gap: 8, borderWidth: 1, borderColor: color.line },
  h1: { fontSize: 24, fontWeight: "700", color: color.text },
  h2: { fontSize: 18, fontWeight: "600", color: color.text },
  body: { fontSize: 16, color: color.text, lineHeight: 22 },
  sub: { fontSize: 14, color: color.sub },
  target: { fontSize: 22, fontWeight: "600", color: color.text },
  btn: { backgroundColor: color.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  ghost: { borderRadius: 12, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  ghostText: { color: color.text, fontSize: 16 },
  input: { borderWidth: 1, borderColor: color.line, borderRadius: 12, padding: 12, fontSize: 18, backgroundColor: color.card },
});
