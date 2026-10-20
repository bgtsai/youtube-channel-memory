# YouTube Channel Memory

Tampermonkey userscript that remembers playback speed and caption on/off **per YouTube channel**.

依頻道記住 YouTube 播放速度與字幕開關的 Tampermonkey 腳本。

## Features / 功能

- Per-channel playback speed (keyed by `@handle`) — 依頻道記住播放速度
- Per-channel captions on/off — 依頻道記住字幕開關
- Collab videos with multiple credited channels — 支援多頻道合作影片
- Audio boost with limiter — 音量增益（含限幅器避免爆音）
- Speed-adjusted remaining time — 依目前倍速換算的實際時間
- Optional auto-fullscreen on play / auto-exit near the end (AutoHotkey fallback) — 自動全螢幕／片尾自動退出（可搭配 AHK）
- Settings panel: colors, speed buttons, custom language — 設定面板：顏色、速度按鈕、自訂語系

## Install / 安裝

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [YouTube_Channel_Memory.user.js (raw)](https://raw.githubusercontent.com/bgtsai/youtube-channel-memory/main/YouTube_Channel_Memory.user.js) and confirm installation.

Open the settings from the Tampermonkey menu → **Settings**.

## License

[MIT](LICENSE)
