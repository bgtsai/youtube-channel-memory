# YouTube Channel Memory

Tampermonkey userscript that remembers playback speed and caption on/off **per YouTube channel**.

依頻道記住 YouTube 播放速度與字幕開關的 Tampermonkey 腳本。

## Features / 功能

- Per-channel playback speed (keyed by `@handle`) — 依頻道記住播放速度
- Per-channel captions on/off — 依頻道記住字幕開關
- Collab videos with multiple credited channels — 支援多頻道合作影片
- Audio boost with limiter — 音量增益（含限幅器避免爆音）
- Speed-adjusted remaining time — 依目前倍速換算的實際時間
- Optional start-paused for newly opened videos — 新開影片先暫停（播放清單接續不受影響）
- Fullscreen when you press Play, auto-exit near the end; no extra browser setup — 按下播放即全螢幕、片尾自動退出，免設定
- Thin bottom progress bar whenever player controls are hidden (incl. fullscreen) — 控制列隱藏時的底部細進度條（含全螢幕）
- Optional hiding of live chat — 可隱藏直播聊天室
- Settings panel: colors, speed buttons, custom language — 設定面板：顏色、速度按鈕、自訂語系

## Install / 安裝

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [YouTube_Channel_Memory.user.js (raw)](https://raw.githubusercontent.com/bgtsai/youtube-channel-memory/main/YouTube_Channel_Memory.user.js) and confirm installation.

Open the settings from the sliders icon on the player bar, or the Tampermonkey menu → **Settings**.

## License

[MIT](LICENSE)
