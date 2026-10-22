import Storage from "expo-sqlite/kv-store";

/** 本地键值存储:手机上用 SQLite。网页预览用 storage.web.ts。 */
export const storage = {
  getItem: (k: string) => Storage.getItem(k),
  setItem: (k: string, v: string) => Storage.setItem(k, v),
  removeItem: (k: string) => Storage.removeItem(k),
};
