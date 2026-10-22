/**
 * 能不能处理个人信息:同意了现在这一版《隐私政策》才行。store.tsx 读完同意记录、用户同意或撤回时设置。
 *
 * 没同意(第一次打开还没选、选了"基本功能"、协议改版后还没重新同意)时:
 * - api() 不发任何请求(不联网):登录、同步、埋点上传、AI 对话都发不出去;发音评测也不上传;
 * - 不申请通知、麦克风权限(notify.ts、Recorder.tsx 会先看这里)。
 * 页面上的提示("同意隐私政策后可用")是给人看的;这里是最后一道保险,哪个页面漏了判断也不会联网、不会弹权限。
 */
let allowed = false;

export const setPersonalInfoAllowed = (on: boolean) => {
  allowed = on;
};

export const personalInfoAllowed = () => allowed;
