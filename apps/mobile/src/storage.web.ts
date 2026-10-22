/** 网页预览(给团队看界面、跑自动化测试)用浏览器的 localStorage。 */
export const storage = {
  getItem: async (k: string) => localStorage.getItem(k),
  setItem: async (k: string, v: string) => localStorage.setItem(k, v),
  removeItem: async (k: string) => localStorage.removeItem(k),
};
