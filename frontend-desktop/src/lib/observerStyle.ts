// SessionNoticeBar 底部「自检失败」提示条的紫色主题：observer 判死 / 重试耗尽用它，
// 刻意用紫、不用红/琥珀——这是 agent 的自我判定，不是系统报错。
// （会话中间的 observer 卡片已移除，此主题现仅底部提示条使用。）
export const OBS_PURPLE = {
  accent: '#a855f7',                    // 图标 / 标题文字
  accentHover: '#9333ea',               // 按钮 hover 深一号紫
  border: '#c084fc',                    // 卡片左边框
  noticeBorder: 'rgba(168,85,247,.35)', // 提示条边框
  bg: 'rgba(168,85,247,.07)',           // 提示条浅底
  text: '#6b21a8',                      // 提示条正文
  badgeText: '#7c3aed',                 // 徽章 / 标题文字
  badgeBg: 'rgba(168,85,247,.12)',      // 徽章底
}
