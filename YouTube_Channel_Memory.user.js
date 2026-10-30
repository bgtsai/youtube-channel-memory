// ==UserScript==
// @name         YouTube Channel Memory
// @namespace    YouTubeChannelMemory
// @version      1.4.0
// @description  Per-channel playback speed and subtitle preferences, with audio boost, real-time duration display, start-paused, fullscreen on play / auto-exit near the end, bottom progress bar, hide live chat, and custom language editor.
// @author       bgtsai
// @match        https://www.youtube.com/*
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.deleteValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @license      MIT
// @homepageURL  https://github.com/bgtsai/youtube-channel-memory
// @updateURL    https://raw.githubusercontent.com/bgtsai/youtube-channel-memory/main/YouTube_Channel_Memory.user.js
// @downloadURL  https://raw.githubusercontent.com/bgtsai/youtube-channel-memory/main/YouTube_Channel_Memory.user.js
// ==/UserScript==

/**
 * YouTube Channel Memory
 * ======================
 * MIT License
 *
 * Copyright (c) 2025 bgtsai
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Acknowledgements
 * ─────────────────────────────────────────────────────────────────────────────
 * The idea of remembering playback speed was inspired by:
 *
 *   ElectroKnight22 — Youtube Remember Speed
 *   https://greasyfork.org/en/scripts/503771-youtube-remember-speed
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature Overview
 * ─────────────────────────────────────────────────────────────────────────────
 *   • Remembers playback speed per YouTube channel (identified by @handle).
 *   • Remembers caption (subtitle) on/off state per channel.
 *   • Supports collaborative videos with multiple channel credits.
 *   • Audio boost with soft limiter to prevent clipping.
 *   • Optional relative time display (adjusts for current playback speed).
 *   • Optionally starts new videos paused; enters fullscreen when you press Play, exits near the end.
 *   • Thin bottom progress bar whenever the player controls are hidden; optional live-chat hiding.
 *   • Full settings panel with color picker and button template editor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Fullscreen and the browser's user-activation rule
 * ─────────────────────────────────────────────────────────────────────────────
 * Browsers only grant requestFullscreen() shortly after a real click or key
 * press. Auto-fullscreen therefore runs on the 'play' event that follows the
 * user's own Play press (see the START-PAUSED / FULLSCREEN section), which
 * works in Chrome, Edge and Firefox without any extra configuration.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Developer Notes
 * ─────────────────────────────────────────────────────────────────────────────
 *   Storage keys: all user preferences are stored under the "_YSC-" prefix
 *   (e.g. "_YSC-DEFAULT_SPEED"). Per-channel speed is stored under the channel
 *   @handle (e.g. "@ChannelName"), and caption state under "@ChannelName_captions".
 *   Custom language data is stored under "_YSC-CUSTOM_LANG" (JSON array format),
 *   the language code under "_YSC-CUSTOM_LANG_CODE", and the enable flag under
 *   "_YSC-USE_CUSTOM_LANG".
 *
 *   Localisation: all UI strings live in the LANGS object near the top of the
 *   IIFE. To add a language, add a new key to LANGS whose name matches the
 *   document.documentElement.lang value (lowercased, hyphens → underscores),
 *   e.g. 'ja' for Japanese. No logic code requires editing.
 *   The active locale is selected automatically by detectLang() at runtime.
 *
 *   YouTube is a SPA (Single-Page Application). Navigation between videos does
 *   not reload the page. The script handles this via:
 *     - A MutationObserver on ytd-watch-flexy[video-id] (onWatchVideoIdChange)
 *     - A polling loop (pollForPlayers) as a safety net for initial mount
 *
 *   The ycm-bar div is inserted into .ytp-right-controls and carries
 *   data-attribute "ycm-video" linking it to the <video> element.
 */

(async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // EARLY PLAY HOLD (must stay above every `await`)
    //
    // The settings below are read with ~20 sequential `await GM.getValue` calls.
    // Registering the play listener after them let YouTube start playback first;
    // the video then played for ~0.5–1 s until a later play() call was caught.
    // So the capture listener is attached here, synchronously, and START_PAUSED
    // is read with the synchronous GM_getValue (same storage as GM.setValue).
    // Everything that needs the full settings waits for _ycmReady.
    // ─────────────────────────────────────────────────────────────────────────
    const _ycmT0 = performance.now();
    /** Timeline log for start-paused / auto fullscreen diagnostics. */
    const _fsLog = msg => console.log(`YSC fs: +${Math.round(performance.now() - _ycmT0)}ms ${msg}`);
    let _ycmReady = false;                       // full settings loaded
    const _earlyStartPaused = (typeof GM_getValue === 'function') ? !!GM_getValue('_YSC-START_PAUSED', false) : null;
    _fsLog(`play hold listener attached (start paused = ${_earlyStartPaused === null ? 'unknown' : _earlyStartPaused})`);

    /** Timestamp (performance.now) of the most recent trusted pointer/key input. */
    let _lastUserInput = -Infinity;
    for (const type of ['pointerdown', 'keydown']) {
        document.addEventListener(type, e => { if (e.isTrusted) _lastUserInput = performance.now(); }, true);
    }

    /** Hold state: while armed, playback that the user did not start is paused. */
    const _playHold = { armed: true, since: performance.now() };

    // Page-load completion for the CURRENT video. YouTube re-initialises the
    // watch page on yt-navigate-finish (dropping its fullscreen layout), so
    // auto fullscreen waits for it. Keyed by video id so a finish left over
    // from the previous page does not count.
    let _navFinishedFor = null;
    const _currentVideoKey = () => new URLSearchParams(location.search).get('v') || location.pathname;
    document.addEventListener('yt-navigate-finish', () => {
        _navFinishedFor = _currentVideoKey();
        _fsLog('page load finished (yt-navigate-finish) for ' + _navFinishedFor);
    });
    document.addEventListener('yt-navigate-start', () => { _navFinishedFor = null; });

    document.addEventListener('yt-navigate-start', () => {
        // A navigation right after user input is the user opening a video;
        // one without input is a playlist / autoplay-next continuation.
        const byUser = performance.now() - _lastUserInput < 3000;
        _playHold.armed = byUser;
        _playHold.since = performance.now();
        _fsLog('yt-navigate-start, play hold ' + (byUser ? 'armed' : 'released (autoplay)'));
    });

    /** True if the user pressed something after the hold was armed, within `ms`. */
    function _userStartedPlayback(ms = 1500) {
        return _lastUserInput > _playHold.since && performance.now() - _lastUserInput < ms;
    }

    /** START_PAUSED: the loaded setting once available, else the early synchronous read. */
    function _startPausedOn() {
        return _ycmReady ? !!window['START_PAUSED'] : !!_earlyStartPaused;
    }

    /** True if playback of `el` should be held: main player, Start Paused on, no recent user input. */
    function _shouldHold(el) {
        return !!el && el.tagName === 'VIDEO' && !!el.closest('#movie_player, #c4-player')
            && _startPausedOn() && _playHold.armed && !_userStartedPlayback();
    }

    // ── Source-level block ─────────────────────────────────────────────────
    // Pausing in the 'play' event is too late by a few milliseconds: audio has
    // already started, so a short sound leaks. Instead, replace play() in the
    // PAGE's world (the sandbox cannot see YouTube's own call) and, while the
    // hold is armed, reject it with NotAllowedError — exactly what the browser
    // returns when its autoplay policy blocks a video. YouTube already handles
    // that case and shows the paused state with a play button, so its UI stays
    // consistent. A real click/key press releases the hold and the original
    // play() runs. Firefox needs exportFunction to expose the hook to the page.
    // If the hook cannot be installed, the 'play' listener below still pauses.
    const _pageWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    let _playHook = 'not installed';
    try {
        const proto = _pageWin.HTMLMediaElement.prototype;
        const origPlay = proto.play;
        const hook = function () {
            if (_shouldHold(this)) {
                _fsLog('start paused: blocked play() at the source');
                return _pageWin.Promise.reject(new _pageWin.DOMException('Blocked by YouTube Channel Memory (Start New Videos Paused)', 'NotAllowedError'));
            }
            return origPlay.apply(this, arguments);
        };
        if (typeof exportFunction === 'function') {
            exportFunction(hook, proto, { defineAs: 'play' });
            _playHook = 'installed (exportFunction)';
        } else {
            proto.play = hook;
            _playHook = 'installed';
        }
    } catch (e) {
        _playHook = 'failed: ' + e.message;
    }
    _fsLog('play() hook ' + _playHook);

    document.addEventListener('play', e => {
        const video = e.target;
        if (!(video instanceof HTMLVideoElement) || !video.closest('#movie_player, #c4-player')) return;

        const byUser = _userStartedPlayback();
        if (_startPausedOn() && _playHold.armed && !byUser) {
            // Only reached when play() got past the source-level hook.
            video.pause();
            _fsLog(`start paused: play() reached the browser (hook ${_playHook}); paused at ${video.currentTime.toFixed(2)}s`);
            return;
        }
        _fsLog(`play (${byUser ? 'by user' : 'not by user'}) at ${video.currentTime.toFixed(2)}s`);
        if (byUser) _playHold.armed = false;
        if (_ycmReady) tryAutoFullscreen(video);
    }, true);

    // ─────────────────────────────────────────────────────────────────────────
    // LANGUAGE BLOCK
    // To add a new language, copy this object, replace the string values, and
    // set it as the active LANG. No other code changes are needed.
    // ─────────────────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────
    // LOCALISATION
    //
    // To add a new language: add a new key under LANGS whose name matches the
    // value of document.documentElement.lang (lowercased, hyphens → underscores).
    // e.g. 'ja' for Japanese, 'ko' for Korean, 'zh_cn' for Simplified Chinese.
    //
    // detectLang() will automatically pick the right entry, falling back first
    // to a prefix match (zh_tw → zh) and finally to 'en'.
    // ─────────────────────────────────────────────────────────────────────────
    const LANGS = {

        en: {
            // Greasemonkey / Tampermonkey menu entry
            menuSettings:            'Settings',

            // Settings panel — title and section headers
            panelTitle:              'YouTube Channel Memory',
            sectionPlayback:         'Playback',
            sectionDisplay:          'Display',
            sectionAutomation:       'Automation',
            sectionSpeedButtons:     'Speed Buttons',
            sectionLanguage:         'Language',

            // Settings panel — row labels
            labelDefaultSpeed:       'Default Speed',
            labelDefaultSpeedSub:    'Rate for new videos',
            labelAudioBoost:         'Audio Boost',
            labelAudioBoostSub:      '1 = disabled',
            labelShowRelTime:        'Show Relative Time',
            labelColorSelected:      'Current Speed',
            labelColorNormal:        'Other Speeds',
            labelColorSub:           'Color of text buttons',
            cpDragHint:              'Drag to move',
            fsLayoutHint:            'YouTube did not switch to video fullscreen — press Esc to leave',
            labelStartPaused:        'Start New Videos Paused',
            labelStartPausedSub:     'Playlists and autoplay-next keep playing',
            labelFsProgress:         'Bottom Progress Bar',
            labelFsProgressSub:      'Thin bar whenever player controls are hidden',
            labelHideChat:           'Hide Live Chat',
            labelAutoFullscreenOnPlay:     'Fullscreen When I Press Play',
            labelAutoFullscreenOnEnd:      'Auto Exit Fullscreen on End',
            fsNoteOk:                'With Start New Videos Paused on, fullscreen triggers when you press Play — no browser setup needed.',
            fsNoteHint:              'Turn on Start New Videos Paused as well; otherwise videos that start by themselves need a browser setting.',
            fsNoteWarn:              '⚠ Start New Videos Paused is off: videos that start by themselves cannot go fullscreen until you change a browser setting — otherwise it will look broken.',
            labelAutoFullscreenLink: 'How to set up',
            fsHelpTitle:             'About Auto Fullscreen',
            fsHelpDesc:              'Browsers only allow fullscreen right after you click or press a key.',
            fsHelpBody:              '<p>Fullscreen is entered the moment you press Play, so Chrome, Edge and Firefox need no extra settings.</p><p>Pair it with <b>Start New Videos Paused</b>: every video then starts with your own Play press, so fullscreen always triggers.</p><p>Videos that start on their own (autoplay-next, or with Start Paused off) cannot go fullscreen unless the browser allows it:</p><ul><li>Firefox: in <code>about:config</code> set <code>full-screen-api.allow-trusted-requests-only</code> to <code>false</code>.</li><li>Chrome / Edge: the enterprise policy <code>AutomaticFullscreenAllowedForUrls</code> with <code>https://www.youtube.com</code>.</li></ul>',
            labelButtonTemplates:    'Button Templates',
            labelBtnEdit:            'Edit…',

            // Settings panel — footer buttons
            btnCancel:               'Cancel',
            btnSave:                 'Save',

            // Danger zone (inside settings panel)
            dangerZoneLabel:         '⚠ Danger Zone',
            dangerZoneDesc:          'Resets every setting to its default. Speeds and captions saved for each channel are kept. This cannot be undone.',
            btnRestoreDefault:       'Restore Default',

            // Restore-defaults confirmation dialog
            rdTitle:                 '⚠ Restore Defaults',
            rdSub:                   'This will permanently reset all settings.\nThis action cannot be undone.',
            rdItemSpeed:             'Default Speed & Audio Boost',
            rdItemTemplates:         'Button Templates',
            rdItemColors:            'Selected & Normal colors',
            rdItemRelTime:           'Show Relative Time',
            rdItemFullscreen:        'Auto Fullscreen on Play & on End',
            rdItemExtras:            'Start Paused, Bottom Progress Bar & Hide Live Chat',
            rdBtnCancel:             'Cancel',
            rdBtnConfirm:            'Restore',

            // Button Templates editor
            btTitle:                 'Button Templates',
            btSubtitle:              'Drag ⠿ to reorder',
            btSortNote:              'Buttons are sorted by speed (slowest first) when you save.',
            btDupSpeed:              'Two buttons have the same speed — change or remove one',
            btColLabel:              'Label',
            btColSpeed:              'Speed',
            btBtnAdd:                '+ Add Button',
            btBtnCancel:             'Cancel',
            btBtnSave:               'Save',
            btPlaceholderLabel:      'Label',
            btPlaceholderSpeed:      '1.0',

            // Player control bar buttons
            playerSetTitle:          'Set current speed and captions as default for this channel',
            playerSavedToast:        'Saved: {speed} · Captions {cc}',
            playerPillTitle:         'Default captions for this channel: {cc} (click to change)',
            playerPillToast:         'Saved: Captions {cc}',
            playerCCTitle:           'Subtitles/closed captions',
            playerPrefsTitle:        'YouTube Channel Memory settings',
            playerCCStateOn:         'on',
            playerCCStateOff:        'off',
            playerCCStateNone:       'not set',

            // Settings panel — Custom Language row
            labelUiLang:             'Interface Language',
            labelCustomLangRow:      'Custom Language',
            labelCustomLangRowSub:   'Create other languages here',
            optLangAuto:             'Auto (follow YouTube)',
            labelCustomLang:         'Custom',

            // Custom Language editor
            clTitle:                 'Custom Language',
            clLangCodeLabel:         'Language code',
            clLangCodePlaceholder:   'e.g. zh, ja, ko',
            clColRef:                'English (reference)',
            clColTranslation:        'Translation',
            clBtnClearAll:           'Clear All',
            clBtnImport:             'Import',
            clBtnExport:             'Export',
            clBtnCancel:             'Cancel',
            clBtnSave:               'Save',

            // Restore defaults — custom language note
            rdCustomLangNote:        'Your custom language data will not be affected.',

            // Import validation dialog
            clImportTitle:           'Language File Imported',
            clImportUnknown:         'Unknown keys — ignored',
            clImportMissing:         'Missing keys — English will be used instead',
            clImportSafeNote:        'This will not affect normal usage.',
            clImportOkBtn:           'OK',
            clImportErrorTitle:      'Import Failed',
            clImportErrorDesc:       'The file could not be read. Please check that it is a valid JSON language file.',

            // Clear All — step 1 (export prompt)
            clClearStep1Title:       'Export before clearing?',
            clClearStep1Desc:        'Your translation data will be permanently deleted. Would you like to export a backup first?',
            clClearExportBtn:        'Export & Continue',
            clClearSkipBtn:          'Just Clear',
            clClearCancelBtn:        'Cancel',

            // Clear All — step 2 (final confirm)
            clClearStep2Title:       '⚠ Clear Custom Language',
            clClearStep2Desc:        'This will permanently delete all your translation data. This action cannot be undone.',
            clClearConfirmBtn:       'Clear All',
        },

        zh_tw: {
            // Greasemonkey / Tampermonkey 選單項目
            menuSettings:            '設定',

            // 設定面板 — 標題與區塊標題
            panelTitle:              'YouTube 頻道記憶',
            sectionPlayback:         '播放',
            sectionDisplay:          '顯示',
            sectionAutomation:       '自動化',
            sectionSpeedButtons:     '速度按鈕',
            sectionLanguage:         '語言',

            // 設定面板 — 欄位標籤
            labelDefaultSpeed:       '預設速度',
            labelDefaultSpeedSub:    '新影片的播放倍率',
            labelAudioBoost:         '音量增強',
            labelAudioBoostSub:      '1 = 停用',
            labelShowRelTime:        '顯示實際時間',
            labelColorSelected:      '目前倍速',
            labelColorNormal:        '其他倍速',
            labelColorSub:           '文字按鈕的顏色',
            cpDragHint:              '拖曳以移動',
            fsLayoutHint:            'YouTube 沒有切換成影片全螢幕，按 Esc 離開',
            labelStartPaused:        '開啟新影片時先暫停',
            labelStartPausedSub:     '播放清單與自動播放下一部不受影響',
            labelFsProgress:         '底部細進度條',
            labelFsProgressSub:      '播放器控制列隱藏時顯示（含全螢幕）',
            labelHideChat:           '隱藏直播聊天室',
            labelAutoFullscreenOnPlay:     '按下播放時自動全螢幕',
            labelAutoFullscreenOnEnd:      '結束時自動退出全螢幕',
            fsNoteOk:                '已開啟「開啟新影片時先暫停」：按下播放即可全螢幕，瀏覽器不需額外設定。',
            fsNoteHint:              '請搭配「開啟新影片時先暫停」；否則影片自己開始播放時，需到瀏覽器做額外設定。',
            fsNoteWarn:              '⚠ 未開啟「開啟新影片時先暫停」：影片自己開始播放時無法全螢幕，必須到瀏覽器做額外設定，否則看起來會像功能失效。',
            labelAutoFullscreenLink: '設定方法',
            fsHelpTitle:             '自動全螢幕說明',
            fsHelpDesc:              '瀏覽器只允許在你點擊或按鍵之後進入全螢幕。',
            fsHelpBody:              '<p>本腳本在你按下播放的那一刻進入全螢幕，所以 Chrome、Edge、Firefox 都不需要額外設定。</p><p>建議搭配<b>「開啟新影片時先暫停」</b>：每支影片都由你按下播放，全螢幕就一定能觸發。</p><p>自己開始播放的影片（自動播放下一部，或沒開「先暫停」時）無法進入全螢幕，除非瀏覽器允許：</p><ul><li>Firefox：在 <code>about:config</code> 把 <code>full-screen-api.allow-trusted-requests-only</code> 設為 <code>false</code>。</li><li>Chrome／Edge：企業政策 <code>AutomaticFullscreenAllowedForUrls</code> 加入 <code>https://www.youtube.com</code>。</li></ul>',
            labelButtonTemplates:    '速度按鈕範本',
            labelBtnEdit:            '編輯…',

            // 設定面板 — 底部按鈕
            btnCancel:               '取消',
            btnSave:                 '儲存',

            // 危險區域（設定面板內）
            dangerZoneLabel:         '⚠ 危險區域',
            dangerZoneDesc:          '將所有設定恢復為預設值；各頻道已儲存的速度與字幕不會被刪除。此操作無法復原。',
            btnRestoreDefault:       '恢復預設值',

            // 恢復預設值確認對話框
            rdTitle:                 '⚠ 恢復預設值',
            rdSub:                   '這將永久重置所有設定。\n此操作無法復原。',
            rdItemSpeed:             '預設速度與音量增強',
            rdItemTemplates:         '速度按鈕範本',
            rdItemColors:            '已選取與一般顏色',
            rdItemRelTime:           '顯示實際時間',
            rdItemFullscreen:        '自動全螢幕（播放 / 結束）',
            rdItemExtras:            '先暫停、底部細進度條、隱藏直播聊天室',
            rdBtnCancel:             '取消',
            rdBtnConfirm:            '恢復',

            // 速度按鈕範本編輯器
            btTitle:                 '速度按鈕範本',
            btSubtitle:              '拖動 ⠿ 排序',
            btSortNote:              '存檔時會依速度由小到大自動排序。',
            btDupSpeed:              '有兩個按鈕的速度相同，請修改或刪除其中一個',
            btColLabel:              '標籤',
            btColSpeed:              '速度',
            btBtnAdd:                '+ 新增按鈕',
            btBtnCancel:             '取消',
            btBtnSave:               '儲存',
            btPlaceholderLabel:      '標籤',
            btPlaceholderSpeed:      '1.0',

            // 播放器控制列按鈕
            playerSetTitle:          '將目前速度與字幕設為此頻道的預設值',
            playerSavedToast:        '已儲存：{speed}・字幕{cc}',
            playerPillTitle:         '此頻道的預設字幕：{cc}（點擊切換並儲存）',
            playerPillToast:         '已儲存：字幕{cc}',
            playerCCTitle:           '字幕',
            playerPrefsTitle:        'YouTube 頻道記憶設定',
            playerCCStateOn:         '開',
            playerCCStateOff:        '關',
            playerCCStateNone:       '未設定',

            // 設定面板 — 自訂語系列
            labelUiLang:             '介面語言',
            labelCustomLangRow:      '自訂語系',
            labelCustomLangRowSub:   '其他語言在這裡建立',
            optLangAuto:             '自動（跟隨 YouTube）',
            labelCustomLang:         '自訂語系',

            // 自訂語系編輯器
            clTitle:                 '自訂語系',
            clLangCodeLabel:         '語言代號',
            clLangCodePlaceholder:   '例如 zh、ja、ko',
            clColRef:                '英文（參考）',
            clColTranslation:        '翻譯',
            clBtnClearAll:           '清除全部',
            clBtnImport:             '匯入',
            clBtnExport:             '匯出',
            clBtnCancel:             '取消',
            clBtnSave:               '儲存',

            // 恢復預設值 — 自訂語系說明
            rdCustomLangNote:        '您的自訂語系資料不受此操作影響。',

            // 匯入驗證對話框
            clImportTitle:           '語系檔案已匯入',
            clImportUnknown:         '未知的項目 — 已忽略',
            clImportMissing:         '缺少的項目 — 將以英文替補',
            clImportSafeNote:        '這不會影響正常使用。',
            clImportOkBtn:           '確定',
            clImportErrorTitle:      '匯入失敗',
            clImportErrorDesc:       '無法讀取檔案，請確認這是有效的 JSON 語系檔案。',

            // 清除全部 — 第一步（詢問匯出）
            clClearStep1Title:       '清除前要先匯出嗎？',
            clClearStep1Desc:        '您的翻譯資料將被永久刪除。是否要先匯出備份？',
            clClearExportBtn:        '匯出並繼續',
            clClearSkipBtn:          '僅直接清除',
            clClearCancelBtn:        '取消',

            // 清除全部 — 第二步（最終確認）
            clClearStep2Title:       '⚠ 清除自訂語系',
            clClearStep2Desc:        '這將永久刪除所有翻譯資料，此操作無法復原。',
            clClearConfirmBtn:       '清除全部',
        },

    };

    /**
     * Detects the current UI language from document.documentElement.lang and
     * returns the matching key in LANGS. Falls back to a language-prefix match
     * (e.g. 'zh-HK' → 'zh_tw' if that is the closest zh variant present),
     * then ultimately to 'en'.
     *
     * To add a language: add a key to LANGS and this function needs no changes.
     *
     * @returns {string}  A key that exists in LANGS.
     */
    function detectLang() {
        const hl = (document.documentElement.lang || '').toLowerCase().replace('-', '_');
        if (LANGS[hl]) return hl;
        // Prefix fallback: 'zh_hk' → look for any key starting with 'zh'
        const prefix = hl.split('_')[0];
        const match = Object.keys(LANGS).find(k => k.startsWith(prefix));
        if (match) return match;
        return 'en';
    }

    let LANG = LANGS[detectLang()];

    // ─────────────────────────────────────────────────────────────────────────
    // TRUSTED TYPES COMPATIBILITY LAYER (Chrome)
    // Chrome enforces Trusted Types in the Tampermonkey isolated world.
    // We attempt to create a 'default' pass-through policy first — this covers
    // jQuery's internal innerHTML calls automatically. We also create a named
    // policy for our own explicit innerHTML assignments, and patch the
    // Element.prototype.innerHTML setter as a belt-and-suspenders fallback.
    // Firefox does not implement trustedTypes; all paths fall back to no-ops.
    // ─────────────────────────────────────────────────────────────────────────
    const _trustedHTML = (() => {
        if (typeof trustedTypes === 'undefined') {
            return s => s;
        }

        // Attempt 'default' policy so jQuery's bare innerHTML calls are auto-converted.
        try {
            trustedTypes.createPolicy('default', {
                createHTML:      s => s,
                createScript:    s => s,
                createScriptURL: s => s
            });
        } catch(e) {
        }

        // Named policy for our own explicit _trustedHTML() calls.
        try {
            const policy = trustedTypes.createPolicy('ytchannelmem#html', { createHTML: s => s });

            // Belt-and-suspenders: patch the innerHTML setter so any string
            // assignment (ours or jQuery's) is auto-wrapped via our named policy.
            // Note: Chrome enforces Trusted Types at the WebIDL level, so this
            // patch may have no effect — the default policy above is the real fix.
            try {
                const origDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
                if (origDesc?.configurable) {
                    Object.defineProperty(Element.prototype, 'innerHTML', {
                        set(value) {
                            origDesc.set.call(this,
                                typeof value === 'string' ? policy.createHTML(value) : value
                            );
                        },
                        get()        { return origDesc.get.call(this); },
                        configurable: true, enumerable: true
                    });
                } else {
                }
            } catch(e2) {
            }

            return s => policy.createHTML(s);
        } catch(e) {
            return s => s;
        }
    })();

    // ─────────────────────────────────────────────────────────────────────────
    // VANILLA DOM SHIM — replaces jQuery (@require removed for Chrome compat)
    // Provides the jQuery subset used by this script using only native DOM APIs
    // (no innerHTML), making it fully Trusted Types-safe in Chrome's isolated
    // world. Supports: selectors (incl. :visible), event binding, traversal,
    // attribute/class/style manipulation, and basic DOM mutations.
    // ─────────────────────────────────────────────────────────────────────────
    const $ = (() => {
        function isVisible(el) {
            return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
                   getComputedStyle(el).visibility !== 'hidden';
        }
        function parseSel(sel) {
            let visFilter = false, firstOnly = false;
            let css = sel
                .replace(/:visible/g,  () => { visFilter = true; return ''; })
                .replace(/:first\b/g,  () => { firstOnly = true; return ''; })
                .trim().replace(/\s{2,}/g, ' ');
            return { css, visFilter, firstOnly };
        }
        function qsa(sel, ctx) {
            const { css, visFilter, firstOnly } = parseSel(sel);
            if (!css) return [];
            try {
                let els = Array.from((ctx || document).querySelectorAll(css));
                if (visFilter)  els = els.filter(isVisible);
                if (firstOnly)  els = els.slice(0, 1);
                return els;
            } catch(e) { return []; }
        }
        function wrap(arr) {
            arr = Array.isArray(arr) ? arr : (arr ? [arr] : []);
            const jq = Object.assign(Object.create(null), {
                _isJQ: true,
                length: arr.length,
                get(i)         { return arr[i]; },
                each(fn)       { arr.forEach((el,i)=>fn.call(el,i,el)); return jq; },
                find(sel)      { const r=[]; arr.forEach(el=>r.push(...qsa(sel,el))); return wrap(r); },
                closest(sel)   { let el=arr[0]; while(el){if(el.matches&&el.matches(sel))return wrap([el]);el=el.parentElement;} return wrap([]); },
                parent()       { return wrap(arr.map(el=>el.parentElement).filter(Boolean)); },
                children(sel)  { const r=[]; arr.forEach(el=>Array.from(el.children).forEach(c=>{if(!sel||c.matches(sel))r.push(c);})); return wrap(r); },
                filter(sel)    { if(typeof sel==='function')return wrap(arr.filter((el,i)=>sel.call(el,i,el))); const{css,visFilter:vf}=parseSel(sel); return wrap(arr.filter(el=>((!css||el.matches&&el.matches(css)))&&(!vf||isVisible(el)))); },
                not(sel)       { return wrap(arr.filter(el=>!el.matches||!el.matches(sel))); },
                is(sel)        { if(typeof sel==='function')return arr.some(sel); return arr.some(el=>el.matches&&el.matches(sel)); },
                first()        { return wrap(arr.slice(0,1)); },
                last()         { return wrap(arr.slice(-1)); },
                eq(i)          { return wrap(i>=0?[arr[i]]:[arr[arr.length+i]]); },
                on(evt,s2,fn)  { if(typeof s2==='function'){fn=s2;s2=null;} arr.forEach(el=>{if(s2)el.addEventListener(evt,e=>{const t=e.target.closest&&e.target.closest(s2);if(t)fn.call(t,e);});else el.addEventListener(evt,fn);}); return jq; },
                off(evt,fn)    { arr.forEach(el=>el.removeEventListener(evt,fn)); return jq; },
                attr(k,v)      { if(v===undefined)return arr[0]?.getAttribute(k)??undefined; arr.forEach(el=>v===null?el.removeAttribute(k):el.setAttribute(k,String(v))); return jq; },
                removeAttr(k)  { arr.forEach(el=>el.removeAttribute(k)); return jq; },
                prop(k,v)      { if(v===undefined)return arr[0]?.[k]; arr.forEach(el=>el[k]=v); return jq; },
                css(k,v)       { if(v===undefined)return arr[0]?getComputedStyle(arr[0]).getPropertyValue(k):''; arr.forEach(el=>el.style[k]=v); return jq; },
                text(v)        { if(v===undefined)return arr[0]?.textContent??''; arr.forEach(el=>el.textContent=v); return jq; },
                val(v)         { if(v===undefined)return arr[0]?.value; arr.forEach(el=>el.value=v); return jq; },
                hasClass(c)    { return arr.some(el=>el.classList.contains(c)); },
                addClass(c)    { arr.forEach(el=>el.classList.add(...c.trim().split(/\s+/))); return jq; },
                removeClass(c) { arr.forEach(el=>el.classList.remove(...c.trim().split(/\s+/))); return jq; },
                toggleClass(c) { arr.forEach(el=>el.classList.toggle(c)); return jq; },
                prepend(ch)    { const n=ch&&ch._isJQ?ch[0]:ch; if(n)arr.forEach((p,i)=>p.insertBefore(i<arr.length-1?n.cloneNode(true):n,p.firstChild)); return jq; },
                replaceWith(n) { const r=n&&n._isJQ?n[0]:n; if(r)arr.forEach(o=>o.parentNode?.replaceChild(r,o)); return jq; },
                appendTo(t)    { const p=typeof t==='string'?document.querySelector(t):t&&t._isJQ?t[0]:t; if(p)arr.forEach(el=>p.appendChild(el)); return jq; },
                remove()       { arr.forEach(el=>el.remove()); return jq; },
                trigger(evt)   { arr.forEach(el=>el.dispatchEvent(new Event(evt,{bubbles:true,cancelable:true}))); return jq; },
                click(fn)      { if(typeof fn==='function')return jq.on('click',fn); arr.forEach(el=>el.click()); return jq; },
                visible()      { return wrap(arr.filter(isVisible)); },
            });
            arr.forEach((el,i)=>jq[i]=el);
            return jq;
        }
        function $(sel, ctx) {
            if (!sel && sel !== 0) return wrap([]);
            if (typeof sel === 'function') {
                if (document.readyState !== 'loading') sel(); else document.addEventListener('DOMContentLoaded', sel);
                return;
            }
            if (sel && sel._isJQ) return sel;
            if (sel instanceof Element || sel instanceof Document || sel instanceof Window) return wrap([sel]);
            if (sel instanceof NodeList || sel instanceof HTMLCollection) return wrap(Array.from(sel));
            if (typeof sel === 'string') {
                const ctxEl = ctx ? (ctx._isJQ ? ctx[0] : ctx) : null;
                return wrap(qsa(sel, ctxEl));
            }
            return wrap([]);
        }
        $.fn = {};
        return $;
    })();

    // ─────────────────────────────────────────────────────────────────────────
    // DEFAULT SETTINGS
    // These values are used on first run or after a settings reset.
    // All settings are persisted via GM.setValue under the "_YSC-" prefix.
    // ─────────────────────────────────────────────────────────────────────────
    const defaults = {
        /** Fallback playback speed for channels without a saved preference. */
        DEFAULT_SPEED: 1.0,

        /** When true, shows real-time adjusted duration next to the YT timestamp. */
        SHOW_RELATIVE_TIME: true,

        /** Highlight color for the currently active speed button. */
        COLOR_SELECTED: "red",

        /** Default color for inactive speed buttons. */
        COLOR_NORMAL: "rgb(220,220,220)",

        /**
         * Speed button definitions. Each entry is [label, speed].
         * Stored as a JSON string in GM storage; parsed to an array at runtime.
         */
        BUTTON_TEMPLATES: JSON.stringify([
            ["50%",    0.5],
            ["75%",    0.75],
            ["Normal", 1],
            ["1.25x",  1.25],
            ["1.5x",   1.5],
            ["1.75x",  1.75],
            ["2x",     2],
            ["2.25x",  2.25],
            ["2.5x",   2.5],
            ["3x",     3],
            ["3.5x",   3.5]
        ]),

        /** Audio gain multiplier. Values above 1 amplify; a soft limiter prevents clipping. */
        AUDIO_BOOST: 1,

        /**
         * When true, a video opened from a new tab or by the user's own navigation
         * starts paused. Playlist / autoplay-next continuations keep playing.
         */
        START_PAUSED: false,

        /**
         * When true, enters fullscreen on the 'play' event that follows the user's
         * own Play press (the browser grants fullscreen right after a real input).
         */
        FULLSCREEN_ON_START: false,

        /**
         * When true, exits fullscreen automatically when a video nears its end
         * (within 5 seconds of the total duration). Exiting needs no user input.
         */
        FULLSCREEN_ON_END: false,

        /** When true, shows a thin progress bar at the bottom of the player whenever its controls are hidden. */
        FS_PROGRESS_BAR: true,

        /** When true, hides the live-chat panel (ytd-live-chat-frame). Playlist panel is unaffected. */
        HIDE_LIVE_CHAT: false,

        /**
         * Font size for the speed buttons and CC on/off labels in the player bar.
         * Uses em units so the text scales with YouTube's control bar zoom at
         * different screen sizes. 1em = inherited (YouTube default); 1.2em = 20% larger.
         */
        PLAYER_FONT_SIZE: '1.3em',

        /**
         * Custom language data in the array format:
         * { langCode: string, strings: [ { id, key, value } ] }
         * Stored as a JSON string; parsed at runtime when USE_CUSTOM_LANG is true.
         */
        CUSTOM_LANG: '{"langCode":"","strings":[]}',

        /** Language code identifier for the custom language (e.g. "zh", "ja"). */
        CUSTOM_LANG_CODE: '',

        /** When true, overrides the detected UI language with the custom language data.
         *  Kept in sync with UI_LANG ('custom' ⇔ true) for older versions. */
        USE_CUSTOM_LANG: false,

        /** Interface language: 'auto' (follow YouTube), 'en', 'zh_tw' or 'custom'.
         *  Empty means "not chosen yet" and is migrated from USE_CUSTOM_LANG. */
        UI_LANG: '',
    };

    // Load persisted values into window globals, falling back to defaults.
    for (let name in defaults) {
        let value = defaults[name];
        window[name] = (name === "BUTTON_TEMPLATES"
            ? JSON.parse(await GM.getValue("_YSC-" + name, value))
            : await GM.getValue("_YSC-" + name, value));
    }
    // Speed buttons are always shown in ascending speed order (the editor sorts
    // on save; lists saved by older versions may still be in any order). The
    // temporary speed button relies on this order to find its slot.
    window['BUTTON_TEMPLATES'] = _sortTemplates(window['BUTTON_TEMPLATES']);

    // ─────────────────────────────────────────────────────────────────────────
    // CUSTOM LANGUAGE HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Parses the stored custom language JSON string into a flat key→value map.
     * Expects the array format: { langCode, strings: [{id, key, value}, …] }.
     * Duplicate keys are resolved last-write-wins (last occurrence in the array wins).
     *
     * @param  {string} jsonStr  Raw JSON string from GM storage.
     * @returns {Object}         Flat { key: translatedString } map.
     */
    function parseCustomLang(jsonStr) {
        try {
            const data = JSON.parse(jsonStr || '{}');
            const map = {};
            if (Array.isArray(data.strings)) {
                for (const entry of data.strings) {
                    if (entry && entry.key && entry.value !== undefined) {
                        map[entry.key] = entry.value;
                    }
                }
            }
            return map;
        } catch { return {}; }
    }

    /**
     * Builds the active LANG object used throughout the UI.
     * When USE_CUSTOM_LANG is true, merges the custom translation map over the
     * auto-detected locale.  Any key absent from (or empty in) the custom data
     * falls back to the detected locale value, then ultimately to English.
     *
     * @returns {Object}  A complete LANG-shaped object.
     */
    function buildActiveLang() {
        const choice   = window['UI_LANG'];
        const detected = LANGS[choice] || LANGS[detectLang()];
        if (!window['USE_CUSTOM_LANG']) return detected;
        const custom = parseCustomLang(window['CUSTOM_LANG']);
        const en = LANGS['en'];
        const result = {};
        for (const key of Object.keys(en)) {
            result[key] = (custom[key] !== undefined && custom[key] !== '')
                ? custom[key]
                : (detected[key] !== undefined ? detected[key] : en[key]);
        }
        return result;
    }

    // Migrate the language choice from the older on/off switch, then keep the
    // two settings consistent, and re-apply the active language.
    if (!['auto', 'en', 'zh_tw', 'custom'].includes(window['UI_LANG'])) {
        window['UI_LANG'] = window['USE_CUSTOM_LANG'] ? 'custom' : 'auto';
    }
    window['USE_CUSTOM_LANG'] = window['UI_LANG'] === 'custom';
    LANG = buildActiveLang();
    _ycmReady = true;   // full settings + LANG available to the early play hold
    _fsLog('settings loaded');

    // ─────────────────────────────────────────────────────────────────────────
    // GM_registerMenuCommand POLYFILL
    // Provides a context-menu fallback for userscript managers that do not
    // natively support GM_registerMenuCommand (e.g. some older builds).
    // ─────────────────────────────────────────────────────────────────────────
    if (typeof GM_registerMenuCommand === 'undefined') {
        const _YSC_MENU_ID = 'gm-registered-menu';
        const _addMenuEntry = (label, handler) => {
            const ref = document.body.getAttribute('contextmenu');
            let host = ref ? document.querySelector('menu#' + ref) : null;
            if (!host) {
                host = document.createElement('menu');
                host.id = _YSC_MENU_ID;
                host.setAttribute('type', 'context');
                document.body.appendChild(host);
                document.body.setAttribute('contextmenu', _YSC_MENU_ID);
            }
            const entry = document.createElement('menuitem');
            entry.textContent = label;
            entry.addEventListener('click', handler, true);
            host.appendChild(entry);
        };
        this.GM_registerMenuCommand = (label, handler) => {
            if (document.body) { _addMenuEntry(label, handler); return; }
            const root = document.documentElement;
            if (document.readyState !== 'loading' || !root || root.localName !== 'html') {
                console.error('GM_registerMenuCommand got no body.');
                return;
            }
            const waiter = new MutationObserver(() => {
                if (!document.body) return;
                waiter.disconnect();
                _addMenuEntry(label, handler);
            });
            waiter.observe(root, { childList: true });
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SETTINGS PANEL
    // Renders a modal overlay with all configurable options.
    // Panel width is computed dynamically by measuring the widest label and
    // the widest control widget in a hidden element, ensuring a tight fit.
    // Measurement results are cached after the first open so subsequent opens
    // skip the DOM measurement entirely.
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Cached layout measurements for the settings panel.
     * Computed once on first open, then reused to avoid redundant DOM work.
     * @type {{ panelW: number, speedInputW: number } | null}
     */
    let _panelMeasureCache = null;
    async function openSettingsPanel() {
        // Remove any previously open panel before rebuilding.
        document.getElementById('ysc-prefs-wrap')?.remove();

        // Detect YouTube's current theme to apply matching colors.
        const isDark = document.documentElement.hasAttribute('dark');

        // Read all saved settings in parallel (Promise.all) rather than
        // sequentially, so the panel opens as soon as all values are ready
        // instead of waiting for each GM.getValue round-trip in turn.
        const cur = {};
        await Promise.all(Object.keys(defaults).map(async name => {
            const raw = await GM.getValue('_YSC-' + name, defaults[name]);
            cur[name] = (name === 'BUTTON_TEMPLATES') ? JSON.parse(raw) : raw;
        }));

        // Theme-aware color tokens used throughout the settings panel CSS.
        const t = isDark ? {
            bg: '#212121', hdrBg: '#2a2a2a', hdrBorder: 'rgba(255,255,255,0.07)',
            title: '#f0f0f0', closeBg: 'rgba(255,255,255,0.08)', closeColor: '#999',
            rowBorder: 'rgba(255,255,255,0.05)', rowHover: 'rgba(255,255,255,0.03)',
            lbl: '#ccc', lblSub: '#555',
            stepperBg: '#2e2e2e', stepperBorder: 'rgba(255,255,255,0.1)',
            stepperBtnColor: '#aaa', stepperBtnHover: 'rgba(255,255,255,0.08)',
            stepperValColor: '#e0e0e0', stepperDivider: 'rgba(255,255,255,0.08)',
            inputBg: '#2e2e2e', inputBorder: 'rgba(255,255,255,0.1)', inputColor: '#e0e0e0',
            toggleBg: '#3a3a3a', toggleBorder: 'rgba(255,255,255,0.08)',
            toggleOn: '#cc0000',
            editBg: '#2e2e2e', editBorder: 'rgba(255,255,255,0.1)', editColor: '#aaa',
            sep: 'rgba(255,255,255,0.05)', groupLbl: '#bbb',
            footerBg: '#1e1e1e', footerBorder: 'rgba(255,255,255,0.06)',
            btnResetBg: '#2e2e2e', btnResetBorder: 'rgba(255,255,255,0.1)', btnResetColor: '#888',
            overlayBg: 'rgba(0,0,0,0.6)',
            tsHead: '#ffffff', tsItem: '#f1f1f1', tsDesc: '#a6a6a6', cardHdrBorder: 'rgba(255,255,255,0.08)'
        } : {
            bg: '#fff', hdrBg: '#f7f7f7', hdrBorder: 'rgba(0,0,0,0.08)',
            title: '#111', closeBg: 'rgba(0,0,0,0.07)', closeColor: '#777',
            rowBorder: 'rgba(0,0,0,0.05)', rowHover: 'rgba(0,0,0,0.02)',
            lbl: '#333', lblSub: '#bbb',
            stepperBg: '#f2f2f2', stepperBorder: 'rgba(0,0,0,0.12)',
            stepperBtnColor: '#666', stepperBtnHover: 'rgba(0,0,0,0.07)',
            stepperValColor: '#111', stepperDivider: 'rgba(0,0,0,0.1)',
            inputBg: '#f2f2f2', inputBorder: 'rgba(0,0,0,0.12)', inputColor: '#111',
            toggleBg: '#ddd', toggleBorder: 'rgba(0,0,0,0.1)',
            toggleOn: '#cc0000',
            editBg: '#f2f2f2', editBorder: 'rgba(0,0,0,0.12)', editColor: '#666',
            sep: 'rgba(0,0,0,0.06)', groupLbl: '#555',
            footerBg: '#f7f7f7', footerBorder: 'rgba(0,0,0,0.07)',
            btnResetBg: '#efefef', btnResetBorder: 'rgba(0,0,0,0.1)', btnResetColor: '#888',
            overlayBg: 'rgba(0,0,0,0.35)',
            tsHead: '#0f0f0f', tsItem: '#1f1f1f', tsDesc: '#606060', cardHdrBorder: 'rgba(0,0,0,0.08)'
        };

        // Inject or refresh the panel + color-picker stylesheet.
        // The <style> tag is created once and left in the DOM permanently to
        // avoid the full-page style recalculation (reflow) that occurs when a
        // <style> tag is removed. However, its textContent is refreshed on every
        // open so that theme-aware color tokens (${t.xxx}) always reflect the
        // current dark/light mode — which can change between opens.
        const styleId = 'ysc-settings-style';
        let style = document.getElementById(styleId);
        if (!style) {
            style = document.createElement('style');
            style.id = styleId;
            document.head.appendChild(style);
        }
        style.textContent = `
            #ysc-prefs-wrap {
                position: fixed; inset: 0; z-index: 2200;
                background: ${t.overlayBg};
                display: flex; align-items: center; justify-content: center;
            }
            #ysc-settings-panel {
                width: auto; border-radius: 12px; overflow: hidden;
                background: ${t.bg};
                border: 1px solid ${t.hdrBorder};
                box-shadow: 0 20px 50px rgba(0,0,0,0.4);
                font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
                font-size: 17px; color: ${t.lbl};
                max-height: 90vh; display: flex; flex-direction: column;
            }
            #ysc-settings-panel .ysc-hdr {
                background: ${t.hdrBg};
                border-bottom: 1px solid ${t.hdrBorder};
                padding: 12px 16px;
                display: flex; align-items: center; justify-content: space-between;
                flex-shrink: 0;
            }
            #ysc-settings-panel .ysc-hdr-left { display: flex; align-items: center; gap: 8px; }
            #ysc-settings-panel .ysc-yt-logo { width: 22px; height: 15px; flex-shrink: 0; }
            /* Type scale (16px floor, +2px per level, each level also changes weight or colour):
               L4 panel title 22/700 · L3 card header 20/700 · L2 item name 18/500 · L1 description 16/400 grey.
               A 1px step (old 17/16) was invisible, so levels differ by at least 2px. */
            #ysc-settings-panel .ysc-title { font-size: 22px; font-weight: 700; color: ${t.tsHead}; }
            #ysc-settings-panel .ysc-close {
                width: 22px; height: 22px; border-radius: 50%; border: none;
                background: ${t.closeBg}; color: ${t.closeColor};
                font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center;
                flex-shrink: 0; transition: background 0.15s;
            }
            #ysc-settings-panel .ysc-body { overflow-y: auto; padding: 4px 0 0; flex: 1; }
            /* L3: card header row (title bar of the card, not a floating badge). */
            #ysc-settings-panel .ysc-group {
                font-size: 20px; font-weight: 700; color: ${t.tsHead};
                height: 48px; padding: 0 16px; box-sizing: border-box;
                display: flex; align-items: center;
                border-bottom: 1px solid ${t.cardHdrBorder};
            }
            /* Fixed row height: one rhythm whether or not a row has a description. */
            #ysc-settings-panel .ysc-row {
                display: flex; align-items: center; justify-content: space-between;
                box-sizing: border-box; min-height: 64px; padding: 6px 16px; gap: 16px;
                position: relative;
                transition: background 0.12s;
            }
            #ysc-settings-panel .ysc-row:hover { background: ${t.rowHover}; }
            #ysc-settings-panel .ysc-cols { display: flex; gap: 16px; padding: 16px; align-items: flex-start; }
            #ysc-settings-panel .ysc-col  { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
            #ysc-settings-panel.ysc-one-col .ysc-cols { flex-direction: column; align-items: stretch; }
            #ysc-settings-panel .ysc-card {
                border-radius: 10px; padding: 0; overflow: hidden;
                background: ${isDark ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.025)'};
                border: 1px solid ${t.rowBorder};
            }
            #ysc-settings-panel .ysc-card .ysc-row:last-child::after { display: none; }
            #ysc-settings-panel .ysc-row::after {
                content: ''; position: absolute; bottom: 0; left: 16px; right: 16px;
                height: 1px; background: ${t.rowBorder};
            }
            #ysc-settings-panel .ysc-row:has(+ .ysc-sep)::after,
            #ysc-settings-panel .ysc-row:has(+ .ysc-danger-zone)::after { display: none; }
            /* L2 item name / L1 description. Never indent the description: in settings
               UIs indentation means "child setting". keep-all + balance avoids orphan characters. */
            #ysc-settings-panel .ysc-lbl {
                flex: 1 1 auto; min-width: 0; font-size: 18px; font-weight: 500; line-height: 1.35;
                color: ${t.tsItem}; word-break: keep-all; text-wrap: balance;
            }
            #ysc-settings-panel .ysc-lbl small {
                display: block; font-size: 16px; font-weight: 400; line-height: 1.35;
                color: ${t.tsDesc}; margin-top: 4px;
            }
            #ysc-settings-panel .ysc-help-link { color: ${isDark ? '#3ea6ff' : '#065fd4'}; font-weight: 600; text-decoration: underline; }
            #ysc-settings-panel .ysc-note.ysc-warn {
                margin: 2px 16px 10px; padding: 8px 10px; border-radius: 6px; line-height: 1.5;
                border-left: 3px solid #f5a623; font-weight: 600;
                background: ${isDark ? 'rgba(245,166,35,0.14)' : 'rgba(245,166,35,0.12)'};
                color: ${isDark ? '#ffc861' : '#8a5300'};
            }
            #ysc-settings-panel .ysc-help-link:hover { filter: brightness(1.15); }
            #ysc-cl-confirm-dialog .cld-rich p { margin: 0 0 8px; }
            #ysc-cl-confirm-dialog .cld-rich ul { margin: 0; padding-left: 18px; }
            #ysc-cl-confirm-dialog .cld-rich li { margin-bottom: 4px; }
            #ysc-cl-confirm-dialog .cld-body.cld-rich { color: ${t.lbl}; }
            #ysc-cl-confirm-dialog .cld-rich code {
                font-size: 16px; overflow-wrap: anywhere; font-family: Consolas, 'Courier New', monospace;
                padding: 1px 6px; border-radius: 4px; font-weight: 600;
                color: ${isDark ? '#ffc861' : '#9a5b00'};
                background: ${isDark ? 'rgba(255,200,97,0.12)' : 'rgba(245,166,35,0.14)'};
            }
            #ysc-cl-confirm-dialog .cld-rich b { color: ${t.title}; }
            /* L1 card footnote: the last block inside its card, below the rows. */
            #ysc-settings-panel .ysc-note {
                padding: 12px 16px 14px; font-size: 16px; line-height: 1.45; color: ${t.tsDesc};
                border-top: 1px solid ${t.cardHdrBorder};
            }
            #ysc-settings-panel .ysc-sep { height: 1px; background: ${t.sep}; margin: 2px 0; }
            /* Stepper */
            #ysc-settings-panel .ysc-stepper {
                display: flex; align-items: center; border-radius: 7px; overflow: hidden;
                height: 28px; flex-shrink: 0; box-sizing: border-box; width: 120px;
                background: ${t.stepperBg}; border: 1px solid ${t.stepperBorder};
            }
            #ysc-settings-panel .ysc-stepper-btn {
                width: 28px; height: 28px; border: none; cursor: pointer;
                font-size: 18px; color: ${t.stepperBtnColor}; background: transparent;
                display: flex; align-items: center; justify-content: center;
                transition: background 0.12s; padding-bottom: 1px; flex-shrink: 0;
            }
            #ysc-settings-panel .ysc-stepper-btn:hover { background: ${t.stepperBtnHover}; }
            #ysc-settings-panel .ysc-stepper-val {
                flex: 1; min-width: 0; width: auto; height: 28px; border: none; background: transparent;
                color: ${t.stepperValColor}; font-size: 16px; text-align: center; outline: none;
                border-left: 1px solid ${t.stepperDivider}; border-right: 1px solid ${t.stepperDivider};
                -moz-appearance: textfield;
            }
            #ysc-settings-panel .ysc-stepper-val::-webkit-inner-spin-button,
            #ysc-settings-panel .ysc-stepper-val::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
            /* Text input */
            #ysc-settings-panel .ysc-select {
                border-radius: 7px; padding: 5px 8px; font-size: 16px; outline: none; cursor: pointer;
                background: ${t.inputBg}; border: 1px solid ${t.inputBorder}; color: ${t.inputColor};
                font-family: inherit;
            }
            #ysc-settings-panel .ysc-select option { background: ${t.bg}; color: ${t.lbl}; }
            #ysc-settings-panel .ysc-input {
                border-radius: 7px; padding: 5px 9px; font-size: 17px; outline: none;
                background: ${t.inputBg}; border: 1px solid ${t.inputBorder}; color: ${t.inputColor};
                width: 116px; text-align: right; transition: border 0.15s, background 0.15s;
            }
            #ysc-settings-panel .ysc-input:focus { border-color: rgba(200,0,0,0.5); }
            /* Color row (new style) */
            #ysc-settings-panel .ysc-color-row {
                display: flex; align-items: center; gap: 6px; flex-shrink: 0;
                box-sizing: border-box; width: 120px; height: 30px;
                padding: 0 7px; border-radius: 7px; cursor: pointer;
                border: 1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'};
                transition: background 0.15s, border-color 0.15s;
            }
            #ysc-settings-panel .ysc-color-row:hover {
                background: ${t.rowHover};
                border-color: rgba(204,0,0,0.65);
            }
            #ysc-settings-panel .ysc-color-text {
                font-size: 16px; color: ${t.inputColor};
                font-variant-numeric: tabular-nums; white-space: nowrap;
            }
            #ysc-settings-panel .ysc-swatch {
                width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0;
                border: 1px solid ${t.inputBorder};
                order: -1;
            }
            /* Toggle */
            #ysc-settings-panel .ysc-toggle {
                box-sizing: border-box; width: 40px; height: 24px; border-radius: 12px; position: relative;
                cursor: pointer; flex-shrink: 0;
                background: ${t.toggleBg}; border: 1px solid ${t.toggleBorder};
                transition: background 0.2s, border-color 0.2s;
            }
            #ysc-settings-panel .ysc-toggle::after {
                content: ''; position: absolute;
                /* Track is border-box 40x24 with a 1px border, so the padding box is 38x22:
                   an 18px knob at top/left 2px leaves 2px on every side. The old content-box
                   38x22 track drew as 40x24 with a 16px knob (2px above, 4px below), which
                   looked vertically stretched. */
                width: 18px; height: 18px; background: #fff; border-radius: 50%;
                top: 2px; left: 2px; transition: left 0.2s;
                box-shadow: 0 1px 3px rgba(0,0,0,0.25);
            }
            #ysc-settings-panel .ysc-toggle.on { background: ${t.toggleOn}; border-color: ${t.toggleOn}; }
            #ysc-settings-panel .ysc-toggle.on::after { left: 18px; }
            /* Edit btn */
            #ysc-settings-panel .ysc-edit-btn {
                box-sizing: border-box; width: 120px; height: 30px; flex-shrink: 0;
                border-radius: 7px; padding: 0; font-size: 16px; cursor: pointer;
                background: ${t.editBg}; border: 1px solid ${t.editBorder}; color: ${t.editColor};
                transition: background 0.12s; white-space: nowrap;
            }
            /* Button Templates Editor */
            #ysc-bt-overlay {
                position: fixed; inset: 0; z-index: 100000;
                background: ${t.overlayBg};
                display: flex; align-items: center; justify-content: center;
            }
            #ysc-bt-editor {
                border-radius: 11px; overflow: hidden;
                border: 1px solid ${t.hdrBorder};
                background: ${t.bg};
                box-shadow: 0 8px 28px rgba(0,0,0,0.4);
                font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
                font-size: 17px; color: ${t.lbl};
                display: flex; flex-direction: column;
                max-height: 90vh;
            }
            #ysc-bt-editor .bt-hdr {
                background: ${t.hdrBg}; border-bottom: 1px solid ${t.hdrBorder};
                padding: 11px 14px; font-size: 20px; font-weight: 700;
                color: ${t.title}; letter-spacing: 0.2px;
                display: flex; align-items: center; justify-content: space-between;
            }
            #ysc-bt-editor .bt-hdr-sub { font-size: 16px; color: ${t.groupLbl}; font-weight: 400; }
            #ysc-bt-editor .bt-note { margin: 6px 14px 0; font-size: 16px; line-height: 1.45; color: ${t.tsDesc}; }
            #ysc-bt-editor .bt-dup-err {
                margin: 6px 14px 0; padding: 8px 10px; border-radius: 6px; font-size: 16px; line-height: 1.45;
                border-left: 3px solid #f5a623; font-weight: 600;
                background: ${isDark ? 'rgba(245,166,35,0.14)' : 'rgba(245,166,35,0.12)'};
                color: ${isDark ? '#ffc861' : '#8a5300'};
            }
            #ysc-bt-editor .bt-col-headers {
                display: flex; align-items: center;
                padding: 6px 14px 4px; gap: 8px;
                border-bottom: 1px solid ${t.rowBorder};
            }
            #ysc-bt-editor .bt-col-handle { width: 16px; flex-shrink: 0; }
            #ysc-bt-editor .bt-col-label  { flex: 1; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; color: ${t.groupLbl}; }
            #ysc-bt-editor .bt-col-speed  { flex-shrink: 0; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; color: ${t.groupLbl}; text-align: right; }
            #ysc-bt-editor .bt-col-del    { width: 22px; flex-shrink: 0; }
            #ysc-bt-editor .bt-list {
                overflow-y: auto; overflow-x: hidden; padding: 4px 0;
                flex: 1; min-height: 0;
            }
            #ysc-bt-editor .bt-row {
                display: flex; align-items: center;
                padding: 5px 14px; gap: 8px; height: 36px;
                transition: background 0.12s;
                border-top: 2px solid transparent;
                border-bottom: 2px solid transparent;
            }
            #ysc-bt-editor .bt-row:hover { background: ${t.rowHover}; }
            #ysc-bt-editor .bt-row.dragging { opacity: 0.4; }
            #ysc-bt-editor .bt-row.drag-over-top    { border-top-color: rgba(204,0,0,0.7); }
            #ysc-bt-editor .bt-row.drag-over-bottom { border-bottom-color: rgba(204,0,0,0.7); }
            #ysc-bt-editor .bt-drag-handle {
                width: 16px; flex-shrink: 0; cursor: grab;
                color: ${t.lblSub}; font-size: 17px;
                display: flex; align-items: center; justify-content: center;
                transition: color 0.12s; user-select: none;
            }
            #ysc-bt-editor .bt-row:hover .bt-drag-handle { color: ${t.lbl}; }
            #ysc-bt-editor .bt-drag-handle:active { cursor: grabbing; }
            #ysc-bt-editor .bt-inp-label {
                flex: 1; height: 26px; border-radius: 6px;
                padding: 0 8px; font-size: 17px; outline: none; min-width: 0;
                background: ${t.inputBg}; border: 1px solid ${t.inputBorder}; color: ${t.inputColor};
                transition: border-color 0.15s;
            }
            #ysc-bt-editor .bt-inp-label:focus { border-color: rgba(204,0,0,0.5); }
            #ysc-bt-editor .bt-inp-speed {
                flex-shrink: 0; height: 26px; border-radius: 6px;
                padding: 0 8px; font-size: 17px; outline: none; text-align: right;
                background: ${t.inputBg}; border: 1px solid ${t.inputBorder}; color: ${t.inputColor};
                transition: border-color 0.15s; -moz-appearance: textfield;
            }
            #ysc-bt-editor .bt-inp-speed:focus { border-color: rgba(204,0,0,0.5); }
            #ysc-bt-editor .bt-inp-speed::-webkit-inner-spin-button,
            #ysc-bt-editor .bt-inp-speed::-webkit-outer-spin-button { -webkit-appearance: none; }
            #ysc-bt-editor .bt-inp-label::placeholder,
            #ysc-bt-editor .bt-inp-speed::placeholder { color: ${t.lblSub}; opacity: 0.45; }
            #ysc-bt-editor .bt-del-btn {
                width: 22px; height: 22px; flex-shrink: 0; border-radius: 5px;
                border: none; background: transparent; cursor: pointer;
                font-size: 17px; color: ${t.lblSub};
                display: flex; align-items: center; justify-content: center;
                transition: background 0.12s, color 0.12s;
            }
            #ysc-bt-editor .bt-del-btn:hover { background: rgba(204,0,0,0.15); color: #cc4444; }
            #ysc-bt-editor .bt-add-row {
                display: flex; padding: 6px 14px 8px;
                border-top: 1px solid ${t.rowBorder};
            }
            #ysc-bt-editor .bt-add-btn {
                display: flex; align-items: center; gap: 5px;
                padding: 5px 10px; border-radius: 6px;
                border: 1px dashed ${t.inputBorder};
                background: transparent; cursor: pointer; font-size: 17px; color: ${t.groupLbl};
                transition: all 0.15s;
            }
            #ysc-bt-editor .bt-add-btn:hover { border-color: rgba(204,0,0,0.4); color: #cc4444; background: rgba(204,0,0,0.05); }
            #ysc-bt-editor .bt-footer {
                display: flex; gap: 8px; padding: 10px 14px 12px;
                border-top: 1px solid ${t.footerBorder}; background: ${t.footerBg};
            }
            #ysc-bt-editor .bt-btn {
                flex: 1; padding: 7px; border-radius: 7px; border: none;
                font-size: 17px; font-weight: 600; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                transition: opacity 0.12s;
            }
            #ysc-bt-editor .bt-btn:active { opacity: 0.82; }
            #ysc-bt-editor .bt-btn-cancel {
                background: ${t.btnResetBg}; border: 1px solid ${t.btnResetBorder}; color: ${t.btnResetColor};
            }
            #ysc-bt-editor .bt-btn-save { background: #cc0000; color: #fff; }
            /* Custom Language Editor */
            #ysc-cl-overlay {
                position: fixed; inset: 0; z-index: 100000;
                background: ${t.overlayBg};
                display: flex; align-items: center; justify-content: center;
            }
            #ysc-cl-editor {
                border-radius: 11px; overflow: hidden;
                border: 1px solid ${t.hdrBorder};
                background: ${t.bg};
                box-shadow: 0 8px 28px rgba(0,0,0,0.4);
                font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
                font-size: 17px; color: ${t.lbl};
                display: flex; flex-direction: column;
                width: 560px; max-height: 80vh;
            }
            #ysc-cl-editor .cl-hdr {
                background: ${t.hdrBg}; border-bottom: 1px solid ${t.hdrBorder};
                padding: 11px 14px; font-size: 20px; font-weight: 700;
                color: ${t.title}; letter-spacing: 0.2px;
                display: flex; align-items: center; justify-content: space-between;
                flex-shrink: 0;
            }
            #ysc-cl-editor .cl-hdr-close {
                width: 22px; height: 22px; border-radius: 50%; border: none;
                background: ${t.closeBg}; color: ${t.closeColor};
                font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center;
                transition: background 0.15s;
            }
            #ysc-cl-editor .cl-langcode-row {
                display: flex; align-items: center; gap: 10px;
                padding: 8px 14px; border-bottom: 1px solid ${t.rowBorder};
                flex-shrink: 0;
            }
            #ysc-cl-editor .cl-langcode-lbl {
                font-size: 17px; color: ${t.lbl}; white-space: nowrap;
            }
            #ysc-cl-editor .cl-langcode-inp {
                flex: 1; height: 26px; border-radius: 6px;
                padding: 0 8px; font-size: 17px; outline: none;
                background: ${t.inputBg}; border: 1px solid ${t.inputBorder}; color: ${t.inputColor};
                transition: border-color 0.15s;
            }
            #ysc-cl-editor .cl-langcode-inp:focus { border-color: rgba(204,0,0,0.5); }
            #ysc-cl-editor .cl-langcode-inp::placeholder { color: ${t.lblSub}; opacity: 0.45; }
            #ysc-cl-editor .cl-col-headers {
                display: flex; align-items: center;
                padding: 5px 14px 4px; gap: 8px;
                border-bottom: 1px solid ${t.rowBorder};
                flex-shrink: 0;
            }
            #ysc-cl-editor .cl-col-num  { width: 28px; flex-shrink: 0; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; color: ${t.groupLbl}; }
            #ysc-cl-editor .cl-col-ref  { flex: 1; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; color: ${t.groupLbl}; }
            #ysc-cl-editor .cl-col-val  { flex: 1; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; color: ${t.groupLbl}; }
            #ysc-cl-editor .cl-list {
                overflow-y: auto; overflow-x: hidden; padding: 4px 0;
                flex: 1; min-height: 0;
            }
            #ysc-cl-editor .cl-row {
                display: flex; align-items: flex-start;
                padding: 5px 14px; gap: 8px; min-height: 32px;
                border-bottom: 1px solid ${t.rowBorder};
            }
            #ysc-cl-editor .cl-num {
                width: 28px; flex-shrink: 0; padding-top: 5px;
                font-size: 16px; color: ${t.lblSub}; font-variant-numeric: tabular-nums;
            }
            #ysc-cl-editor .cl-ref-cell {
                flex: 1; font-size: 16px; color: ${t.lblSub};
                background: ${isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)'};
                border: 1px solid ${t.inputBorder}; border-radius: 5px;
                padding: 4px 7px; min-width: 0;
                box-sizing: border-box; line-height: 1.45;
                white-space: pre-wrap; word-break: break-word;
            }
            #ysc-cl-editor .cl-inp {
                flex: 1; border-radius: 5px;
                padding: 4px 7px; font-size: 17px; outline: none; min-width: 0;
                background: ${t.inputBg}; border: 1px solid ${t.inputBorder}; color: ${t.inputColor};
                transition: border-color 0.15s; box-sizing: border-box;
                resize: none; overflow: hidden; line-height: 1.45;
                font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
                display: block; min-height: 26px;
            }
            #ysc-cl-editor .cl-inp:focus { border-color: rgba(204,0,0,0.5); }
            #ysc-cl-editor .cl-footer {
                display: flex; align-items: center; gap: 8px;
                padding: 10px 14px 12px;
                border-top: 1px solid ${t.footerBorder}; background: ${t.footerBg};
                flex-shrink: 0;
            }
            #ysc-cl-editor .cl-btn {
                padding: 6px 12px; border-radius: 7px; border: none;
                font-size: 17px; font-weight: 600; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                transition: opacity 0.12s;
            }
            #ysc-cl-editor .cl-btn:active { opacity: 0.82; }
            #ysc-cl-editor .cl-btn-clear {
                background: transparent;
                border: 1px solid ${isDark ? 'rgba(180,60,60,0.45)' : 'rgba(160,40,40,0.3)'};
                color: ${isDark ? 'rgba(210,100,100,0.8)' : 'rgba(150,40,40,0.75)'};
            }
            #ysc-cl-editor .cl-btn-clear:hover {
                background: ${isDark ? 'rgba(160,0,0,0.18)' : 'rgba(160,40,40,0.08)'};
                border-color: ${isDark ? 'rgba(200,60,60,0.7)' : 'rgba(160,40,40,0.5)'};
            }
            #ysc-cl-editor .cl-btn-secondary {
                background: ${t.btnResetBg}; border: 1px solid ${t.btnResetBorder}; color: ${t.btnResetColor};
            }
            #ysc-cl-editor .cl-btn-save { background: #cc0000; color: #fff; }
            /* Import/Clear confirmation dialog */
            #ysc-cl-confirm-overlay {
                position: fixed; inset: 0; z-index: 100001;
                background: ${t.overlayBg};
                display: flex; align-items: center; justify-content: center;
            }
            #ysc-cl-confirm-dialog {
                border-radius: 11px; overflow: hidden;
                border: 1px solid ${isDark ? 'rgba(204,0,0,0.35)' : 'rgba(204,0,0,0.2)'};
                background: ${t.bg};
                box-shadow: 0 8px 28px rgba(0,0,0,0.4);
                font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
                font-size: 17px; color: ${t.lbl};
                width: 400px; max-width: calc(100vw - 32px);
            }
            #ysc-cl-confirm-dialog.ysc-help-dialog {
                width: 520px; border-color: ${t.sep};
            }
            #ysc-cl-confirm-dialog.ysc-help-dialog .cld-hdr { background: transparent; border-bottom-color: ${t.sep}; }
            #ysc-cl-confirm-dialog.ysc-help-dialog .cld-title { color: ${t.title}; }
            #ysc-cl-confirm-dialog .cld-hdr {
                background: ${isDark ? 'rgba(180,0,0,0.18)' : 'rgba(204,0,0,0.07)'};
                border-bottom: 1px solid ${isDark ? 'rgba(204,0,0,0.25)' : 'rgba(204,0,0,0.15)'};
                padding: 12px 16px 10px;
            }
            #ysc-cl-confirm-dialog .cld-title {
                font-size: 20px; font-weight: 700;
                color: ${isDark ? '#ff6060' : '#cc0000'};
                margin-bottom: 5px;
            }
            #ysc-cl-confirm-dialog .cld-desc {
                font-size: 16px; color: ${t.lblSub}; line-height: 1.5;
            }
            #ysc-cl-confirm-dialog .cld-body {
                padding: 12px 16px;
                border-bottom: 1px solid ${t.rowBorder};
                font-size: 16px; color: ${t.lblSub}; line-height: 1.6;
            }
            #ysc-cl-confirm-dialog .cld-body pre {
                font-family: inherit; margin: 0; white-space: pre-wrap;
            }
            #ysc-cl-confirm-dialog .cld-footer {
                display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 14px 12px;
                background: ${t.footerBg};
            }
            #ysc-cl-confirm-dialog .cld-btn {
                flex: 1; padding: 7px; border-radius: 7px; border: none;
                font-size: 17px; font-weight: 600; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                transition: opacity 0.12s; min-width: 80px;
            }
            #ysc-cl-confirm-dialog .cld-btn:active { opacity: 0.82; }
            #ysc-cl-confirm-dialog .cld-btn-cancel {
                background: ${t.btnResetBg}; border: 1px solid ${t.btnResetBorder}; color: ${t.btnResetColor};
            }
            #ysc-cl-confirm-dialog .cld-btn-export {
                background: ${t.btnResetBg}; border: 1px solid ${t.btnResetBorder}; color: ${t.btnResetColor};
            }
            #ysc-cl-confirm-dialog .cld-btn-confirm { background: #cc0000; color: #fff; }
            /* Danger zone */
            #ysc-settings-panel .ysc-danger-zone {
                margin: 12px 12px 12px;
                border: 1px solid ${isDark ? 'rgba(180,40,40,0.35)' : 'rgba(180,40,40,0.25)'};
                border-radius: 8px;
                padding: 10px 12px;
                background: ${isDark ? 'rgba(140,0,0,0.08)' : 'rgba(180,40,40,0.04)'};
            }
            #ysc-settings-panel .ysc-danger-label {
                /* L3 like the card headers, kept red. */
                font-size: 20px; font-weight: 700;
                color: ${isDark ? '#ff6b6b' : '#c00000'};
                margin-bottom: 8px;
            }
            #ysc-settings-panel .ysc-danger-desc {
                font-size: 16px; color: ${isDark ? 'rgba(200,150,150,0.55)' : 'rgba(140,60,60,0.55)'};
                margin-bottom: 10px; line-height: 1.45;
            }
            #ysc-settings-panel .ysc-btn-reset {
                padding: 6px 14px; border-radius: 7px; font-size: 17px; font-weight: 600;
                cursor: pointer; letter-spacing: 0.2px; transition: all 0.15s;
                background: transparent;
                border: 1px solid ${isDark ? 'rgba(180,60,60,0.45)' : 'rgba(160,40,40,0.3)'};
                color: ${isDark ? 'rgba(210,100,100,0.8)' : 'rgba(150,40,40,0.75)'};
            }
            #ysc-settings-panel .ysc-btn-reset:hover {
                background: ${isDark ? 'rgba(160,0,0,0.18)' : 'rgba(160,40,40,0.08)'};
                border-color: ${isDark ? 'rgba(200,60,60,0.7)' : 'rgba(160,40,40,0.5)'};
            }
            /* Footer */
            #ysc-settings-panel .ysc-footer {
                display: flex; gap: 8px; padding: 12px 16px 14px; flex-shrink: 0;
                border-top: 1px solid ${t.footerBorder}; background: ${t.footerBg};
            }
            #ysc-settings-panel .ysc-btn {
                flex: 1; padding: 8px; border-radius: 8px; border: none;
                font-size: 17px; font-weight: 600; cursor: pointer; letter-spacing: 0.2px;
                transition: opacity 0.12s;
            }
            #ysc-settings-panel .ysc-btn:active { opacity: 0.82; }
            #ysc-settings-panel .ysc-btn-save { background: #cc0000; color: #fff; }
            #ysc-settings-panel .ysc-btn-cancel {
                background: ${t.btnResetBg}; border: 1px solid ${t.btnResetBorder}; color: ${t.btnResetColor};
            }
            /* Reset Confirmation Overlay */
            #ysc-reset-overlay {
                position: fixed; inset: 0; z-index: 100001;
                background: ${t.overlayBg};
                display: flex; align-items: center; justify-content: center;
            }
            #ysc-reset-dialog {
                border-radius: 11px; overflow: hidden;
                border: 1px solid ${isDark ? 'rgba(204,0,0,0.35)' : 'rgba(204,0,0,0.2)'};
                background: ${t.bg};
                box-shadow: 0 8px 28px rgba(0,0,0,0.4);
                font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
                font-size: 17px; color: ${t.lbl};
                width: 300px;
            }
            #ysc-reset-dialog .rd-hdr {
                background: ${isDark ? 'rgba(180,0,0,0.18)' : 'rgba(204,0,0,0.07)'};
                border-bottom: 1px solid ${isDark ? 'rgba(204,0,0,0.25)' : 'rgba(204,0,0,0.15)'};
                padding: 13px 16px 11px;
            }
            #ysc-reset-dialog .rd-hdr-title {
                font-size: 20px; font-weight: 700; color: ${isDark ? '#ff6060' : '#cc0000'};
                display: flex; align-items: center; gap: 7px; margin-bottom: 5px;
            }
            #ysc-reset-dialog .rd-hdr-sub {
                font-size: 16px; color: ${t.lblSub}; line-height: 1.5;
            }
            #ysc-reset-dialog .rd-body {
                padding: 12px 16px;
                border-bottom: 1px solid ${t.rowBorder};
            }
            #ysc-reset-dialog .rd-item {
                font-size: 16px; color: ${t.lblSub};
                padding: 3px 0; display: flex; align-items: center; gap: 7px;
            }
            #ysc-reset-dialog .rd-item::before {
                content: ''; width: 4px; height: 4px; border-radius: 50%;
                background: ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}; flex-shrink: 0;
            }
            #ysc-reset-dialog .rd-note {
                font-size: 16px; font-style: italic; margin-top: 8px; padding-top: 8px;
                border-top: 1px solid ${t.rowBorder};
                color: ${isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.28)'};
            }
            #ysc-reset-dialog .rd-footer {
                display: flex; gap: 8px; padding: 10px 14px 12px;
                background: ${t.footerBg};
            }
            #ysc-reset-dialog .rd-btn {
                flex: 1; padding: 7px; border-radius: 7px; border: none;
                font-size: 17px; font-weight: 600; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                transition: opacity 0.12s;
            }
            #ysc-reset-dialog .rd-btn:active { opacity: 0.82; }
            #ysc-reset-dialog .rd-btn-cancel {
                background: ${t.btnResetBg}; border: 1px solid ${t.btnResetBorder}; color: ${t.btnResetColor};
            }
            #ysc-reset-dialog .rd-btn-cancel:hover { opacity: 0.8; }
            #ysc-reset-dialog .rd-btn-confirm { background: #cc0000; color: #fff; }


            /* ── Color Picker ─────────────────────────────────────────────── */
            /* These rules are injected once and stay in the DOM permanently.  */
            /* They use html[dark] overrides instead of theme tokens so they   */
            /* do not need to be re-injected when dark mode changes.           */
            /* ── Color Picker ── */
            /* ── Shell ── */
            #ysc-cp {
              width: 233px; border-radius: 11px; overflow: hidden;
              background: #fff;
              border: 1px solid rgba(0,0,0,0.2);
              box-shadow: 0 8px 28px rgba(0,0,0,0.13), 0 1px 4px rgba(0,0,0,0.08);
            }

            /* ── Drag handle: the only part that moves the picker; the gradient
                  box below keeps its own drag for picking colours. ── */
            #ysc-cp .cp-drag { height: 14px; cursor: move; display: flex; align-items: center; justify-content: center; touch-action: none; }
            #ysc-cp .cp-drag span { width: 32px; height: 4px; border-radius: 2px; background: rgba(128,128,128,0.45); }

            /* ── Gradient box ── */
            #ysc-cp .cp-grad-wrap {
              padding: 0 9px 0;
            }
            #ysc-cp .cp-grad-box {
              width:100%; height:140px; position:relative; cursor:crosshair;
              border-radius:5px; overflow:hidden;
            }
            #ysc-cp .cp-grad-white { position:absolute;inset:0; background:linear-gradient(to right,#fff,transparent); }
            #ysc-cp .cp-grad-black { position:absolute;inset:0; background:linear-gradient(to bottom,transparent,#000); }
            #ysc-cp .cp-cursor {
              position:absolute; width:12px; height:12px; border-radius:50%;
              border:2px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.25),0 1px 4px rgba(0,0,0,0.3);
              top:28%; left:62%; transform:translate(-50%,-50%); pointer-events:none;
            }

            /* ── Sliders ── */
            #ysc-cp .cp-sliders {
              display:flex; align-items:center; gap:9px;
              padding: 9px 13px 7px;
            }
            #ysc-cp .cp-preview {
              width:32px; height:32px; border-radius:50%; flex-shrink:0;
              border:2px solid rgba(0,0,0,0.15);
            }
            #ysc-cp .cp-tracks { flex:1; display:flex; flex-direction:column; gap:7px; padding-right:4px; }
            #ysc-cp .cp-track-row { display:flex; align-items:center; gap:14px; }
            #ysc-cp .cp-track-lbl {
              width:10px; text-align:center; font-size:16px; font-weight:600;
              user-select:none; flex-shrink:0;
            }
            #ysc-cp .cp-track-lbl.vis  { color:#aaa; }
            #ysc-cp .cp-track-lbl.hide { color:transparent; }
            #ysc-cp .cp-track {
              flex:1; height:12px; border-radius:6px; position:relative;
              cursor:pointer;
            }
            #ysc-cp .cp-track.off { opacity:0.28; cursor:default; pointer-events:none; }
            #ysc-cp .cp-thumb {
              position:absolute; top:50%; transform:translate(-50%,-50%);
              width:14px; height:14px; border-radius:50%; background:#fff;
              border:1.5px solid rgba(0,0,0,0.28);
              box-shadow: 0 1px 3px rgba(0,0,0,0.22);
              pointer-events:none;
            }
            #ysc-cp .cp-track-hue { background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00); }
            #ysc-cp .cp-track-r   { background:linear-gradient(to right,#000,#f00); }
            #ysc-cp .cp-track-g   { background:linear-gradient(to right,#000,#0f0); }
            #ysc-cp .cp-track-b   { background:linear-gradient(to right,#000,#00f); }
            #ysc-cp .cp-track-s   { background:linear-gradient(to right,#bbb,#c43030); }
            #ysc-cp .cp-track-v   { background:linear-gradient(to right,#000,#c43030); }
            #ysc-cp .cp-track-off-bg { background:#ddd; }

            #ysc-cp .cp-sep { height:1px; background:rgba(0,0,0,0.07); margin:0 13px; }

            /* ── Mode tabs ── */
            #ysc-cp .cp-mode-row {
              display:flex; gap:5px; padding:7px 13px 5px;
            }
            #ysc-cp .cp-tab {
              flex:1; padding:3px 0; border-radius:5px; border:1px solid transparent;
              font-size:16px; font-weight:600; cursor:pointer; background:transparent;
              color:#999; letter-spacing:0.03em;
            }
            #ysc-cp .cp-tab.active { background:rgba(0,0,0,0.07); color:#333; border-color:rgba(0,0,0,0.2); }

            /* ── Summary input ── */
            #ysc-cp .cp-summary-row {
              padding:0 13px 7px;
            }
            #ysc-cp .cp-summary {
              width:100%; box-sizing:border-box; padding:5px 8px; font-size:16px;
              border:1px solid rgba(0,0,0,0.15); border-radius:6px; outline:none;
              font-family:"Courier New",monospace; background:#fafafa; color:#333;
              text-align:center;
            }
            #ysc-cp .cp-summary:focus { border-color:rgba(200,0,0,0.35); background:#fff; }
            #ysc-cp .cp-summary.off { opacity:0.32; pointer-events:none; }

            /* ── Bottom row: steppers + actions ── */
            #ysc-cp .cp-bottom {
              display:flex; gap:8px; padding:5px 13px 11px; align-items:flex-start;
            }
            #ysc-cp .cp-steppers { width:105px; flex-shrink:0; flex-grow:0; display:flex; flex-direction:column; gap:9px; }
            #ysc-cp .cp-ch-row { display:flex; align-items:center; gap:5px; }
            #ysc-cp .cp-ch-lbl {
              width:12px; text-align:center; font-size:16px; font-weight:600;
              user-select:none; flex-shrink:0;
            }
            #ysc-cp .cp-ch-lbl.vis  { color:#888; }
            #ysc-cp .cp-ch-lbl.hide { color:transparent; }

            #ysc-cp .cp-stepper {
              display:flex; align-items:center; border:1px solid rgba(0,0,0,0.15);
              border-radius:5px; overflow:hidden; height:22px; flex:1;
            }
            #ysc-cp .cp-stepper.off { opacity:0.38; pointer-events:none; }

            #ysc-cp .cp-s-btn {
              width:22px; height:100%; border:none; background:transparent;
              cursor:pointer; font-size:17px; color:#555; flex-shrink:0;
              display:flex; align-items:center; justify-content:center; line-height:1;
            }
            #ysc-cp .cp-s-btn:hover { background:rgba(0,0,0,0.07); }

            #ysc-cp .cp-s-val {
              flex:1; border:none; outline:none; text-align:center; font-size:16px;
              background:transparent; color:#333; width:0; min-width:0;
              -moz-appearance:textfield;
            }
            #ysc-cp .cp-s-val::-webkit-inner-spin-button,
            #ysc-cp .cp-s-val::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }

            #ysc-cp .cp-stepper.off .cp-s-val { color:transparent; }

            #ysc-cp .cp-actions {
              flex:1; display:flex; flex-direction:column; gap:6px; justify-content:center;
            }
            #ysc-cp .cp-btn {
              width:100%; padding:5px 0; border-radius:6px; border:none;
              font-size:16px; cursor:pointer; transition:opacity 0.1s;
            }
            #ysc-cp .cp-btn:active { opacity:.82; }
            #ysc-cp .cp-btn-cancel { background:#ebebeb; border:1px solid rgba(0,0,0,0.12); color:#666; font-weight:500; }
            #ysc-cp .cp-btn-cancel:hover { background:#e2e2e2; }
            #ysc-cp .cp-btn-ok { background:#cc0000; color:#fff; font-weight:600; }
            #ysc-cp .cp-btn-ok:hover { opacity:.88; }

            /* ── Dark mode overrides ── */
            html[dark] #ysc-cp {
              background: #1f1f1f; border-color: rgba(255,255,255,0.13);
              box-shadow: 0 8px 28px rgba(0,0,0,0.45);
            }
            html[dark] #ysc-cp .cp-track-off-bg { background: #444; }
            html[dark] #ysc-cp .cp-tab.active { background:rgba(255,255,255,0.1); color:#ddd; border-color:rgba(255,255,255,0.18); }
            html[dark] #ysc-cp .cp-tab { color:#666; }
            html[dark] #ysc-cp .cp-summary { background:#2a2a2a; color:#ddd; border-color:rgba(255,255,255,0.15); }
            html[dark] #ysc-cp .cp-summary:focus { background:#313131; }
            html[dark] #ysc-cp .cp-s-val { color:#ddd; }
            html[dark] #ysc-cp .cp-s-btn { color:#aaa; }
            html[dark] #ysc-cp .cp-stepper {
              border-color: rgba(255,255,255,0.13);
              border-left-color: rgba(255,255,255,0.08);
              border-right-color: rgba(255,255,255,0.08);
            }
            html[dark] #ysc-cp .cp-stepper.off .cp-s-btn { color: rgba(255,255,255,0.34); }
            html[dark] #ysc-cp .cp-btn-cancel {
              background: #2e2e2e; border: 1px solid rgba(255,255,255,0.22); color: #fff;
            }
            html[dark] #ysc-cp .cp-btn-cancel:hover { background: #383838; }
            html[dark] #ysc-cp .cp-preview { border-color: rgba(255,255,255,0.15); }
        `;

        // Build the panel HTML. All visible strings come from LANG.
        function makeStepper(val, step) {
            return `<div class="ysc-stepper">
                <button class="ysc-stepper-btn" data-step="-${step}">−</button>
                <input class="ysc-stepper-val" type="number" value="${val}" step="${step}">
                <button class="ysc-stepper-btn" data-step="${step}">+</button>
            </div>`;
        }
        function makeSwatch(color) {
            return `<span class="ysc-swatch" style="background:${color}"></span>`;
        }

        const btnTemplatesStr = '[' + cur['BUTTON_TEMPLATES'].join('],[') + ']';

        const html = `
        <div id="ysc-prefs-wrap">
          <div id="ysc-settings-panel">
            <div class="ysc-hdr">
              <div class="ysc-hdr-left">
                <div class="ysc-yt-logo"><svg width="22" height="15" viewBox="0 0 22 15" xmlns="http://www.w3.org/2000/svg"><rect width="22" height="15" rx="3.5" fill="#ff0000"/><polygon points="9,4.5 9,10.5 14.5,7.5" fill="#fff"/></svg></div>
                <span class="ysc-title">${LANG.panelTitle}</span>
              </div>
              <button class="ysc-close">✕</button>
            </div>
            <div class="ysc-body">
             <div class="ysc-cols">
              <div class="ysc-col">

              <section class="ysc-card">
              <div class="ysc-group">${LANG.sectionPlayback}</div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelDefaultSpeed}<small>${LANG.labelDefaultSpeedSub}</small></div>
                ${makeStepper(cur['DEFAULT_SPEED'], 0.25)}
              </div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelAudioBoost}<small>${LANG.labelAudioBoostSub}</small></div>
                ${makeStepper(cur['AUDIO_BOOST'], 0.5)}
              </div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelStartPaused}<small>${LANG.labelStartPausedSub}</small></div>
                <div class="ysc-toggle${cur['START_PAUSED'] ? ' on' : ''}" id="ysc-tg-startpaused"></div>
              </div>
              </section>

              <section class="ysc-card">
              <div class="ysc-group">${LANG.sectionSpeedButtons}</div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelButtonTemplates}</div>
                <button class="ysc-edit-btn" id="ysc-edit-btns">${LANG.labelBtnEdit}</button>
              </div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelColorSelected}<small>${LANG.labelColorSub}</small></div>
                <div class="ysc-color-row" id="ysc-color-sel-row">
                  <span class="ysc-color-text" id="ysc-color-sel-txt"></span>
                  <span class="ysc-swatch" id="ysc-color-sel-swatch"></span>
                </div>
              </div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelColorNormal}<small>${LANG.labelColorSub}</small></div>
                <div class="ysc-color-row" id="ysc-color-nor-row">
                  <span class="ysc-color-text" id="ysc-color-nor-txt"></span>
                  <span class="ysc-swatch" id="ysc-color-nor-swatch"></span>
                </div>
              </div>
              </section>



              <section class="ysc-card">
              <div class="ysc-group">${LANG.sectionLanguage}</div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelUiLang}</div>
                  <select class="ysc-select" id="ysc-ui-lang">
                    ${[['auto', LANG.optLangAuto], ['en', 'English'], ['zh_tw', '繁體中文'], ['custom', LANG.labelCustomLang]]
                        .map(([v, txt]) => `<option value="${v}"${(window['UI_LANG'] === v) ? ' selected' : ''}>${txt}</option>`).join('')}
                  </select>
              </div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelCustomLangRow}<small>${LANG.labelCustomLangRowSub}</small></div>
                <button class="ysc-edit-btn" id="ysc-edit-lang">${LANG.labelBtnEdit}</button>
              </div>
              </section>

              </div>
              <div class="ysc-col">

              <section class="ysc-card">
              <div class="ysc-group">${LANG.sectionDisplay}</div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelShowRelTime}</div>
                <div class="ysc-toggle${cur['SHOW_RELATIVE_TIME'] ? ' on' : ''}" id="ysc-tg-reltime"></div>
              </div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelFsProgress}<small>${LANG.labelFsProgressSub}</small></div>
                <div class="ysc-toggle${cur['FS_PROGRESS_BAR'] ? ' on' : ''}" id="ysc-tg-fsbar"></div>
              </div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelHideChat}</div>
                <div class="ysc-toggle${cur['HIDE_LIVE_CHAT'] ? ' on' : ''}" id="ysc-tg-hidechat"></div>
              </div>
              </section>

              <section class="ysc-card">
              <div class="ysc-group">${LANG.sectionAutomation}</div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelAutoFullscreenOnPlay}</div>
                <div class="ysc-toggle${cur['FULLSCREEN_ON_START'] ? ' on' : ''}" id="ysc-tg-fsstart"></div>
              </div>
              <div class="ysc-row">
                <div class="ysc-lbl">${LANG.labelAutoFullscreenOnEnd}</div>
                <div class="ysc-toggle${cur['FULLSCREEN_ON_END'] ? ' on' : ''}" id="ysc-tg-fsend"></div>
              </div>
              <div class="ysc-note" id="ysc-fs-note"><span id="ysc-fs-note-txt"></span> <a class="ysc-help-link" id="ysc-fs-help" href="#">${LANG.labelAutoFullscreenLink}</a></div>
              </section>




              <div class="ysc-danger-zone" style="margin:0">
                <div class="ysc-danger-label">${LANG.dangerZoneLabel}</div>
                <div class="ysc-danger-desc">${LANG.dangerZoneDesc}</div>
                <button class="ysc-btn-reset">${LANG.btnRestoreDefault}</button>
              </div>

              </div>
             </div>


            </div>
            <div class="ysc-footer">
              <button class="ysc-btn ysc-btn-cancel">${LANG.btnCancel}</button>
              <button class="ysc-btn ysc-btn-save">${LANG.btnSave}</button>
            </div>
          </div>
        </div>`;

        (document.getElementById('ytd-app') || document.body).insertAdjacentHTML('beforeend', html);

        // ── Dynamic panel width measurement (cached) ──────────────────────────
        // DOM measurements are expensive on a heavy page like YouTube.
        // We compute the widths once and store them in _panelMeasureCache so
        // subsequent panel opens skip the measurement entirely.
        if (!_panelMeasureCache) {
            const measureEl = document.createElement('div');
            // Same font as the L2 item name (18px / 500) so the measured width matches what is drawn.
            measureEl.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;font-size:18px;font-weight:500;';
            document.body.appendChild(measureEl);

            // Measure the widest label string.
            const labels = [
                LANG.labelDefaultSpeed, LANG.labelAudioBoost, LANG.labelShowRelTime,
                LANG.labelColorSelected, LANG.labelColorNormal,
                LANG.labelAutoFullscreenOnPlay, LANG.labelAutoFullscreenOnEnd, LANG.labelButtonTemplates,
                LANG.labelStartPaused, LANG.labelFsProgress, LANG.labelHideChat, LANG.labelUiLang,
                LANG.labelCustomLangRow
            ];
            let maxLblW = 0;
            labels.forEach(txt => {
                measureEl.textContent = txt;
                maxLblW = Math.max(maxLblW, measureEl.scrollWidth);
            });
            // Descriptions (L1, 16px / 400) share the label column; include them so a
            // one-line description does not wrap just because its name is short.
            measureEl.style.fontSize = '16px'; measureEl.style.fontWeight = '400';
            [LANG.labelDefaultSpeedSub, LANG.labelAudioBoostSub, LANG.labelStartPausedSub,
             LANG.labelFsProgressSub, LANG.labelColorSub, LANG.labelCustomLangRowSub].forEach(txt => {
                measureEl.textContent = txt;
                maxLblW = Math.max(maxLblW, measureEl.scrollWidth);
            });
            measureEl.remove();

            // Every right-hand control (stepper, colour row, edit button) is CONTROL_COL_W
            // wide in CSS, so they line up in one column.
            const CONTROL_COL_W = 120;
            // Panel total width: left-pad 16 + widest-label + gap 16 + control column + right-pad 16
            const panelW = 16 + maxLblW + 16 + CONTROL_COL_W + 16;

            // Speed input width in the button-template editor, against the widest
            // realistic value ("3.500"); that editor still uses 17px inputs.
            const speedProbe = document.createElement('div');
            speedProbe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;font-size:17px;';
            speedProbe.textContent = '3.500';
            document.body.appendChild(speedProbe);
            const speedInputW = speedProbe.scrollWidth + 16 + 2; // padding 8×2 + border 2
            speedProbe.remove();

            _panelMeasureCache = { panelW, speedInputW };
        }
        const { panelW, speedInputW } = _panelMeasureCache;

        // Two columns (each as wide as the old single-column panel) when the
        // viewport allows it; otherwise fall back to a single column.
        {
            const panelEl = document.getElementById('ysc-settings-panel');
            const twoColW = 2 * panelW + 16 * 3;
            const twoCol  = window.innerWidth >= twoColW + 32;
            panelEl.classList.toggle('ysc-one-col', !twoCol);
            panelEl.style.width = (twoCol ? twoColW : panelW + 24) + 'px';
        }

        // Initialise the color-row display text and swatch from saved values.
        function cpFormatColor(hexOrCss) {
            const hex = cpCssToHex(hexOrCss) || hexOrCss;
            const rgb = cpHexToRgb(hex);
            if (!rgb) return { display: hexOrCss, hex: hexOrCss };
            return { display: hex.toUpperCase(), hex };
        }
        [
            { rowId: 'ysc-color-sel-row', txtId: 'ysc-color-sel-txt', swatchId: 'ysc-color-sel-swatch', val: cur['COLOR_SELECTED'] },
            { rowId: 'ysc-color-nor-row', txtId: 'ysc-color-nor-txt', swatchId: 'ysc-color-nor-swatch', val: cur['COLOR_NORMAL']  }
        ].forEach(cfg => {
            const row    = document.getElementById(cfg.rowId);
            const txt    = document.getElementById(cfg.txtId);
            const swatch = document.getElementById(cfg.swatchId);
            const parsed = cpFormatColor(cfg.val);
            txt.textContent      = parsed.display;
            swatch.style.background = parsed.hex;
            row.dataset.hex      = parsed.hex;
        });

        const overlay = document.getElementById('ysc-prefs-wrap');
        const panel   = document.getElementById('ysc-settings-panel');

        // ── Stepper interaction: +/− buttons adjust numeric inputs ──
        panel.querySelectorAll('.ysc-stepper').forEach(stepper => {
            const input = stepper.querySelector('.ysc-stepper-val');
            stepper.querySelectorAll('.ysc-stepper-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const step = parseFloat(btn.dataset.step);
                    const val  = parseFloat(input.value) || 0;
                    input.value = Math.round((val + step) * 1000) / 1000;
                });
            });
        });

        // ── Toggle interaction: clicking flips on/off state ──
        panel.querySelectorAll('.ysc-toggle').forEach(toggle => {
            toggle.addEventListener('click', () => toggle.classList.toggle('on'));
        });

        // ── Custom Language editor ───────────────────────────────────────────
        document.getElementById('ysc-edit-lang').addEventListener('click', () => {
            document.getElementById('ysc-cl-overlay')?.remove();

            // ── Helper: get sorted list of LANGS.en keys ──────────────────────
            const enKeys = Object.keys(LANGS.en);

            // ── Parse current custom lang into a key→value map ────────────────
            function parseCurrentLang() {
                const map = {};
                try {
                    const data = JSON.parse(window['CUSTOM_LANG'] || '{}');
                    if (Array.isArray(data.strings)) {
                        for (const e of data.strings) {
                            if (e && e.key) map[e.key] = e.value || '';
                        }
                    }
                } catch {}
                return map;
            }

            // ── Serialise editor rows to CUSTOM_LANG JSON ─────────────────────
            function serialise(langCode) {
                const strings = [];
                clList.querySelectorAll('.cl-row').forEach((row, i) => {
                    const key = row.dataset.key;
                    const val = row.querySelector('.cl-inp').value;
                    strings.push({
                        id:    String(i + 1).padStart(2, '0'),
                        key,
                        value: val
                    });
                });
                const inner = strings.map(e =>
                    `    { "id": ${JSON.stringify(e.id)}, "key": ${JSON.stringify(e.key)}, "value": ${JSON.stringify(e.value)} }`
                ).join(',\n');
                return `{\n  "langCode": ${JSON.stringify(langCode)},\n  "strings": [\n${inner}\n  ]\n}`;
            }

            // ── Export helper ─────────────────────────────────────────────────
            function doExport(langCode, jsonStr) {
                const fn = `ycm-lang-${langCode || 'custom'}.json`;
                const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href = url; a.download = fn;
                document.body.appendChild(a); a.click();
                setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
            }

            // ── Show validation/info overlay (import result or error) ─────────
            function showInfoDialog(title, desc, bodyHtml, hasBody) {
                document.getElementById('ysc-cl-confirm-overlay')?.remove();
                const ov = document.createElement('div');
                ov.id = 'ysc-cl-confirm-overlay';
                ov.innerHTML = _trustedHTML(`
                    <div id="ysc-cl-confirm-dialog">
                        <div class="cld-hdr">
                            <div class="cld-title">${title}</div>
                            <div class="cld-desc">${desc}</div>
                        </div>
                        ${hasBody ? `<div class="cld-body"><pre>${bodyHtml}</pre></div>` : ''}
                        <div class="cld-footer">
                            <button class="cld-btn cld-btn-confirm" id="ysc-cld-ok">${LANG.clImportOkBtn}</button>
                        </div>
                    </div>
                `);
                (document.getElementById('ytd-app') || document.body).appendChild(ov);
                document.getElementById('ysc-cld-ok').addEventListener('click', () => ov.remove());
            }

            // ── Build the editor overlay ──────────────────────────────────────
            const clOverlay = document.createElement('div');
            clOverlay.id = 'ysc-cl-overlay';
            clOverlay.innerHTML = _trustedHTML(`
                <div id="ysc-cl-editor">
                    <div class="cl-hdr">
                        <span>▶ ${LANG.clTitle}</span>
                        <button class="cl-hdr-close" id="ysc-cl-close">✕</button>
                    </div>
                    <div class="cl-langcode-row">
                        <span class="cl-langcode-lbl">${LANG.clLangCodeLabel}:</span>
                        <input class="cl-langcode-inp" id="ysc-cl-langcode"
                               type="text" spellcheck="false"
                               placeholder="${LANG.clLangCodePlaceholder}"
                               value="${(window['CUSTOM_LANG_CODE'] || '')}">
                    </div>
                    <div class="cl-col-headers">
                        <div class="cl-col-num">#</div>
                        <div class="cl-col-ref">${LANG.clColRef}</div>
                        <div class="cl-col-val">${LANG.clColTranslation}</div>
                    </div>
                    <div class="cl-list" id="ysc-cl-list"></div>
                    <div class="cl-footer">
                        <button class="cl-btn cl-btn-clear" id="ysc-cl-clearall">${LANG.clBtnClearAll}</button>
                        <span style="flex:1"></span>
                        <label class="cl-btn cl-btn-secondary" style="cursor:pointer;">
                            ${LANG.clBtnImport}
                            <input type="file" accept=".json" id="ysc-cl-file-inp" style="display:none">
                        </label>
                        <button class="cl-btn cl-btn-secondary" id="ysc-cl-export">${LANG.clBtnExport}</button>
                        <span style="flex:1"></span>
                        <button class="cl-btn cl-btn-secondary" id="ysc-cl-cancel">${LANG.clBtnCancel}</button>
                        <button class="cl-btn cl-btn-save" id="ysc-cl-save">${LANG.clBtnSave}</button>
                    </div>
                </div>
            `);

            (document.getElementById('ytd-app') || document.body).appendChild(clOverlay);

            const clList = document.getElementById('ysc-cl-list');

            // ── Auto-resize helper for textareas ──────────────────────────────
            function clAutoResize(ta) {
                ta.style.height = 'auto';
                ta.style.height = ta.scrollHeight + 'px';
            }

            // ── Populate rows from LANGS.en keys ──────────────────────────────
            const currentMap = parseCurrentLang();
            enKeys.forEach((key, i) => {
                const row = document.createElement('div');
                row.className = 'cl-row';
                row.dataset.key = key;
                const num = String(i + 1).padStart(2, '0');
                const enVal = LANGS.en[key] || '';
                const trVal = currentMap[key] !== undefined ? currentMap[key] : '';
                // Use a div for ref so it wraps naturally (no innerHTML injection via enVal)
                row.innerHTML = _trustedHTML(`
                    <span class="cl-num">${num}</span>
                    <div class="cl-ref-cell"></div>
                    <textarea class="cl-inp" rows="1" spellcheck="false"></textarea>
                `);

                row.querySelector('.cl-ref-cell').textContent = enVal;
                const ta = row.querySelector('.cl-inp');
                ta.value = trVal;
                ta.addEventListener('input', () => clAutoResize(ta));
                clList.appendChild(row);
            });

            // Trigger initial auto-resize after all rows are in the DOM
            requestAnimationFrame(() => {
                clList.querySelectorAll('.cl-inp').forEach(ta => clAutoResize(ta));
            });

            // ── Close / Cancel buttons ────────────────────────────────────────
            document.getElementById('ysc-cl-close').addEventListener('click', () => clOverlay.remove());
            document.getElementById('ysc-cl-cancel').addEventListener('click', () => clOverlay.remove());

            // ── Export button ─────────────────────────────────────────────────
            document.getElementById('ysc-cl-export').addEventListener('click', () => {
                const langCode = document.getElementById('ysc-cl-langcode').value.trim();
                doExport(langCode, serialise(langCode));
            });

            // ── Import button ─────────────────────────────────────────────────
            document.getElementById('ysc-cl-file-inp').addEventListener('change', function() {
                const file = this.files && this.files[0];
                if (!file) return;
                this.value = '';
                const reader = new FileReader();
                reader.onload = (e) => {
                    let data;
                    try {
                        data = JSON.parse(e.target.result);
                    } catch {
                        showInfoDialog(LANG.clImportErrorTitle, LANG.clImportErrorDesc, '', false);
                        return;
                    }
                    if (!data || !Array.isArray(data.strings)) {
                        showInfoDialog(LANG.clImportErrorTitle, LANG.clImportErrorDesc, '', false);
                        return;
                    }

                    // Build import map (last-win)
                    const importMap = {};
                    for (const e of data.strings) {
                        if (e && e.key) importMap[e.key] = e.value || '';
                    }

                    // Apply to editor rows
                    clList.querySelectorAll('.cl-row').forEach(row => {
                        const key = row.dataset.key;
                        if (importMap[key] !== undefined) {
                            const ta = row.querySelector('.cl-inp');
                            ta.value = importMap[key];
                            clAutoResize(ta);
                        }
                    });

                    // Set language code if provided
                    if (data.langCode) {
                        document.getElementById('ysc-cl-langcode').value = data.langCode;
                    }

                    // Compute diff
                    const knownKeys = new Set(enKeys);
                    const importKeys = new Set(Object.keys(importMap));
                    const unknownKeys = [...importKeys].filter(k => !knownKeys.has(k));
                    const missingKeys = enKeys.filter(k => !importKeys.has(k));
                    const totalLoaded = data.strings.length;

                    const hasDiff = unknownKeys.length > 0 || missingKeys.length > 0;
                    if (!hasDiff) return; // Silently close — perfect match

                    // Build report
                    const MAX_ITEMS = 10;
                    let body = `✅ ${totalLoaded} ${LANG.clImportTitle}.\n`;
                    body += `\n⚠️ ${LANG.clImportUnknown} (${unknownKeys.length}):\n`;
                    if (unknownKeys.length === 0) {
                        body += `  (none)\n`;
                    } else if (unknownKeys.length > MAX_ITEMS) {
                        body += `  (${unknownKeys.length} keys)\n`;
                    } else {
                        unknownKeys.forEach(k => { body += `  · ${k}\n`; });
                    }
                    body += `\n⚠️ ${LANG.clImportMissing} (${missingKeys.length}):\n`;
                    if (missingKeys.length === 0) {
                        body += `  (none)\n`;
                    } else if (missingKeys.length > MAX_ITEMS) {
                        body += `  (${missingKeys.length} keys)\n`;
                    } else {
                        missingKeys.forEach(k => { body += `  · ${k}\n`; });
                    }
                    body += `\n${LANG.clImportSafeNote}`;

                    showInfoDialog(LANG.clImportTitle, '', body.replace(/</g,'&lt;').replace(/>/g,'&gt;'), true);
                };
                reader.readAsText(file, 'UTF-8');
            });

            // ── Clear All — two-step confirmation ─────────────────────────────
            document.getElementById('ysc-cl-clearall').addEventListener('click', () => {
                document.getElementById('ysc-cl-confirm-overlay')?.remove();

                // Step 1: ask to export first
                const step1 = document.createElement('div');
                step1.id = 'ysc-cl-confirm-overlay';
                step1.innerHTML = _trustedHTML(`
                    <div id="ysc-cl-confirm-dialog">
                        <div class="cld-hdr">
                            <div class="cld-title">${LANG.clClearStep1Title}</div>
                            <div class="cld-desc">${LANG.clClearStep1Desc}</div>
                        </div>
                        <div class="cld-footer" style="flex-direction:column;gap:6px;">
                            <button class="cld-btn cld-btn-export" id="ysc-cld-export-cont" style="flex:none;width:100%;">${LANG.clClearExportBtn}</button>
                            <button class="cld-btn cld-btn-confirm" id="ysc-cld-skip-cont" style="flex:none;width:100%;">${LANG.clClearSkipBtn}</button>
                            <button class="cld-btn cld-btn-cancel" id="ysc-cld-cancel1" style="flex:none;width:100%;">${LANG.clClearCancelBtn}</button>
                        </div>
                    </div>
                `);

                (document.getElementById('ytd-app') || document.body).appendChild(step1);

                document.getElementById('ysc-cld-cancel1').addEventListener('click', () => step1.remove());

                function proceedToStep2() {
                    step1.remove();
                    // Step 2: final confirm
                    const step2 = document.createElement('div');
                    step2.id = 'ysc-cl-confirm-overlay';
                    step2.innerHTML = _trustedHTML(`
                        <div id="ysc-cl-confirm-dialog">
                            <div class="cld-hdr">
                                <div class="cld-title">${LANG.clClearStep2Title}</div>
                                <div class="cld-desc">${LANG.clClearStep2Desc}</div>
                            </div>
                            <div class="cld-footer">
                                <button class="cld-btn cld-btn-cancel" id="ysc-cld-cancel2">${LANG.clClearCancelBtn}</button>
                                <button class="cld-btn cld-btn-confirm" id="ysc-cld-confirm2">${LANG.clClearConfirmBtn}</button>
                            </div>
                        </div>
                    `);

                    (document.getElementById('ytd-app') || document.body).appendChild(step2);
                    document.getElementById('ysc-cld-cancel2').addEventListener('click', () => step2.remove());
                    document.getElementById('ysc-cld-confirm2').addEventListener('click', () => {
                        step2.remove();
                        // Clear all translation textareas and reset height
                        clList.querySelectorAll('.cl-inp').forEach(ta => {
                            ta.value = '';
                            clAutoResize(ta);
                        });
                    });
                }

                document.getElementById('ysc-cld-export-cont').addEventListener('click', () => {
                    const langCode = document.getElementById('ysc-cl-langcode').value.trim();
                    doExport(langCode, serialise(langCode));
                    proceedToStep2();
                });

                document.getElementById('ysc-cld-skip-cont').addEventListener('click', proceedToStep2);
            });

            // ── Save (OK) button ──────────────────────────────────────────────
            document.getElementById('ysc-cl-save').addEventListener('click', async () => {
                const langCode = document.getElementById('ysc-cl-langcode').value.trim();
                const jsonStr  = serialise(langCode);

                // Persist to GM storage
                await GM.setValue('_YSC-CUSTOM_LANG',      jsonStr);
                await GM.setValue('_YSC-CUSTOM_LANG_CODE', langCode);

                // Update in-memory globals
                window['CUSTOM_LANG']      = jsonStr;
                window['CUSTOM_LANG_CODE'] = langCode;

                // Rebuild active LANG and clear panel measure cache
                LANG = buildActiveLang();
                _panelMeasureCache = null;

                clOverlay.remove();

                // If the settings panel is open, close and reopen it so labels refresh
                if (document.getElementById('ysc-prefs-wrap')) {
                    document.getElementById('ysc-prefs-wrap').remove();
                    openSettingsPanel();
                }
            });
        });



        // ── Button Templates editor ──────────────────────────────────────────
        // Opens a sub-dialog for adding, removing, and reordering speed buttons.
        // Changes are staged in cur['BUTTON_TEMPLATES'] and only take effect
        // after clicking Save in the editor.
        document.getElementById('ysc-edit-btns').addEventListener('click', () => {
            document.getElementById('ysc-bt-overlay')?.remove();

            // speedInputW is already computed and cached in _panelMeasureCache.

            let btDragSrc = null;

            /** Creates a single draggable row in the button template list. */
            function btMakeRow(label, speed) {
                const row = document.createElement('div');
                row.className = 'bt-row';
                row.draggable = true;
                row.innerHTML = _trustedHTML(`
                    <div class="bt-drag-handle" title="${LANG.btSubtitle}">⠿</div>
                    <input class="bt-inp-label" type="text" value="${label}" placeholder="${LANG.btPlaceholderLabel}">
                    <input class="bt-inp-speed" type="number" value="${speed}" step="0.25" placeholder="${LANG.btPlaceholderSpeed}">
                    <button class="bt-del-btn" title="${LANG.rdBtnCancel}">✕</button>
                `);

                row.querySelector('.bt-inp-speed').style.width = speedInputW + 'px';
                row.querySelector('.bt-del-btn').addEventListener('click', () => row.remove());

                row.addEventListener('dragstart', e => {
                    btDragSrc = row;
                    setTimeout(() => row.classList.add('dragging'), 0);
                    e.dataTransfer.effectAllowed = 'move';
                });
                row.addEventListener('dragend', () => {
                    row.classList.remove('dragging');
                    btList.querySelectorAll('.bt-row').forEach(r =>
                        r.classList.remove('drag-over-top', 'drag-over-bottom')
                    );
                    btDragSrc = null;
                });
                row.addEventListener('dragover', e => {
                    e.preventDefault();
                    if (!btDragSrc || btDragSrc === row) return;
                    const mid = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
                    btList.querySelectorAll('.bt-row').forEach(r =>
                        r.classList.remove('drag-over-top', 'drag-over-bottom')
                    );
                    row.classList.add(e.clientY < mid ? 'drag-over-top' : 'drag-over-bottom');
                });
                row.addEventListener('dragleave', () => {
                    row.classList.remove('drag-over-top', 'drag-over-bottom');
                });
                row.addEventListener('drop', e => {
                    e.preventDefault();
                    if (!btDragSrc || btDragSrc === row) return;
                    const mid = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
                    btList.insertBefore(btDragSrc, e.clientY < mid ? row : row.nextSibling);
                    row.classList.remove('drag-over-top', 'drag-over-bottom');
                });
                return row;
            }

            // Build the editor overlay HTML.
            const btOverlay = document.createElement('div');
            btOverlay.id = 'ysc-bt-overlay';
            btOverlay.innerHTML = _trustedHTML(`
                <div id="ysc-bt-editor">
                    <div class="bt-hdr">
                        <span>${LANG.btTitle}</span>
                        <span class="bt-hdr-sub">${LANG.btSubtitle}</span>
                    </div>
                    <div class="bt-col-headers">
                        <div class="bt-col-handle"></div>
                        <div class="bt-col-label">${LANG.btColLabel}</div>
                        <div class="bt-col-speed" id="ysc-bt-col-speed">${LANG.btColSpeed}</div>
                        <div class="bt-col-del"></div>
                    </div>
                    <div class="bt-list" id="ysc-bt-list"></div>
                    <div class="bt-note">${LANG.btSortNote}</div>
                    <div class="bt-dup-err" id="ysc-bt-dup" style="display:none"></div>
                    <div class="bt-add-row">
                        <button class="bt-add-btn" id="ysc-bt-add">
                            <span style="font-size:18px;line-height:1">+</span> ${LANG.btBtnAdd.replace('+ ', '')}
                        </button>
                    </div>
                    <div class="bt-footer">
                        <button class="bt-btn bt-btn-cancel" id="ysc-bt-cancel">${LANG.btBtnCancel}</button>
                        <button class="bt-btn bt-btn-save" id="ysc-bt-save">${LANG.btBtnSave}</button>
                    </div>
                </div>
            `);

            (document.getElementById('ytd-app') || document.body).appendChild(btOverlay);

            document.getElementById('ysc-bt-col-speed').style.width = speedInputW + 'px';

            const btList = document.getElementById('ysc-bt-list');

            // Populate with existing button definitions.
            cur['BUTTON_TEMPLATES'].forEach(([l, s]) => btList.appendChild(btMakeRow(l, s)));

            // Size the list to exactly fit all rows without scrolling.
            requestAnimationFrame(() => {
                const firstRow = btList.querySelector('.bt-row');
                if (firstRow) {
                    const rowH = firstRow.getBoundingClientRect().height;
                    btList.style.height = (rowH * cur['BUTTON_TEMPLATES'].length + 8) + 'px';
                }
            });

            // Add a new empty row at the bottom of the list.
            document.getElementById('ysc-bt-add').addEventListener('click', () => {
                btList.appendChild(btMakeRow('', ''));
                btList.scrollTop = btList.scrollHeight;
            });

            document.getElementById('ysc-bt-cancel').addEventListener('click', () => btOverlay.remove());

            // Collect rows, validate, and stage changes in cur['BUTTON_TEMPLATES'].
            document.getElementById('ysc-bt-save').addEventListener('click', () => {
                const rows = btList.querySelectorAll('.bt-row');
                const result = [];
                rows.forEach(row => {
                    const label = row.querySelector('.bt-inp-label').value.trim();
                    const speed = parseFloat(row.querySelector('.bt-inp-speed').value);
                    if (label && !isNaN(speed)) result.push([label, speed]);
                });
                if (result.length === 0) return;
                // Two buttons with one speed make no sense (which one is selected?).
                const dup = result.some((a, i) => result.some((b, j) => j < i && _sameRate(a[1], b[1])));
                const err = document.getElementById('ysc-bt-dup');
                if (dup) { err.textContent = LANG.btDupSpeed; err.style.display = 'block'; return; }
                err.style.display = 'none';
                // Always stored in ascending speed order, whatever order the rows
                // were dragged into (the temporary speed button needs the order).
                cur['BUTTON_TEMPLATES'] = _sortTemplates(result);
                btOverlay.remove();
                refreshContainers();
            });
        });

        // ── Color Picker — color conversion utilities ────────────────────────
        // All conversions operate on plain numeric values; no DOM involvement.
        /**
         * Converts HSV (hue 0-360, saturation 0-1, value 0-1) to RGB (0-255 each).
         */
        function cpHsvToRgb(h, s, v) {
            const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
            let r = 0, g = 0, b = 0;
            if      (h < 60)  { r=c; g=x; b=0; }
            else if (h < 120) { r=x; g=c; b=0; }
            else if (h < 180) { r=0; g=c; b=x; }
            else if (h < 240) { r=0; g=x; b=c; }
            else if (h < 300) { r=x; g=0; b=c; }
            else              { r=c; g=0; b=x; }
            return { r: Math.round((r+m)*255), g: Math.round((g+m)*255), b: Math.round((b+m)*255) };
        }
        function cpRgbToHsv(r, g, b) {
            // Normalise to 0-1 range before computing HSV components.
            r/=255; g/=255; b/=255;
            const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
            let h=0, s=(max===0?0:d/max), v=max;
            if (d!==0) {
                if      (max===r) h = ((g-b)/d + (g<b?6:0)) / 6;
                else if (max===g) h = ((b-r)/d + 2) / 6;
                else              h = ((r-g)/d + 4) / 6;
            }
            return { h: h*360, s, v };
        }
        function cpRgbToHex(r, g, b) {
            return '#' + [r,g,b].map(v=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0')).join('');
        }
        function cpHexToRgb(hex) {
            const m = hex.replace('#','').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
            if (!m) return null;
            return { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) };
        }
        /**
         * Converts any valid CSS color string to a #rrggbb hex string.
         * Uses the browser's own style engine for parsing, so named colors,
         * rgb(), hsl() etc. are all handled correctly.
         */
        function cpCssToHex(css) {
            try {
                const el = document.createElement('div');
                el.style.display = 'none';
                el.style.color = css;
                document.body.appendChild(el);
                const computed = getComputedStyle(el).color;
                el.remove();
                const m = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                if (!m) return null;
                return cpRgbToHex(parseInt(m[1]), parseInt(m[2]), parseInt(m[3]));
            } catch { return null; }
        }

        // ── Open the color picker when a color-row is clicked ────────────────
        [
            { rowId: 'ysc-color-sel-row', txtId: 'ysc-color-sel-txt', swatchId: 'ysc-color-sel-swatch' },
            { rowId: 'ysc-color-nor-row', txtId: 'ysc-color-nor-txt', swatchId: 'ysc-color-nor-swatch' }
        ].forEach(cfg => {
            const row    = document.getElementById(cfg.rowId);
            const txt    = document.getElementById(cfg.txtId);
            const swatch = document.getElementById(cfg.swatchId);

            row.addEventListener('click', () => {
                document.getElementById('ysc-cp-wrap')?.remove();

                const initHex = row.dataset.hex || cpCssToHex(txt.textContent) || '#cc0000';
                const initRgb = cpHexToRgb(initHex) || {r:204,g:0,b:0};
                const initHsv = cpRgbToHsv(initRgb.r, initRgb.g, initRgb.b);

                /**
                 * cpState is the single source of truth for the picker.
                 * h/s/v are always authoritative. r/g/b are derived from them
                 * via cpSyncFromHsv(). When the user edits RGB fields, the
                 * inverse cpSyncFromRgb() updates h/s/v (preserving h for
                 * near-grey colours to avoid hue jumping).
                 */
                const cpState = {
                    h: initHsv.h, s: initHsv.s, v: initHsv.v,
                    r: initRgb.r, g: initRgb.g, b: initRgb.b,
                    mode: 'RGB'
                };
                function cpSyncFromHsv() {
                    const rgb = cpHsvToRgb(cpState.h, cpState.s, cpState.v);
                    cpState.r = rgb.r; cpState.g = rgb.g; cpState.b = rgb.b;
                }
                // Sync h/s/v from r/g/b. Preserves h when colour is near-grey
                // (saturation < 0.02) to avoid the hue slider jumping.
                function cpSyncFromRgb() {
                    const hsv = cpRgbToHsv(cpState.r, cpState.g, cpState.b);
                    cpState.s = hsv.s; cpState.v = hsv.v;
                    if (hsv.s > 0.02) cpState.h = hsv.h;
                }

                document.body.insertAdjacentHTML('beforeend', `
<div id="ysc-cp-wrap" style="position:fixed;inset:0;z-index:2300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);">
  <div id="ysc-cp">
    <div class="cp-drag" title="${LANG.cpDragHint}"><span></span></div>
    <div class="cp-grad-wrap">
    <div class="cp-grad-box">
      <div class="cp-grad-white"></div>
      <div class="cp-grad-black"></div>
      <div class="cp-cursor"></div>
    </div>
    </div>
    <div class="cp-sliders">
      <div class="cp-preview"></div>
      <div class="cp-tracks">
        <div class="cp-track-row">
          <span class="cp-track-lbl vis cp-lbl1">H</span>
          <div class="cp-track cp-track-hue cp-track1" data-track="1"><div class="cp-thumb"></div></div>
        </div>
        <div class="cp-track-row">
          <span class="cp-track-lbl hide cp-lbl2">·</span>
          <div class="cp-track cp-track-off-bg off cp-track2" data-track="2"><div class="cp-thumb"></div></div>
        </div>
        <div class="cp-track-row">
          <span class="cp-track-lbl hide cp-lbl3">·</span>
          <div class="cp-track cp-track-off-bg off cp-track3" data-track="3"><div class="cp-thumb"></div></div>
        </div>
      </div>
    </div>
    <div class="cp-sep"></div>
    <div class="cp-mode-row">
      <button class="cp-tab" data-mode="HEX">HEX</button>
      <button class="cp-tab active" data-mode="RGB">RGB</button>
      <button class="cp-tab" data-mode="HSV">HSV</button>
    </div>
    <div class="cp-summary-row">
      <input class="cp-summary" type="text" spellcheck="false">
    </div>
    <div class="cp-bottom">
      <div class="cp-steppers">
        <div class="cp-ch-row">
          <span class="cp-ch-lbl vis cp-lbl-ch1"></span>
          <div class="cp-stepper cp-stepper1">
            <button class="cp-s-btn cp-s-dec1">−</button>
            <input class="cp-s-val cp-val1" type="number">
            <button class="cp-s-btn cp-s-inc1">+</button>
          </div>
        </div>
        <div class="cp-ch-row">
          <span class="cp-ch-lbl vis cp-lbl-ch2"></span>
          <div class="cp-stepper cp-stepper2">
            <button class="cp-s-btn cp-s-dec2">−</button>
            <input class="cp-s-val cp-val2" type="number">
            <button class="cp-s-btn cp-s-inc2">+</button>
          </div>
        </div>
        <div class="cp-ch-row">
          <span class="cp-ch-lbl vis cp-lbl-ch3"></span>
          <div class="cp-stepper cp-stepper3">
            <button class="cp-s-btn cp-s-dec3">−</button>
            <input class="cp-s-val cp-val3" type="number">
            <button class="cp-s-btn cp-s-inc3">+</button>
          </div>
        </div>
      </div>
      <div class="cp-actions">
        <button class="cp-btn cp-btn-cancel">${LANG.btnCancel}</button>
        <button class="cp-btn cp-btn-ok">OK</button>
      </div>
    </div>
  </div>
</div>`);

                const cpOverlay = document.getElementById('ysc-cp-wrap');
                const cp        = document.getElementById('ysc-cp');

                // DOM refs
                const gradBox   = cp.querySelector('.cp-grad-box');
                const cpCursor  = cp.querySelector('.cp-cursor');
                const cpPreview = cp.querySelector('.cp-preview');
                const track1    = cp.querySelector('.cp-track1');
                const track2    = cp.querySelector('.cp-track2');
                const track3    = cp.querySelector('.cp-track3');
                const lbl1      = cp.querySelector('.cp-lbl1');
                const lbl2      = cp.querySelector('.cp-lbl2');
                const lbl3      = cp.querySelector('.cp-lbl3');
                const summary   = cp.querySelector('.cp-summary');
                const tabs      = cp.querySelectorAll('.cp-tab');
                const val1      = cp.querySelector('.cp-val1');
                const val2      = cp.querySelector('.cp-val2');
                const val3      = cp.querySelector('.cp-val3');
                const lblCh1    = cp.querySelector('.cp-lbl-ch1');
                const lblCh2    = cp.querySelector('.cp-lbl-ch2');
                const lblCh3    = cp.querySelector('.cp-lbl-ch3');
                const step1     = cp.querySelector('.cp-stepper1');
                const step2     = cp.querySelector('.cp-stepper2');
                const step3     = cp.querySelector('.cp-stepper3');

                // Drag the picker by its top handle so it can be moved off the
                // settings it is editing. Offset is applied with transform, which
                // does not disturb the centring flex layout of the overlay.
                {
                    const handle = cp.querySelector('.cp-drag');
                    let dx = 0, dy = 0, sx = 0, sy = 0, dragging = false;
                    handle.addEventListener('pointerdown', e => {
                        dragging = true; sx = e.clientX - dx; sy = e.clientY - dy;
                        handle.setPointerCapture(e.pointerId); e.preventDefault();
                    });
                    handle.addEventListener('pointermove', e => {
                        if (!dragging) return;
                        dx = e.clientX - sx; dy = e.clientY - sy;
                        cp.style.transform = `translate(${dx}px, ${dy}px)`;
                    });
                    const end = () => { dragging = false; };
                    handle.addEventListener('pointerup', end);
                    handle.addEventListener('pointercancel', end);
                }

                /**
                 * Re-renders the entire color picker UI from cpState.
                 * Called after every state mutation (drag, stepper, tab switch, etc).
                 */
                function cpRender() {
                    const { h, s, v, r, g, b, mode } = cpState;

                    // Gradient box background always reflects the current hue at full saturation/value.
                    const hueRgb = cpHsvToRgb(h, 1, 1);
                    gradBox.style.background = `rgb(${hueRgb.r},${hueRgb.g},${hueRgb.b})`;

                    // Crosshair cursor: s maps to X, (1-v) maps to Y.
                    cpCursor.style.left = (s * 100) + '%';
                    cpCursor.style.top  = ((1 - v) * 100) + '%';

                    const hex = (mode === 'RGB') ? cpRgbToHex(r, g, b) : cpRgbToHex(...Object.values(cpHsvToRgb(h, s, v)));
                    cpPreview.style.background = hex;

                    if (mode === 'RGB') {
                        // Track 1 = Hue slider (rainbow); tracks 2/3 disabled in RGB mode.
                        track1.style.background = '';
                        track1.classList.remove('off','cp-track-off-bg');
                        track1.classList.add('cp-track-hue');
                        track1.querySelector('.cp-thumb').style.left = (h / 360 * 100) + '%';
                        lbl1.textContent = 'H'; lbl1.className = 'cp-track-lbl vis cp-lbl1';
                        track2.style.background = ''; track2.classList.add('off','cp-track-off-bg');
                        track3.style.background = ''; track3.classList.add('off','cp-track-off-bg');
                        lbl2.textContent = '·'; lbl2.className = 'cp-track-lbl hide cp-lbl2';
                        lbl3.textContent = '·'; lbl3.className = 'cp-track-lbl hide cp-lbl3';
                        // Steppers show R / G / B channel values.
                        lblCh1.textContent = 'R'; lblCh2.textContent = 'G'; lblCh3.textContent = 'B';
                        step1.classList.remove('off'); step2.classList.remove('off'); step3.classList.remove('off');
                        val1.value = r; val2.value = g; val3.value = b;
                        summary.value = `${r}, ${g}, ${b}`;
                    } else if (mode === 'HSV') {
                        // Track 1 = H (rainbow), Track 2 = S (grey→hue), Track 3 = V (black→hue).
                        track1.style.background = '';
                        track1.classList.remove('off','cp-track-off-bg');
                        track1.classList.add('cp-track-hue');
                        track1.querySelector('.cp-thumb').style.left = (h / 360 * 100) + '%';
                        lbl1.textContent = 'H'; lbl1.className = 'cp-track-lbl vis cp-lbl1';
                        const hFullSat = cpHsvToRgb(h, 1, v);
                        const hNoSat   = cpHsvToRgb(h, 0, v);
                        track2.style.background = `linear-gradient(to right, rgb(${hNoSat.r},${hNoSat.g},${hNoSat.b}), rgb(${hFullSat.r},${hFullSat.g},${hFullSat.b}))`;
                        track2.querySelector('.cp-thumb').style.left = (s * 100) + '%';
                        track2.classList.remove('off','cp-track-off-bg');
                        lbl2.textContent = 'S'; lbl2.className = 'cp-track-lbl vis cp-lbl2';
                        const hFullV = cpHsvToRgb(h, s, 1);
                        track3.style.background = `linear-gradient(to right, #000, rgb(${hFullV.r},${hFullV.g},${hFullV.b}))`;
                        track3.querySelector('.cp-thumb').style.left = (v * 100) + '%';
                        track3.classList.remove('off','cp-track-off-bg');
                        lbl3.textContent = 'V'; lbl3.className = 'cp-track-lbl vis cp-lbl3';
                        lblCh1.textContent = 'H'; lblCh2.textContent = 'S'; lblCh3.textContent = 'V';
                        step1.classList.remove('off'); step2.classList.remove('off'); step3.classList.remove('off');
                        val1.value = Math.round(h);
                        val2.value = Math.round(s * 100);
                        val3.value = Math.round(v * 100);
                        summary.value = `${Math.round(h)}, ${Math.round(s*100)}, ${Math.round(v*100)}`;
                    } else { // HEX mode
                        // Track 1 = H (rainbow); tracks 2/3 disabled (same as RGB mode).
                        track1.style.background = '';
                        track1.classList.remove('off','cp-track-off-bg');
                        track1.classList.add('cp-track-hue');
                        track1.querySelector('.cp-thumb').style.left = (h / 360 * 100) + '%';
                        lbl1.textContent = 'H'; lbl1.className = 'cp-track-lbl vis cp-lbl1';
                        track2.style.background = ''; track2.classList.add('off','cp-track-off-bg');
                        track3.style.background = ''; track3.classList.add('off','cp-track-off-bg');
                        lbl2.textContent = '·'; lbl2.className = 'cp-track-lbl hide cp-lbl2';
                        lbl3.textContent = '·'; lbl3.className = 'cp-track-lbl hide cp-lbl3';
                        lblCh1.textContent = ''; lblCh2.textContent = ''; lblCh3.textContent = '';
                        step1.classList.add('off'); step2.classList.add('off'); step3.classList.add('off');
                        val1.value = ''; val2.value = ''; val3.value = '';
                        summary.value = hex.toUpperCase();
                    }
                }

                // ── Generic track drag helper ─────────────────────────────────
                // Handles both mouse and touch events; calls onMove(ratio 0-1)
                // and re-renders once per animation frame to avoid flooding the
                // main thread with synchronous DOM updates on every mousemove.
                let _cpRafPending = false;
                function cpRenderRaf() {
                    if (!_cpRafPending) {
                        _cpRafPending = true;
                        requestAnimationFrame(() => { cpRender(); _cpRafPending = false; });
                    }
                }

                function cpTrackDrag(trackEl, onMove) {
                    function move(e) {
                        const rect = trackEl.getBoundingClientRect();
                        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
                        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                        onMove(ratio);
                        cpRenderRaf();
                    }
                    function up() {
                        document.removeEventListener('mousemove', move);
                        document.removeEventListener('mouseup',  up);
                        document.removeEventListener('touchmove', move);
                        document.removeEventListener('touchend',  up);
                    }
                    trackEl.addEventListener('mousedown',  e => { e.preventDefault(); move(e); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); });
                    trackEl.addEventListener('touchstart', e => { e.preventDefault(); move(e); document.addEventListener('touchmove', move); document.addEventListener('touchend', up); }, {passive:false});
                }

                // Track 1: Hue — active in all three modes.
                cpTrackDrag(track1, ratio => {
                    cpState.h = ratio * 360;
                    cpSyncFromHsv();
                });

                // Track 2: Saturation — active only in HSV mode.
                cpTrackDrag(track2, ratio => {
                    if (cpState.mode === 'HSV') {
                        cpState.s = ratio;
                        cpSyncFromHsv();
                    }
                });

                // Track 3: Value — active only in HSV mode.
                cpTrackDrag(track3, ratio => {
                    if (cpState.mode === 'HSV') {
                        cpState.v = ratio;
                        cpSyncFromHsv();
                    }
                });

                // ── Gradient box drag: adjusts saturation (X) and value (Y) ──
                function gradMove(e) {
                    e.preventDefault();
                    const rect = gradBox.getBoundingClientRect();
                    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
                    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
                    cpState.s = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                    cpState.v = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
                    cpSyncFromHsv();
                    cpRenderRaf();
                }
                function gradUp() {
                    document.removeEventListener('mousemove', gradMove);
                    document.removeEventListener('mouseup',  gradUp);
                    document.removeEventListener('touchmove', gradMove);
                    document.removeEventListener('touchend',  gradUp);
                }
                gradBox.addEventListener('mousedown',  e => { gradMove(e); document.addEventListener('mousemove', gradMove); document.addEventListener('mouseup', gradUp); });
                gradBox.addEventListener('touchstart', e => { gradMove(e); document.addEventListener('touchmove', gradMove); document.addEventListener('touchend', gradUp); }, {passive:false});

                // ── Channel steppers: −/+ with hold-to-repeat (400ms delay, 60ms interval) ──
                function cpStepperChange(idx, delta, rawVal) {
                    const { mode } = cpState;
                    if (mode === 'HEX') return;
                    if (mode === 'RGB') {
                        // Apply change to the matching r/g/b channel, then sync back to h/s/v.
                        const keys = ['r','g','b'];
                        const key = keys[idx-1];
                        if (rawVal !== undefined) cpState[key] = Math.max(0, Math.min(255, parseInt(rawVal)||0));
                        else cpState[key] = Math.max(0, Math.min(255, cpState[key] + delta));
                        cpSyncFromRgb();
                    } else if (mode === 'HSV') {
                        const hsvVals = [Math.round(cpState.h), Math.round(cpState.s*100), Math.round(cpState.v*100)];
                        if (rawVal !== undefined) hsvVals[idx-1] = parseFloat(rawVal)||0;
                        else hsvVals[idx-1] += delta;
                        hsvVals[0] = ((hsvVals[0] % 360) + 360) % 360;
                        hsvVals[1] = Math.max(0, Math.min(100, hsvVals[1]));
                        hsvVals[2] = Math.max(0, Math.min(100, hsvVals[2]));
                        cpState.h = hsvVals[0]; cpState.s = hsvVals[1]/100; cpState.v = hsvVals[2]/100;
                        cpSyncFromHsv();
                    }
                    cpRender();
                }
                function cpBindHold(btn, idx, delta) {
                    let holdTimer = null, holdInterval = null;
                    function start(e) {
                        e.preventDefault();
                        cpStepperChange(idx, delta);
                        holdTimer = setTimeout(() => {
                            holdInterval = setInterval(() => cpStepperChange(idx, delta), 60);
                        }, 400);
                    }
                    function stop() {
                        clearTimeout(holdTimer); clearInterval(holdInterval);
                        holdTimer = null; holdInterval = null;
                    }
                    btn.addEventListener('mousedown',  start);
                    btn.addEventListener('touchstart', start, {passive:false});
                    btn.addEventListener('mouseup',    stop);
                    btn.addEventListener('mouseleave', stop);
                    btn.addEventListener('touchend',   stop);
                    btn.addEventListener('touchcancel',stop);
                    // Prevent click from firing again after the mousedown/mouseup sequence.
                    btn.addEventListener('click', e => e.preventDefault());
                }
                [[val1,step1,1],[val2,step2,2],[val3,step3,3]].forEach(([valEl, stepEl, idx]) => {
                    cpBindHold(stepEl.querySelector('.cp-s-btn:first-child'), idx, -1);
                    cpBindHold(stepEl.querySelector('.cp-s-btn:last-child'),  idx, +1);
                    valEl.addEventListener('change', () => cpStepperChange(idx, 0, valEl.value));
                    valEl.addEventListener('keydown', e => { if (e.key==='Enter') cpStepperChange(idx, 0, valEl.value); });
                });

                // ── Summary text input: accepts HEX, "r,g,b", "h,s,v", or CSS names ──
                function cpSummaryCommit() {
                    const raw = summary.value.trim();
                    const mode = cpState.mode;
                    function cpSetFromRgb(rgb) {
                        cpState.r=rgb.r; cpState.g=rgb.g; cpState.b=rgb.b;
                        cpSyncFromRgb();
                        cpRender();
                    }
                    // #rrggbb or rrggbb
                    if (/^#?[0-9a-f]{6}$/i.test(raw.replace(/\s/g,''))) {
                        const hex = raw.startsWith('#') ? raw : '#'+raw;
                        const rgb = cpHexToRgb(hex);
                        if (rgb) cpSetFromRgb(rgb);
                        return;
                    }
                    // Three comma-separated numbers
                    const m3 = raw.match(/^([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)$/);
                    if (m3) {
                        if (mode === 'RGB') {
                            cpSetFromRgb({
                                r: Math.max(0,Math.min(255,parseInt(m3[1])||0)),
                                g: Math.max(0,Math.min(255,parseInt(m3[2])||0)),
                                b: Math.max(0,Math.min(255,parseInt(m3[3])||0))
                            });
                        } else if (mode === 'HSV') {
                            cpState.h = ((parseFloat(m3[1])%360)+360)%360;
                            cpState.s = Math.max(0,Math.min(100,parseFloat(m3[2])||0))/100;
                            cpState.v = Math.max(0,Math.min(100,parseFloat(m3[3])||0))/100;
                            cpSyncFromHsv(); cpRender();
                        }
                        return;
                    }
                    // Any other CSS colour name/value
                    const hex = cpCssToHex(raw);
                    if (hex) { const rgb = cpHexToRgb(hex); if (rgb) cpSetFromRgb(rgb); }
                }
                summary.addEventListener('change', cpSummaryCommit);
                summary.addEventListener('keydown', e => { if (e.key==='Enter') cpSummaryCommit(); });

                // ── Mode tabs: sync state bidirectionally before switching ──
                tabs.forEach(tab => {
                    tab.addEventListener('click', () => {
                        tabs.forEach(t => t.classList.remove('active'));
                        tab.classList.add('active');
                        const newMode = tab.dataset.mode;
                        // Ensure both representations are in sync before the mode changes.
                        if (cpState.mode === 'RGB') {
                            cpSyncFromRgb();
                        } else {
                            cpSyncFromHsv();
                        }
                        cpState.mode = newMode;
                        cpRender();
                    });
                });

                // ── Confirm / cancel the color picker ──
                function cpClose() {
                    cpOverlay.remove();
                    }
                function cpOK() {
                    const rgbVal = (cpState.mode === 'RGB')
                        ? { r: cpState.r, g: cpState.g, b: cpState.b }
                        : cpHsvToRgb(cpState.h, cpState.s, cpState.v);
                    const hex = cpRgbToHex(rgbVal.r, rgbVal.g, rgbVal.b);

                    // The settings row always shows #HEX: a fixed-width short form keeps the
                    // control column aligned (RGB( 255, 255, 255 ) was twice as wide).
                    const displayVal = hex.toUpperCase();

                    // Write selected color back to the color-row (display text, swatch, dataset).
                    txt.textContent         = displayVal;
                    swatch.style.background = hex;
                    row.dataset.hex         = hex;
                    cpOverlay.remove();
                    }
                cp.querySelector('.cp-btn-cancel').addEventListener('click', cpClose);
                cp.querySelector('.cp-btn-ok').addEventListener('click', cpOK);
                // The overlay background is intentionally non-dismissible;
                // the user must click OK or Cancel to exit the color picker.

                cpRender();
            });
        });

        // ── Panel close ──────────────────────────────────────────────────────
        // Removes the overlay. The <style> tag is intentionally left in the
        // DOM so it doesn't trigger a full page style recalculation on reopen.
        function closePanel() {
            overlay.remove();
        }
        panel.querySelector('.ysc-close').addEventListener('click', closePanel);
        panel.querySelector('.ysc-btn-cancel').addEventListener('click', closePanel);
        overlay.addEventListener('click', e => { if (e.target === overlay) closePanel(); });
        document.addEventListener('keydown', function onEsc(e) {
            if (e.key === 'Escape') { closePanel(); document.removeEventListener('keydown', onEsc); }
        });

        // ── Save handler ─────────────────────────────────────────────────────
        // Reads all control states, persists to GM storage, updates window
        // globals, then refreshes the player UI to reflect changes immediately.
        panel.querySelector('.ysc-btn-save').addEventListener('click', async () => {
            const steppers = panel.querySelectorAll('.ysc-stepper .ysc-stepper-val');
            const isOn     = id => document.getElementById(id).classList.contains('on');

            const newSpeed   = parseFloat(steppers[0].value);
            const newBoost   = parseFloat(steppers[1].value);
            const newRelTime = isOn('ysc-tg-reltime');
            const selRow     = document.getElementById('ysc-color-sel-row');
            const norRow     = document.getElementById('ysc-color-nor-row');
            const newColSel  = selRow.dataset.hex || '';
            const newColNor  = norRow.dataset.hex || '';
            const newFS      = isOn('ysc-tg-fsstart');
            const newFSEnd   = isOn('ysc-tg-fsend');
            const newPaused  = isOn('ysc-tg-startpaused');
            const newFsBar   = isOn('ysc-tg-fsbar');
            const newHideCh  = isOn('ysc-tg-hidechat');
            const newUiLang  = document.getElementById('ysc-ui-lang').value;
            const newUseCL   = newUiLang === 'custom';

            // Persist all changed settings in parallel to avoid sequential
            // GM.setValue round-trips stalling the UI before the panel closes.
            const saves = [];
            if (!isNaN(newSpeed))                    saves.push(GM.setValue('_YSC-DEFAULT_SPEED',      newSpeed));
            if (!isNaN(newBoost) && newBoost >= 1)   saves.push(GM.setValue('_YSC-AUDIO_BOOST',        newBoost));
            saves.push(GM.setValue('_YSC-SHOW_RELATIVE_TIME', newRelTime));
            if (newColSel)                           saves.push(GM.setValue('_YSC-COLOR_SELECTED',     newColSel));
            if (newColNor)                           saves.push(GM.setValue('_YSC-COLOR_NORMAL',       newColNor));
            saves.push(GM.setValue('_YSC-FULLSCREEN_ON_START', newFS));
            saves.push(GM.setValue('_YSC-FULLSCREEN_ON_END',   newFSEnd));
            saves.push(GM.setValue('_YSC-START_PAUSED',        newPaused));
            saves.push(GM.setValue('_YSC-FS_PROGRESS_BAR',     newFsBar));
            saves.push(GM.setValue('_YSC-HIDE_LIVE_CHAT',      newHideCh));
            saves.push(GM.setValue('_YSC-BUTTON_TEMPLATES',   JSON.stringify(cur['BUTTON_TEMPLATES'])));
            saves.push(GM.setValue('_YSC-USE_CUSTOM_LANG',    newUseCL));
            saves.push(GM.setValue('_YSC-UI_LANG',            newUiLang));
            await Promise.all(saves);

            // Update in-memory globals immediately so the rest of the script
            // sees the new values without waiting for a page reload.
            if (!isNaN(newSpeed))                  window['DEFAULT_SPEED']        = newSpeed;
            if (!isNaN(newBoost) && newBoost >= 1) {
                window['AUDIO_BOOST'] = newBoost;
                $(newBoost === 1 ? 'video[ycm-audio]' : 'video').each(function(){ applyAudioBoost(this, true); });
            }
            window['SHOW_RELATIVE_TIME']  = newRelTime;
            if (newColSel) window['COLOR_SELECTED'] = newColSel;
            if (newColNor) window['COLOR_NORMAL']   = newColNor;
            window['FULLSCREEN_ON_START'] = newFS;
            window['FULLSCREEN_ON_END']   = newFSEnd;
            window['START_PAUSED']        = newPaused;
            window['FS_PROGRESS_BAR']     = newFsBar;
            window['HIDE_LIVE_CHAT']      = newHideCh;
            window['BUTTON_TEMPLATES']    = cur['BUTTON_TEMPLATES'];
            _applyPageFlags();

            // If the interface language changed, rebuild LANG (applied right away:
            // refreshContainers below rebuilds the player bar with the new strings)
            // and clear the panel width cache so the next open re-measures.
            if (newUiLang !== window['UI_LANG']) {
                window['UI_LANG']         = newUiLang;
                window['USE_CUSTOM_LANG'] = newUseCL;
                LANG = buildActiveLang();
                _panelMeasureCache = null;
            }

            closePanel();
            refreshContainers();
        });

        // ── Auto-fullscreen note: warn loudly when fullscreen-on-play is on but
        //    Start Paused is off (auto-started videos then need a browser setting).
        function updateFsNote() {
            const fsOn     = document.getElementById('ysc-tg-fsstart').classList.contains('on');
            const pausedOn = document.getElementById('ysc-tg-startpaused').classList.contains('on');
            const warn     = fsOn && !pausedOn;
            document.getElementById('ysc-fs-note').classList.toggle('ysc-warn', warn);
            document.getElementById('ysc-fs-note-txt').textContent = warn ? LANG.fsNoteWarn : (pausedOn ? LANG.fsNoteOk : LANG.fsNoteHint);
        }
        updateFsNote();
        for (const tid of ['ysc-tg-fsstart', 'ysc-tg-startpaused']) {
            document.getElementById(tid).addEventListener('click', () => setTimeout(updateFsNote, 0));
        }

        // ── Auto-fullscreen help dialog ──────────────────────────────────────
        // Reuses the custom-language confirm dialog styles.
        panel.querySelector('#ysc-fs-help').addEventListener('click', e => {
            e.preventDefault();
            document.getElementById('ysc-cl-confirm-overlay')?.remove();
            const ov = document.createElement('div');
            ov.id = 'ysc-cl-confirm-overlay';
            ov.innerHTML = _trustedHTML(`
                <div id="ysc-cl-confirm-dialog" class="ysc-help-dialog">
                    <div class="cld-hdr">
                        <div class="cld-title">${LANG.fsHelpTitle}</div>
                        <div class="cld-desc">${LANG.fsHelpDesc}</div>
                    </div>
                    <div class="cld-body cld-rich">${LANG.fsHelpBody}</div>
                    <div class="cld-footer">
                        <button class="cld-btn cld-btn-confirm" id="ysc-cld-ok">${LANG.clImportOkBtn}</button>
                    </div>
                </div>`);
            (document.getElementById('ytd-app') || document.body).appendChild(ov);
            ov.querySelector('#ysc-cld-ok').addEventListener('click', () => ov.remove());
            ov.addEventListener('click', ev => { if (ev.target === ov) ov.remove(); });
        });

        // ── Restore defaults handler ─────────────────────────────────────────
        // Shows a confirmation dialog before wiping all GM storage values.
        panel.querySelector('.ysc-btn-reset').addEventListener('click', () => {
            document.getElementById('ysc-reset-overlay')?.remove();

            const rdOverlay = document.createElement('div');
            rdOverlay.id = 'ysc-reset-overlay';
            rdOverlay.innerHTML = _trustedHTML(`
                <div id="ysc-reset-dialog">
                    <div class="rd-hdr">
                        <div class="rd-hdr-title">${LANG.rdTitle}</div>
                        <div class="rd-hdr-sub">${LANG.rdSub.replace('\n', '<br>')}</div>
                    </div>
                    <div class="rd-body">
                        <div class="rd-item">${LANG.rdItemSpeed}</div>
                        <div class="rd-item">${LANG.rdItemTemplates}</div>
                        <div class="rd-item">${LANG.rdItemColors}</div>
                        <div class="rd-item">${LANG.rdItemRelTime}</div>
                        <div class="rd-item">${LANG.rdItemFullscreen}</div>
                        <div class="rd-item">${LANG.rdItemExtras}</div>
                        <div class="rd-note">${LANG.rdCustomLangNote}</div>
                    </div>
                    <div class="rd-footer">
                        <button class="rd-btn rd-btn-cancel" id="ysc-rd-cancel">${LANG.rdBtnCancel}</button>
                        <button class="rd-btn rd-btn-confirm" id="ysc-rd-confirm">${LANG.rdBtnConfirm}</button>
                    </div>
                </div>
            `);

            (document.getElementById('ytd-app') || document.body).appendChild(rdOverlay);

            document.getElementById('ysc-rd-cancel').addEventListener('click', () => rdOverlay.remove());

            document.getElementById('ysc-rd-confirm').addEventListener('click', async () => {
                rdOverlay.remove();
                // Delete all stored values in parallel, then reset in-memory globals.
                await Promise.all(Object.keys(defaults).map(name => GM.deleteValue('_YSC-' + name)));
                for (let name in defaults) {
                    window[name] = (name === 'BUTTON_TEMPLATES') ? JSON.parse(defaults[name]) : defaults[name];
                }
                window['UI_LANG'] = 'auto';
                window['USE_CUSTOM_LANG'] = false;
                LANG = buildActiveLang();
                _panelMeasureCache = null;
                _applyPageFlags();
                closePanel();
                refreshContainers();
            });
        });
    }

    GM_registerMenuCommand(LANG.menuSettings, openSettingsPanel);

    // ─────────────────────────────────────────────────────────────────────────
    // PAGE VISIBILITY HELPER
    // Detects the browser-specific visibilitychange event name and provides a
    // small utility to check if the tab is currently visible, used to throttle
    // polling intervals when the tab is in the background.
    // ─────────────────────────────────────────────────────────────────────────
    const _visApi = (() => {
        for (const prefix of ['', 'webkit', 'moz', 'ms']) {
            const prop = prefix ? prefix + 'Hidden' : 'hidden';
            if (prop in document) return { prop, evt: prefix + 'visibilitychange' };
        }
        return { prop: 'hidden', evt: 'visibilitychange' };
    })();

    /** Returns true if the page is currently visible. Optionally registers a callback. */
    function isPageVisible(onChange) {
        if (onChange) document.addEventListener(_visApi.evt, onChange);
        return !document[_visApi.prop];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SPEED LOOKUP
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Determines the playback speed to apply for the current video.
     *
     * @param {object} params
     * @param {Array}  params.channel   - Array of {id, name} objects for the channel(s).
     * @param {number} [params.defspeed] - Override default speed (e.g. 1x for music/VEVO).
     * @param {boolean}[params.force1x]  - Force 1x (e.g. live streams).
     * @returns {[number, string]} Tuple of [speed, reason].
     */
    async function resolveChannelSpeed(params = {}) {
        // Look up a stored value for each credited channel in order: @handle
        // first, then display name (legacy). The first non-empty hit wins.
        let stored = null;
        for (const ch of params.channel) {
            let hit = await GM.getValue(ch.id);
            if (hit == null) hit = await GM.getValue(ch.name);
            if (hit != null) { stored = hit; break; }
        }

        let result;
        if (params.force1x) {
            result = [1, 'forcing 1x (live?)'];
        } else if (typeof stored === 'number' && stored) {
            result = [stored, 'channelspeed'];
        } else if (Number.isInteger(params.defspeed)) {
            result = [params.defspeed, 'overwritten default (music?)'];
        } else {
            result = [DEFAULT_SPEED, 'default'];
        }

        if (params.defspeed === null) delete params.defspeed;
        if (params.force1x === false) delete params.force1x;
        [params.chosenspeed, params.chosenreason] = result;
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PLAYER CONTROL BAR
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Handles a click on a speed button in the control bar.
     * Updates the visual selection highlight and sets video.playbackRate.
     */
    function onSpeedButtonClick(evt) {
        const slot   = evt.target.parentNode.id.replace('ycm-bar', '');
        const btn    = $(evt.target);
        const rate   = parseFloat(btn.attr('ycm-speed'));
        const vidSel = 'video[ycm-video="' + slot + '"]';

        const bar = evt.target.parentNode;
        if (!$(vidSel).length) rewireMonitoredPlayers();

        const vid = $(vidSel)[0];
        try {
            _setRate(vid, rate);                 // also keeps the speed guardian in sync
            syncSpeedButtons(bar, rate);         // ratechange does this too; do it now for instant feedback
        } catch (err) {
            console.log('YSC: onSpeedButtonClick failed, retrying', evt, err);
            setTimeout(() => onSpeedButtonClick(evt), 1000);
            return;
        }
        if (SHOW_RELATIVE_TIME) {
            try { updateRelativeTime(vid); } catch (_) { /* non-fatal */ }
        }
        updateBookmarkState(slot);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CAPTION (SUBTITLE) CONTROLLER
    //
    // YouTube's subtitle system is asynchronous: the button may not exist or
    // may not respond immediately when the video loads. This controller uses
    // a combination of polling retries (for the "enable" case) and a
    // MutationObserver on caption segments (for the "disable" case) to
    // reliably apply the user's saved caption preference.
    //
    // Visual state uses two independent widgets:
    //   • Caption button — the CURRENT state, mirrored from the native button
    //     (red segment on the icon's bottom edge = on; dimmed = no captions)
    //   • Pill switch   — the SAVED default for the channel (ycm-cc-saved)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns the YouTube native subtitle toggle button (.ytp-subtitles-button)
     * associated with the ycm-bar of the given id.
     */
    function getPlayerSubtitleBtn(id) {
        let container = $('#ycm-bar' + id);
        if (container.length === 0) return $();
        let player = container.closest('#movie_player, #c4-player, .html5-video-player');
        if (player.length === 0) return $();
        let btn = player.find('.ytp-subtitles-button');
        return btn;
    }

    /**
     * Clicks the native YouTube subtitle button to match the requested state,
     * then syncs the button colors. Falls back to a color-only update when
     * the native button is not available (e.g. videos with no subtitles).
     *
     * @param {boolean} shouldBeOn  Target caption state.
     * @param {number}  id          ycm-bar numeric id.
     */
    function toggleCC(shouldBeOn, id) {
        // Stop any active CC controller so it doesn't fight the user's explicit choice.
        if (window._ysc_cc_stop && window._ysc_cc_stop[id]) {
            window._ysc_cc_stop[id]('user manual toggle via cc button');
        }
        let container = $('#ycm-bar' + id);

        /** Records the desired state (read by saveChannelDefaults as a fallback). */
        function updateColorOnly(activeState) {
            container.attr('ycm-cc-live', activeState ? 'on' : 'off');
            syncCCVisuals(id);
        }

        updateColorOnly(shouldBeOn);
        let btn = getPlayerSubtitleBtn(id);

        if (btn.length && btn.css('display') !== 'none') {
            let isPressed = btn.attr('aria-pressed') === 'true';
            if (isPressed !== shouldBeOn) {
                btn.click();
            }
            setTimeout(() => {
                let newState = btn.attr('aria-pressed') === 'true';
                if (newState !== shouldBeOn) {
                    console.log('YSC: YT button ignored click. Updating visual color only.');
                    updateColorOnly(shouldBeOn);
                } else {
                    syncCCVisuals(id);
                }
            }, 50);

        } else {
            // Native button unavailable: color-only update.
            updateColorOnly(shouldBeOn);
        }
    }

    /**
     * Re-renders the caption button and pill from the native button state and
     * the saved default, then refreshes the bookmark's changed-state dot.
     *
     * @param {number} id  ycm-bar numeric id.
     */
    function syncCCVisuals(id) {
        const barEl = document.getElementById('ycm-bar' + id);
        if (!barEl) return;
        _renderCaptionWidgets(barEl, id);
        updateBookmarkState(id);
    }

    /**
     * Attaches observers to the native subtitle button:
     *
     * 1. MutationObserver on aria-pressed: whenever the subtitle state changes
     *    or its icon changes (for any reason — our code, YouTube auto-load, the
     *    C shortcut), update ycm-cc-live and re-render our caption widgets.
     *
     * 2. mousedown listener with isTrusted: detects genuine physical user clicks
     *    on the native button. programmatic element.click() does NOT produce a
     *    mousedown event, so isTrusted alone is sufficient to distinguish real
     *    user interaction. On detection, stop any active CC controller so it no
     *    longer fights the user's choice.
     *
     * Guards against duplicate attachment with the ycm-observed attribute.
     *
     * @param {number} id  ycm-bar numeric id.
     */
    function observeCCButton(id) {
        let btn = getPlayerSubtitleBtn(id);
        if (btn.length && !btn.attr('ycm-observed')) {
            btn.attr('ycm-observed', 'true');

            // 1. Visual sync: aria-pressed and icon (availability) changes.
            let pending = false;
            let observer = new MutationObserver(function() {
                if (pending) return;
                pending = true;
                requestAnimationFrame(() => {
                    pending = false;
                    let isOn = btn.attr('aria-pressed') === 'true';
                    $('#ycm-bar' + id).attr('ycm-cc-live', isOn ? 'on' : 'off');
                    syncCCVisuals(id);
                });
            });
            observer.observe(btn[0], { attributes: true, childList: true, subtree: true,
                                       attributeFilter: ['aria-pressed', 'aria-disabled', 'style', 'fill-opacity', 'd'] });

            // 2. Controller stop: genuine user mousedown on the native button.
            btn[0].addEventListener('mousedown', function(e) {
                if (e.isTrusted && window._ysc_cc_stop && window._ysc_cc_stop[id]) {
                    window._ysc_cc_stop[id]('user clicked native CC button');
                }
            }, { capture: true });

            syncCCVisuals(id);
        }
    }

    /**
     * Starts the caption auto-apply controller for the given container.
     *
     * The controller runs after the video starts playing and attempts to
     * set captions to the target state. It stops as soon as the user
     * manually interacts with any caption control.
     *
     * For targetState = true (enable):  retries up to MAX_TRIES times
     *   at RETRY_INTERVAL_MS intervals; succeeds when a caption segment appears.
     *
     * For targetState = false (disable): watches for caption segments via
     *   MutationObserver and clicks them off; guard resets on each 'playing'
     *   event and expires after MAX_PLAY_TIME_MS.
     *
     * @param {number}  id             ycm-bar numeric id.
     * @param {boolean} targetState    true = enable captions, false = disable.
     * @param {Array}   clickListeners Pre-registered early click guards from applySavedCaptions.
     */
    function startCCController(id, targetState, clickListeners) {
        const MAX_PLAY_TIME_MS  = 20000; // Disable mode: guard expires 20s after each play event.
        const RETRY_INTERVAL_MS = 1000;  // Enable mode: interval between attempts.
        const MAX_TRIES         = 20;    // Enable mode: give up after this many attempts.
        const COOLDOWN_MS       = 1000;  // Disable mode: minimum time between close clicks.

        let stopped = false;

        // Enable mode state
        let tries = 0;
        let retryTimer = null;

        // Disable mode state
        let isCoolingDown = false;
        let guardTimer = null;

        // Shared
        let captionObserver = null;
        let videoEl = $('video[ycm-video="' + id + '"]')[0];

        /** Tears down all timers, observers, and event listeners. */
        function stopAll(reason) {
            if (stopped) return;
            stopped = true;
            if (captionObserver) { captionObserver.disconnect(); captionObserver = null; }
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            if (guardTimer) { clearTimeout(guardTimer); guardTimer = null; }
            clickListeners.forEach(({ el, fn }) => el.removeEventListener('click', fn));
            clickListeners = [];
            if (videoEl) {
                videoEl.removeEventListener('playing', onPlaying);
                videoEl.removeEventListener('pause',   onPause);
            }
            if (window._ysc_cc_stop && window._ysc_cc_stop[id] === stopAll) {
                delete window._ysc_cc_stop[id];
            }
            console.log('YSC: CC controller stopped - ' + reason);
            syncCCVisuals(id);
        }

        // Register stop function so toggleCC can halt this controller on demand.
        if (!window._ysc_cc_stop) window._ysc_cc_stop = {};
        window._ysc_cc_stop[id] = stopAll;

        // ── Enable logic ──────────────────────────────────────────────────────
        /**
         * Attempts to enable captions via player.toggleSubtitlesOn() or a direct
         * button click. Schedules the next retry until MAX_TRIES is reached.
         */
        function doRetry() {
            if (stopped) return;
            tries++;
            console.log('YSC: CC open retry attempt ' + tries);

            let player = document.getElementById('movie_player');
            let btn = getPlayerSubtitleBtn(id);

            if (player && btn.length) {
                if (player.isSubtitlesOn && player.isSubtitlesOn()) {
                    // Captions appear open but have not rendered; force close then reopen.
                    console.log('YSC: Forcing close before reopen.');
                    btn.click();
                    setTimeout(() => {
                        if (stopped) return;
                        if (player.toggleSubtitlesOn) { player.toggleSubtitlesOn(); }
                        else { btn.click(); }
                    }, 500);
                } else {
                    if (player.toggleSubtitlesOn) { player.toggleSubtitlesOn(); }
                    else { btn.click(); }
                }
            }

            // Schedule next retry before checking limit so the final attempt also runs.
            if (tries < MAX_TRIES) {
                retryTimer = setTimeout(doRetry, RETRY_INTERVAL_MS);
            } else {
                stopAll('max retries reached');
            }
        }

        // ── Disable logic ─────────────────────────────────────────────────────
        /** Resets the 20-second guard timer each time playback resumes. */
        function onPlaying() {
            if (stopped) return;
            if (guardTimer) { clearTimeout(guardTimer); guardTimer = null; }
            console.log('YSC: CC close guard reset - 20s from now.');
            guardTimer = setTimeout(() => { stopAll('guard time elapsed'); }, MAX_PLAY_TIME_MS);
        }

        /** Pauses the guard timer while the video is paused. */
        function onPause() {
            if (stopped) return;
            if (guardTimer) { clearTimeout(guardTimer); guardTimer = null; }
            console.log('YSC: CC close guard paused.');
        }

        // ── Caption segment observer (shared by both modes) ───────────────────
        /**
         * Watches the player DOM for .ytp-caption-segment elements.
         * Enable mode:  stops when a segment appears (success).
         * Disable mode: clicks the subtitle button off whenever a segment appears.
         */
        function startCaptionObserver() {
            let playerEl = document.getElementById('movie_player');
            if (!playerEl) return;

            captionObserver = new MutationObserver(() => {
                if (stopped) return;
                let hasSegment = !!playerEl.querySelector('.ytp-caption-segment');

                if (targetState === true) {
                    if (hasSegment) { stopAll('caption segment detected (open success)'); }
                } else {
                    if (hasSegment && !isCoolingDown) {
                        isCoolingDown = true;
                        let btn = getPlayerSubtitleBtn(id);
                        if (btn.length) {
                            btn.click();
                            console.log('YSC: CC close - caption detected, clicking off.');
                        }
                        setTimeout(() => { isCoolingDown = false; }, COOLDOWN_MS);
                    }
                }
            });

            captionObserver.observe(playerEl, { childList: true, subtree: true });
        }

        // ── Entry point: wait for the first 'playing' event ───────────────────
        /**
         * Called once when the video begins playing for the first time.
         * Starts the appropriate logic branch for the target state.
         */
        function onFirstPlaying() {
            if (stopped) return;
            console.log('YSC: playing event detected, starting CC controller (targetState=' + targetState + ').');

            startCaptionObserver();

            if (targetState === true) {
                doRetry();
            } else {
                // Disable: reset guard on every play, clear on every pause.
                onPlaying();
                videoEl.addEventListener('playing', onPlaying);
                videoEl.addEventListener('pause',   onPause);
            }
        }

        if (videoEl) {
            let firstPlayingFired = false;
            const guardedFirstPlaying = function() {
                if (firstPlayingFired || stopped) return;
                firstPlayingFired = true;
                onFirstPlaying();
            };
            videoEl.addEventListener('playing', guardedFirstPlaying, { once: true });
            // If the video is already playing at setup time (SPA navigation), trigger immediately.
            if (!videoEl.paused) {
                console.log('YSC: Video already playing at CC controller setup, triggering immediately.');
                setTimeout(guardedFirstPlaying, 50);
            }
        } else {
            // Fallback: no video element found; start with a fixed delay.
            console.log('YSC: No video element found, starting CC controller with fallback delay.');
            startCaptionObserver();
            if (targetState === true) {
                retryTimer = setTimeout(doRetry, 5000);
            } else {
                guardTimer = setTimeout(() => { stopAll('guard time elapsed'); }, MAX_PLAY_TIME_MS);
            }
        }
    }

    /**
     * Reads the saved caption preference for the current channel set and applies
     * it using startCCController. Also sets up early click guards to prevent the
     * controller from overriding a user action that occurs before playing starts.
     *
     * The pill is updated immediately (UI-first) so the user sees their saved
     * preference without waiting for the video to begin.
     *
     * @param {number} id           ycm-bar numeric id.
     * @param {Array}  channelNames Array of {id, name} objects for the channel(s).
     */
    async function applySavedCaptions(id, channelNames) {
        let savedState = null;

        // Search each credited channel in priority order.
        for (let c of channelNames) {
            let val = await GM.getValue(c.id + '_captions', null);
            if (val !== null) { savedState = val; break; }
        }

        let container = $('#ycm-bar' + id);
        if (container.length) {
            // Pill shows the saved default immediately (before the video starts).
            if (savedState === null) container[0].removeAttribute('ycm-cc-saved');
            else container[0].setAttribute('ycm-cc-saved', savedState ? 'on' : 'off');
            syncCCVisuals(id);
        }

        if (savedState !== null) {
            container.attr('ycm-cc-live', savedState ? 'on' : 'off');

            // Register click guards before the controller starts so that any user
            // interaction between now and the first 'playing' event is captured.
            let clickListeners = [];
            let pendingStop = false;

            function addEarlyClickListener(el, fn) {
                el.addEventListener('click', fn);
                clickListeners.push({ el, fn });
            }

            function onEarlyUserClick(reason) {
                pendingStop = true;
                clickListeners.forEach(({ el, fn }) => el.removeEventListener('click', fn));
                clickListeners = [];
                console.log('YSC: User action before controller start - ' + reason);
                syncCCVisuals(id);
            }

            let ytBtn = getPlayerSubtitleBtn(id);
            if (ytBtn.length) {
                addEarlyClickListener(ytBtn[0], function(e) {
                    if (e.isTrusted) onEarlyUserClick('native subtitle button');
                });
            }
            let ccEl = container.find('[ycm-btn="cc"]')[0];
            if (ccEl) addEarlyClickListener(ccEl, function(e) { if (e.isTrusted) onEarlyUserClick('caption button'); });

            // Abort if the user already acted during the async caption lookup above.
            if (pendingStop) return;

            startCCController(id, savedState, clickListeners);
        }

        // Start observing the native button for state changes after a brief delay.
        setTimeout(() => { observeCCButton(id); }, 1000);

        // If there is no saved preference, record YouTube's current subtitle
        // state as the live state so the caption button is rendered correctly.
        if (savedState === null) {
            // The player button may not reflect the final state immediately;
            // try once now and once after a short delay as a fallback.
            function initNoCCSavedState() {
                let container = $('#ycm-bar' + id);
                if (container.length === 0) return;
                if (container.attr('ycm-cc-live') !== undefined) return; // user already clicked
                let btn = getPlayerSubtitleBtn(id);
                let isOn = btn.length ? btn.attr('aria-pressed') === 'true' : false;
                container.attr('ycm-cc-live', isOn ? 'on' : 'off');
                syncCCVisuals(id);
            }
            initNoCCSavedState();
            setTimeout(initNoCCSavedState, 1500);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // START-PAUSED / FULLSCREEN ON PLAY
    //
    // Browsers grant requestFullscreen() only for a short window after a real
    // click or key press ("transient user activation"). So instead of trying
    // to go fullscreen when a video starts by itself, we:
    //
    //   1. Optionally hold every newly opened video paused (START_PAUSED).
    //      "Newly opened" = the initial page load (incl. links opened in a new
    //      tab) or an in-site navigation that the user just triggered. Playlist
    //      / autoplay-next navigations happen without user input and are left
    //      alone, so they keep playing.
    //   2. When the user presses Play, the 'play' event arrives inside that
    //      activation window, and clicking YouTube's own fullscreen button
    //      succeeds in Chrome, Edge and Firefox without extra settings.
    //
    // All of this runs from capture-phase listeners on document, because media
    // events do not bubble and YouTube may start playback before our per-player
    // setup (initPlayers) has run.
    // ─────────────────────────────────────────────────────────────────────────

    // The listeners themselves live in EARLY PLAY HOLD at the top of the script.

    /** True when YouTube has finished loading the current page (see _navFinishedFor). */
    function _pageLoadFinished() {
        return _navFinishedFor !== null && _navFinishedFor === _currentVideoKey();
    }

    /**
     * True when fullscreen shows the video, not the whole page. YouTube puts
     * ytd-app into fullscreen and switches the layout through
     * ytd-watch-flexy[fullscreen]; without that attribute the whole page
     * (playlist, comments) is shown fullscreen.
     */
    function _fsLayoutOk() {
        if (!document.fullscreenElement) return false;
        const flexy = document.querySelector('ytd-watch-flexy');
        return !flexy || flexy.hasAttribute('fullscreen') || !!document.fullscreenElement.closest('#movie_player, #c4-player');
    }

    /**
     * Enters fullscreen by clicking YouTube's own fullscreen button.
     * Succeeds when called within the user-activation window that follows a
     * Play press; a rejected attempt is harmless and is retried on the next
     * play. ycm-fs-done is only set after fullscreen actually happened, so
     * leaving fullscreen and pressing Play again does not re-enter it.
     *
     * 1. Wait until YouTube has finished loading the page (yt-navigate-finish
     *    for this video). Going fullscreen earlier failed: the page-load
     *    completion reset the watch layout while the browser stayed
     *    fullscreen. Wait at most FS_LOAD_WAIT_MS after the user's press
     *    (activation lasts ~5 s and YouTube requests fullscreen ~0.5 s after
     *    the click), then click anyway and leave the rest to the guard.
     * 2. YouTube may request fullscreen a while after the click (a single
     *    check at 600 ms saw "not fullscreen" and gave up, then the whole page
     *    went fullscreen). So watch fullscreenchange for FS_ENTER_WATCH_MS.
     * 3. If the browser went fullscreen but YouTube did not switch the layout
     *    (it missed fullscreenchange while still loading), re-send
     *    fullscreenchange + resize until it does — see the FULLSCREEN GUARD.
     *
     * @param {HTMLVideoElement} video  The video element that started playing.
     */
    const FS_LOAD_WAIT_MS = 3500;      // measured from the user's Play press
    const FS_AFTER_LOAD_MS = 300;      // let YouTube finish re-rendering after yt-navigate-finish
    const FS_ENTER_WATCH_MS = 10000;   // how long after the click fullscreen may still start
    const FS_LAYOUT_SETTLE_MS = 400;   // give YouTube's own layout switch time before judging
    function tryAutoFullscreen(video) {
        if (!window['FULLSCREEN_ON_START']) return;
        if (video.getAttribute('ycm-fs-done')) return;
        if (document.fullscreenElement) { video.setAttribute('ycm-fs-done', 'true'); return; }
        const player = video.closest('#movie_player, .html5-video-player');
        if (!player) return;

        const pressedAt = _lastUserInput;
        let clicked = false;
        const attempt = (why) => {
            if (clicked) return;
            clicked = true;
            document.removeEventListener('yt-navigate-finish', onFinish);
            clearTimeout(deadline);
            const fsBtn = player.querySelector('.ytp-fullscreen-button');
            if (!fsBtn) { _fsLog('auto fullscreen: no fullscreen button'); return; }
            _fsLog(`auto fullscreen: clicking (${why}, ${Math.round(performance.now() - pressedAt)}ms after Play)`);
            const clickedAt = performance.now();
            let handled = false;
            const onEnter = () => {
                if (handled || !document.fullscreenElement) return;
                handled = true;
                cleanup();
                video.setAttribute('ycm-fs-done', 'true');
                _fsLog(`auto fullscreen: entered ${Math.round(performance.now() - clickedAt)}ms after click`);
                setTimeout(() => {
                    if (!document.fullscreenElement) return;
                    // Either way the fullscreen guard keeps watching the layout.
                    _fsLog(_fsLayoutOk() ? 'auto fullscreen: video fullscreen OK'
                                         : 'auto fullscreen: whole page went fullscreen (guard repairing)');
                }, FS_LAYOUT_SETTLE_MS);
            };
            const giveUp = setTimeout(() => {
                if (handled) return;
                handled = true;
                cleanup();
                _fsLog('auto fullscreen: not granted within 10 s (no recent user input?)');
            }, FS_ENTER_WATCH_MS);
            const cleanup = () => { clearTimeout(giveUp); document.removeEventListener('fullscreenchange', onEnter); };
            document.addEventListener('fullscreenchange', onEnter);
            fsBtn.click();
            onEnter();   // in case fullscreen started synchronously
        };
        const onFinish = () => setTimeout(() => attempt('page load finished'), FS_AFTER_LOAD_MS);
        const deadline = setTimeout(() => attempt('page still loading, waited the maximum'),
            Math.max(0, FS_LOAD_WAIT_MS - (performance.now() - pressedAt)));
        if (_pageLoadFinished()) { attempt('page already loaded'); return; }
        _fsLog('auto fullscreen: waiting for the page to finish loading');
        document.addEventListener('yt-navigate-finish', onFinish);
    }

    /**
     * FULLSCREEN GUARD — keeps the video layout for as long as fullscreen lasts.
     *
     * Checking once after entering was not enough: when Play is pressed while
     * the watch page is still loading, fullscreen starts correctly and then
     * YouTube's page-load completion (yt-navigate-finish) resets
     * ytd-watch-flexy, so the browser stays fullscreen with the normal page
     * (masthead, playlist, comments) and YouTube's own button cannot switch
     * back. Auto fullscreen now waits for the page load to avoid this; the
     * guard covers the rest (manual fullscreen, slow pages). While fullscreen
     * covers the player, whenever the layout is lost:
     *   1. log the state (attributes, player class, sizes) for diagnosis;
     *   2. keep re-sending fullscreenchange + resize (harmless) in case YouTube
     *      re-applies its layout (in v1.3.3 real YouTube ignored this);
     *   3. still lost after FS_HINT_MS → stay fullscreen and show a hint
     *      (never exit by ourselves: that looks like a broken feature).
     * Setting ytd-watch-flexy[fullscreen] ourselves was tried in v1.3.3 and
     * removed: the outer layout switched but the player did not (black
     * screen, a clickable layer over everything).
     */
    const FS_GUARD_EVERY_MS = 500;
    const FS_HINT_MS = 10000;
    let _fsGuard = null;

    function _fsCoversPlayer() {
        const el = document.fullscreenElement;
        return !!el && !el.closest('#movie_player, #c4-player') && !!el.querySelector('#movie_player');
    }

    /** One-line snapshot of the fullscreen-related state, for the log. */
    function _fsStateDump() {
        const attrs = (el, skip) => el ? [...el.attributes].map(a => a.name).filter(n => !skip.test(n)).join(' ') : 'none';
        const rect = el => { if (!el) return 'none'; const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); };
        const fe = document.fullscreenElement, p = document.querySelector('#movie_player');
        return [
            'fsEl=' + (fe ? fe.tagName.toLowerCase() + (fe.id ? '#' + fe.id : '') : 'none'),
            'app=[' + attrs(document.querySelector('ytd-app'), /^(class|style|data-)/) + ']',
            'flexy=[' + attrs(document.querySelector('ytd-watch-flexy'), /^(class|style|data-|role|video-id|hidden-action)/) + ']',
            'player.ytp-fullscreen=' + !!(p && p.classList.contains('ytp-fullscreen')),
            'player=' + rect(p), 'video=' + rect(p && p.querySelector('video')),
            'vp=' + innerWidth + 'x' + innerHeight
        ].join(' ');
    }

    function _startFsGuard() {
        if (_fsGuard || !_fsCoversPlayer()) return;
        const pageEvents = ['yt-navigate-finish', 'yt-page-data-updated', 'yt-player-updated'];
        const st = { brokenSince: 0, hinted: false, resending: false };
        const check = why => {
            if (st.resending) return;                         // our own synthetic events
            if (!document.fullscreenElement) { stop(); return; }
            if (_fsLayoutOk()) {
                if (st.brokenSince) _fsLog(`fs guard: video layout back after ${Math.round(performance.now() - st.brokenSince)}ms`);
                st.brokenSince = 0;
                return;
            }
            const now = performance.now();
            if (!st.brokenSince) {
                st.brokenSince = now;
                _fsLog(`fs guard: layout lost while fullscreen (${why}), re-sending fullscreenchange`);
                _fsLog('fs guard: state ' + _fsStateDump());
            }
            const lost = now - st.brokenSince;
            if (lost < FS_HINT_MS) {
                st.resending = true;
                try {
                    document.dispatchEvent(new Event('fullscreenchange'));
                    document.dispatchEvent(new Event('webkitfullscreenchange'));
                    window.dispatchEvent(new Event('resize'));
                } finally { st.resending = false; }
                return;
            }
            if (!st.hinted) {
                st.hinted = true;
                _fsLog('fs guard: layout could not be restored, showing hint');
                _showFsHint(LANG.fsLayoutHint);
            }
        };
        const onEvent = e => check(e.type);
        const mo = new MutationObserver(() => check('ytd-watch-flexy changed'));
        const app = document.querySelector('ytd-app') || document.documentElement;
        mo.observe(app, { subtree: true, attributes: true, attributeFilter: ['fullscreen'] });
        pageEvents.forEach(t => document.addEventListener(t, onEvent));
        document.addEventListener('fullscreenchange', onEvent);
        const timer = setInterval(() => check('timer'), FS_GUARD_EVERY_MS);
        const stop = () => {
            clearInterval(timer);
            mo.disconnect();
            pageEvents.forEach(t => document.removeEventListener(t, onEvent));
            document.removeEventListener('fullscreenchange', onEvent);
            _fsGuard = null;
            _fsLog('fs guard: stopped (left fullscreen)');
        };
        _fsGuard = { stop };
        _fsLog('fs guard: watching layout');
        check('entered');
    }
    document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) _startFsGuard(); });

    /** Short message at the top of the screen; placed inside the fullscreen element so it is visible. */
    function _showFsHint(text) {
        const host = document.fullscreenElement || document.body;
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;'
            + 'padding:10px 18px;border-radius:8px;background:rgba(20,20,20,.92);color:#fff;'
            + 'font:500 16px/1.4 -apple-system,"Helvetica Neue",Arial,sans-serif;pointer-events:none;'
            + 'transition:opacity .3s;';
        host.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; }, 6000);
        setTimeout(() => el.remove(), 6400);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AUTO EXIT FULLSCREEN
    // Called from a timeupdate listener whenever the remaining playback time
    // falls within 5 seconds of the total duration. Exiting fullscreen does
    // not require user activation, so a single click on the toggle is enough.
    // ycm-fs-end-done prevents repeated exits for the same source.
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Attempts to exit fullscreen when a video nears its end.
     *
     * @param {HTMLVideoElement} video  The video element being monitored.
     */
    function tryAutoExitFullscreen(video) {
        if (!window['FULLSCREEN_ON_END']) return;
        if (video.getAttribute('ycm-fs-end-done')) return;
        video.setAttribute('ycm-fs-end-done', 'true');
        if (!document.fullscreenElement) return;

        console.log('YSC: Attempting auto exit fullscreen.');
        const fsBtn = $(video).closest('#movie_player, .html5-video-player').find('.ytp-fullscreen-button');
        if (fsBtn.length) fsBtn[0].click();
        setTimeout(() => {
            if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        }, 500);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PAGE-LEVEL FLAGS & STYLES
    // Global CSS for the player bar widgets, the fullscreen progress bar and
    // the live-chat hiding switch. Features are toggled through attributes on
    // <html> so the settings panel can switch them without a reload.
    // ─────────────────────────────────────────────────────────────────────────
    const _pageStyle = document.createElement('style');
    _pageStyle.id = 'ycm-page-style';
    _pageStyle.textContent = `
        [id^="ycm-bar"] { --ycm-s: 1; }
        .ytp-big-mode [id^="ycm-bar"] { --ycm-s: 1.5; }
        [id^="ycm-bar"] .ycm-ico { width: calc(24px * var(--ycm-s)); height: calc(24px * var(--ycm-s)); display: block; flex-shrink: 0; cursor: pointer; overflow: visible; }
        [id^="ycm-bar"] [ycm-btn="bookmark"] { display: inline-flex; margin-right: 10px; cursor: pointer; }
        [id^="ycm-bar"] [ycm-btn="bookmark"][ycm-bm="anim"] .ycm-bm-clip { animation: ycm-bm-rise .25s ease-out both; }
        [id^="ycm-bar"] [ycm-btn="bookmark"][ycm-bm="anim"] svg { animation: ycm-bm-pulse .2s ease-out .25s; transform-origin: 50% 60%; }
        @keyframes ycm-bm-rise  { from { transform: translateY(24px); } to { transform: translateY(0); } }
        @keyframes ycm-bm-pulse { 50% { transform: scale(1.15); } }
        [id^="ycm-bar"] .ycm-ccgroup { display: inline-flex; align-items: center; gap: calc(4px * var(--ycm-s));
            height: calc(32px * var(--ycm-s)); padding: 0 calc(8px * var(--ycm-s)) 0 calc(8px * var(--ycm-s));
            border-radius: calc(16px * var(--ycm-s)); background: rgba(255,255,255,.12); margin-right: 10px; }
        [id^="ycm-bar"] [ycm-btn="cc-pill"] { width: calc(28px * var(--ycm-s)); height: calc(16px * var(--ycm-s)); cursor: pointer; display: block; }
        [id^="ycm-bar"] [ycm-btn="cc-pill"] svg { width: 100%; height: 100%; display: block; }
        [id^="ycm-bar"] [ycm-btn="cc"] { width: calc(32px * var(--ycm-s)); height: calc(32px * var(--ycm-s)); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
        [id^="ycm-bar"] [ycm-btn="cc"] svg { width: calc(24px * var(--ycm-s)); height: calc(24px * var(--ycm-s)); display: block; }
        [id^="ycm-bar"] [ycm-btn="prefs"] { margin-right: calc(6px * var(--ycm-s)); }

        /* Our caption button replaces the native one; keep the native button
           in the DOM (clickable from script) but invisible and out of the flow. */
        #movie_player[ycm-player] .ytp-subtitles-button {
            position: absolute !important; width: 1px !important; height: 1px !important;
            overflow: hidden !important; opacity: 0 !important; pointer-events: none !important; }

        /* Fullscreen progress bar: three layers like YouTube's own bar. */
        #ycm-fsbar { position: absolute; left: 0; right: 0; bottom: 0; height: var(--ycm-fsbar-h, 4px);
            z-index: 40; pointer-events: none; opacity: 0; transition: opacity .15s;
            background: var(--ycm-fsbar-track, rgba(40,40,40,.6)); }
        #ycm-fsbar > div { position: absolute; left: 0; top: 0; bottom: 0; width: 0; }
        #ycm-fsbar .ycm-fsbar-load { background: var(--ycm-fsbar-load, rgba(255,255,255,.4)); }
        #ycm-fsbar .ycm-fsbar-play { background: var(--ycm-fsbar-play, linear-gradient(90deg,#f03 80%,#ff2791)); }
        .ad-interrupting #ycm-fsbar .ycm-fsbar-play { background: #fc0; }
        html[ycm-fsbar] .html5-video-player.ytp-autohide:not(.ytp-player-minimized) #ycm-fsbar:not([ycm-live]) { opacity: 1; }
        #ycm-fsbar[ycm-live] .ycm-fsbar-load { display: none; }

        /* Hide live chat (the playlist panel is a different element and stays). */
        html[ycm-hide-chat] ytd-live-chat-frame,
        html[ycm-hide-chat] #chat-container { display: none !important; }
        /* Fullscreen "squeezeback" layout moves the chat into #panels-full-bleed-container,
           which YouTube sizes to the sidebar width (528px). Hiding only the chat left that
           box as an empty strip on the right. The same box also hosts description/comment
           panels, so it is only hidden while none of them is expanded. */
        html[ycm-hide-chat] ytd-watch-flexy[squeezeback] #panels-full-bleed-container:not(:has(ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"])) { display: none !important; }
    `;
    (document.head || document.documentElement).appendChild(_pageStyle);

    /** Mirrors the feature switches onto <html> attributes used by the CSS above. */
    function _applyPageFlags() {
        const root = document.documentElement;
        root.toggleAttribute('ycm-fsbar', !!window['FS_PROGRESS_BAR']);
        root.toggleAttribute('ycm-hide-chat', !!window['HIDE_LIVE_CHAT']);
        _nudgePlayerResize();
    }
    /** The player sizes the <video> from its container in JS; after our CSS changes the
     *  container width, a resize event makes it re-measure instead of keeping the old size. */
    function _nudgePlayerResize() {
        if (!window['HIDE_LIVE_CHAT']) return;
        requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))));
    }
    document.addEventListener('fullscreenchange', _nudgePlayerResize);
    _applyPageFlags();

    // ─────────────────────────────────────────────────────────────────────────
    // BOTTOM PROGRESS BAR
    // A full-width copy of YouTube's progress bar pinned to the bottom of the
    // player (normal and fullscreen), visible only while the native controls
    // are hidden (.ytp-autohide), so the two never overlap. Height and colors are read
    // from the native bar each time fullscreen is entered, so the copy follows
    // whatever player UI version YouTube serves; pixel heights are rounded up
    // to whole pixels.
    // ─────────────────────────────────────────────────────────────────────────

    /** Returns (creating if needed) the progress bar element inside a player. */
    function _ensureFsBar(player) {
        let bar = player.querySelector(':scope > #ycm-fsbar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'ycm-fsbar';
            for (const cls of ['ycm-fsbar-load', 'ycm-fsbar-play']) {
                const layer = document.createElement('div');
                layer.className = cls;
                bar.appendChild(layer);
            }
            player.appendChild(bar);
        }
        return bar;
    }

    /** Copies the native bar's rendered height and colors onto our bar. */
    function _syncFsBarStyle(player, bar) {
        const list = player.querySelector('.ytp-progress-list');
        if (list) {
            // Round up to whole pixels; the small epsilon absorbs float noise
            // from YouTube's scaleY(.667) ≈ 2/3 (6px → 4.002px should be 4px).
            const h = Math.ceil(list.getBoundingClientRect().height - 0.05);
            if (h > 0) bar.style.setProperty('--ycm-fsbar-h', h + 'px');
            const bg = getComputedStyle(list).backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)') bar.style.setProperty('--ycm-fsbar-track', bg);
        }
        const load = player.querySelector('.ytp-load-progress');
        if (load) {
            const c = getComputedStyle(load).backgroundColor;
            if (c && c !== 'rgba(0, 0, 0, 0)') bar.style.setProperty('--ycm-fsbar-load', c);
        }
        const play = player.querySelector('.ytp-play-progress');
        if (play && !player.classList.contains('ad-interrupting')) {
            const cs = getComputedStyle(play);
            const paint = cs.backgroundImage && cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor;
            if (paint && paint !== 'rgba(0, 0, 0, 0)') bar.style.setProperty('--ycm-fsbar-play', paint);
        }
    }

    /** Updates the played / buffered widths of the bar for a video. */
    function _updateFsBar(video) {
        const player = video.closest('#movie_player');
        if (!player) return;
        const isNew = !player.querySelector(':scope > #ycm-fsbar');
        const bar = _ensureFsBar(player);
        if (isNew) _syncFsBarStyle(player, bar);
        const d = video.duration;
        if (!isFinite(d) || d <= 0) { bar.setAttribute('ycm-live', ''); return; }
        bar.removeAttribute('ycm-live');
        let loaded = 0;
        for (let i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= video.currentTime) loaded = Math.max(loaded, video.buffered.end(i));
        }
        bar.firstChild.style.width = (Math.min(loaded / d, 1) * 100) + '%';
        bar.lastChild.style.width  = (Math.min(video.currentTime / d, 1) * 100) + '%';
    }

    for (const type of ['timeupdate', 'progress', 'seeked', 'durationchange']) {
        document.addEventListener(type, e => {
            if (e.target instanceof HTMLVideoElement && window['FS_PROGRESS_BAR']) _updateFsBar(e.target);
        }, true);
    }
    document.addEventListener('fullscreenchange', () => {
        // Entering and leaving fullscreen change the native bar's size (big
        // mode); let YouTube re-layout first, then copy its bar metrics again.
        setTimeout(() => {
            document.querySelectorAll('#movie_player').forEach(player => {
                const bar = _ensureFsBar(player);
                _syncFsBarStyle(player, bar);
                const v = player.querySelector('video');
                if (v) _updateFsBar(v);
            });
        }, 300);
    });


    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Extracts channel information from the YouTube DOM for a given ycm-channel.
     *
     * Handles collaborative videos that credit multiple channels in the
     * description. Returns an array of {id, name} objects in order of appearance.
     * The first channel has priority when looking up saved speed/caption preferences.
     *
     * @param {number|string} id       ycm-channel attribute value, or -1 to use div directly.
     * @param {jQuery|null}   div      Specific channel-name element; null = query by id.
     * @param {boolean}       returnboth  true = return Array of {id,name}; false = joined string.
     * @returns {Array|string}
     */
    function readChannelCredits(id, div = null, returnboth = false) {
        const handleOf = href => decodeURIComponent(((href || '').match(/^\/(@.+)$/) || [])[1] || '');
        try {
            if (div === null) div = $('#channel-name[ycm-channel="' + id + '"]');

            // Primary source: every /@handle anchor inside the channel-name block
            // (collab videos list several). Keep first occurrence of each handle.
            const result = [];
            div.find('a[href^="/@"]').each(function() {
                const a      = this;
                const handle = handleOf(a.getAttribute('href'));
                const label  = a.textContent.trim();
                if (handle && label && !result.some(r => r.id === handle)) {
                    result.push({ id: handle, name: label });
                }
            });

            if (!result.length) {
                // Fallbacks for older / single-channel layouts.
                let handle = handleOf(div.find('a[href^="/@"]').attr('href'));
                let label  = div.find('#container #text:visible:first').text().trim()
                          || div.find('.ytd-channel-name').find('a').text().trim();

                if (!label) {
                    const ownerLink = $('#primary .watch-active-metadata #owner #attributed-channel-name:visible').find('a')[0];
                    const textNode  = ownerLink && Array.from(ownerLink.childNodes).find(n => n.nodeType === 3);
                    label = textNode ? textNode.textContent.trim() : '';
                }
                if (!label) {
                    const metaId = document.querySelector('#watch7-content > meta[itemprop=videoId]');
                    if (metaId) {
                        const pageVid = div.closest('ytd-watch-flexy, ytd-browse').find('video')[0];
                        if (new URL(pageVid.baseURI).searchParams.get('v') === metaId.getAttribute('content')) {
                            const metaName = document.querySelector('#watch7-content > span[itemprop=author] > link[itemprop=name]');
                            label = (metaName && metaName.getAttribute('content')) || '';
                        }
                    }
                }

                // Co-author videos: #channel-name may be empty while the
                // description infocards section carries the channel link.
                if (!label && !handle) {
                    const card = document.querySelector('ytd-video-description-infocards-section-renderer a[href^="/@"]');
                    if (card) {
                        handle = handleOf(card.getAttribute('href'));
                        label  = card.textContent.trim();
                        console.log('YSC: channel found via infocards fallback:', handle, label);
                    }
                }

                if (handle || label) result.push({ id: handle || '', name: label });
            }

            return returnboth ? result : result.map(r => r.name).join(' & ');
        } catch (e) {
            console.log('YSC: readChannelCredits error', e);
            return returnboth ? [] : '';
        }
    }

    /**
     * Saves the current playback speed and caption state as the default for all
     * channels credited in the current video. Updates button underlines to provide
     * immediate visual confirmation that the preference has been committed.
     *
     * Bound to the "set" button in the ycm-bar.
     *
     * @param {Event} el  The click event from the set button.
     */
    async function saveChannelDefaults(el) {
        const btnEl    = el.currentTarget;
        const barEl    = btnEl.parentNode;
        const slot     = barEl.id.replace('ycm-bar', '');
        const credits  = readChannelCredits(slot, null, true);
        const rate     = $('video[ycm-video="' + slot + '"]')[0].playbackRate;
        const handles  = credits.map(c => c.id).filter(Boolean);

        updateSetButtonTooltip(slot, credits.map(c => c.name).join(' & '));

        for (const h of handles) {
            await GM.setValue(h, rate);
            console.log('YSC: saved speed', rate, 'for', h);
        }
        _markSavedSpeed(barEl, rate);

        // Current caption state: the native button's aria-pressed is the truth;
        // fall back to ycm-cc-live (written by toggleCC) if the button is missing.
        const native = getPlayerSubtitleBtn(slot);
        const ccOn = native.length
            ? native.attr('aria-pressed') === 'true'
            : barEl.getAttribute('ycm-cc-live') === 'on';

        for (const h of handles) await GM.setValue(h + '_captions', ccOn);
        console.log('YSC: saved captions', ccOn);
        barEl.setAttribute('ycm-cc-saved', ccOn ? 'on' : 'off');

        // Feedback: swap in the animation icon (fill-up + pulse), then back to
        // the regular state icon and a short "saved" tooltip.
        _showBookmarkIcon(btnEl, 'anim');
        setTimeout(() => {
            _showBookmarkIcon(btnEl, null);   // let updateBookmarkState pick the state again
            syncCCVisuals(slot);
            _ttFlash(btnEl, LANG.playerSavedToast
                .replace('{speed}', _speedLabel(rate))
                .replace('{cc}', ccOn ? LANG.playerCCStateOn : LANG.playerCCStateOff));
        }, 450);
    }

    /**
     * Records the saved speed on the bar (ycm-saved-speed, read by the bookmark
     * state) and underlines the matching speed button.
     *
     * @param {HTMLElement|object} bar   The ycm-bar element (or a $ wrapper).
     * @param {number}             rate  Saved playback rate.
     */
    function _markSavedSpeed(bar, rate) {
        const el = bar && bar._isJQ ? bar[0] : bar;
        if (!el) return;
        el.setAttribute('ycm-saved-speed', String(rate));
        el.querySelectorAll(':scope > span[ycm-speed]').forEach(s =>
            { s.style.textDecoration = parseFloat(s.getAttribute('ycm-speed')) === rate ? 'underline' : ''; });
        updateBookmarkState(el.id.replace('ycm-bar', ''));
    }

    /** Copy of a [label, speed][] list sorted by ascending speed. */
    function _sortTemplates(list) {
        return Array.isArray(list) ? list.slice().sort((a, b) => a[1] - b[1]) : list;
    }

    /** Speeds equal within this tolerance count as the same button. */
    const RATE_EPS = 1e-3;
    const _sameRate = (a, b) => Math.abs(a - b) < RATE_EPS;

    /** Label for a speed that has no button: "1.15x" (at most two decimals). */
    const _tempSpeedLabel = rate => (Math.round(rate * 100) / 100) + 'x';

    /**
     * Makes the speed buttons show the video's ACTUAL speed, however it was
     * set (our buttons, YouTube's menu, keyboard shortcuts).
     *  - a button with this speed exists → it is the selected one;
     *  - none exists → one temporary button with this speed is inserted at its
     *    place in the ascending list, looking exactly like the others.
     * There is never more than one temporary button, and never one whose
     * speed equals a user button; it is removed when the speed changes.
     *
     * @param {Element} bar   The ycm-bar element.
     * @param {number}  rate  Current playback speed.
     */
    function syncSpeedButtons(bar, rate) {
        if (!bar || isNaN(rate)) return;
        bar.querySelectorAll('span[ycm-temp]').forEach(t => t.remove());
        const btns = [...bar.querySelectorAll('span[ycm-speed]')];
        let hit = null;
        for (const b of btns) {
            const on = !hit && _sameRate(parseFloat(b.getAttribute('ycm-speed')), rate);
            if (on) hit = b;
            b.style.color = on ? COLOR_SELECTED : COLOR_NORMAL;
            if (on) b.setAttribute('ycm-sel', 'true'); else b.removeAttribute('ycm-sel');
        }
        if (hit || !btns.length) return;
        const temp = btns[0].cloneNode(false);           // same inline style as a user button
        temp.setAttribute('ycm-speed', String(rate));
        temp.setAttribute('ycm-temp', '');
        temp.setAttribute('ycm-sel', 'true');
        temp.style.color = COLOR_SELECTED;
        temp.textContent = _tempSpeedLabel(rate);
        temp.addEventListener('click', onSpeedButtonClick);
        const after = btns.find(b => parseFloat(b.getAttribute('ycm-speed')) > rate);
        if (after) after.before(temp); else btns[btns.length - 1].after(temp);
    }

    /**
     * Sets a video's speed from our own code. The target is written first, so
     * the ratechange that follows is recognised as ours (see the ratechange
     * listener) and the speed guardian keeps this speed.
     */
    function _setRate(video, rate) {
        if (!video) return;
        video.dataset.ycmTargetSpeed = rate;
        video.playbackRate = rate;
    }

    /** Button label for a rate from BUTTON_TEMPLATES, or "<rate>x". */
    function _speedLabel(rate) {
        const hit = BUTTON_TEMPLATES.find(([, r]) => r === rate);
        return hit ? hit[0] : rate + 'x';
    }

    /**
     * Toggles the saved caption default for the channel (the pill switch).
     * Saving happens immediately; the current caption state is not changed.
     *
     * @param {number|string} slot  ycm-bar numeric id.
     * @param {HTMLElement}   pill  The pill element (anchor for the tooltip).
     */
    async function onCaptionPillClick(slot, pill) {
        const barEl   = document.getElementById('ycm-bar' + slot);
        const handles = readChannelCredits(slot, null, true).map(c => c.id).filter(Boolean);
        if (!barEl || !handles.length) return;
        const next = barEl.getAttribute('ycm-cc-saved') !== 'on';
        for (const h of handles) await GM.setValue(h + '_captions', next);
        console.log('YSC: caption default set to', next, 'for', handles);
        barEl.setAttribute('ycm-cc-saved', next ? 'on' : 'off');
        syncCCVisuals(slot);
        _ttFlash(pill, LANG.playerPillToast.replace('{cc}', next ? LANG.playerCCStateOn : LANG.playerCCStateOff));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SVG TOOLTIP SYSTEM — SET BUTTON
    //
    // Renders a capsule-shaped SVG tooltip with downward arrow that follows the
    // YouTube dark/light theme automatically (html[dark] attribute).
    //
    // Tooltip text is dynamic (includes channel name), so SVG is built on demand
    // at mouseenter rather than from a static cache.
    // ─────────────────────────────────────────────────────────────────────────

    /** Fixed tooltip style: white background, black text. */
    const _ttCfg = {
        fill: '#ffffff', textColor: '#111111', strokeColor: 'rgba(0,0,0,0.15)',
        strokeWidth: 1, shadowColor: '#000000', shadowOpacity: '0.20',
        shadowDy: '2', shadowStd: '4'
    };

    /** Builds the SVG path string for a rounded capsule with a downward arrow. */
    function _ttBuildPath(w, h, r, aw, ah, ax) {
        const aL = ax - aw / 2, aR = ax + aw / 2;
        return [`M ${r} 0`, `L ${w - r} 0`, `Q ${w} 0 ${w} ${r}`,
                `L ${w} ${h - r}`, `Q ${w} ${h} ${w - r} ${h}`,
                `L ${aR} ${h}`, `L ${ax} ${h + ah}`, `L ${aL} ${h}`,
                `L ${r} ${h}`, `Q 0 ${h} 0 ${h - r}`, `L 0 ${r}`,
                `Q 0 0 ${r} 0`, 'Z'].join(' ');
    }

    /** Creates a full SVG tooltip element for the given text and color cfg. */
    function _ttMakeSVG(text, cfg) {
        const fs = 18, lh = 24, px = 16, py = 10, r = 20, aw = 12, ah = 7;
        const sw = cfg.strokeColor ? (cfg.strokeWidth || 1) : 0;
        const ns = 'http://www.w3.org/2000/svg';

        // Measure text width using a temporary off-screen SVG.
        const tmp = document.createElementNS(ns, 'svg');
        tmp.style.cssText = 'position:fixed;visibility:hidden;left:-9999px;top:-9999px;';
        const tMeasure = document.createElementNS(ns, 'text');
        tMeasure.style.cssText = `font-family:sans-serif;font-size:${fs}px;font-weight:bold;`;
        tMeasure.textContent = text;
        tmp.appendChild(tMeasure);
        document.body.appendChild(tmp);
        const tw = tMeasure.getBBox().width;
        document.body.removeChild(tmp);

        const cw = Math.ceil(tw + px * 2), ch = lh + py * 2, ax = cw / 2;
        const bl = sw + 2, svgW = cw + bl * 2, svgH = ch + ah + bl * 2;

        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width',   svgW);
        svg.setAttribute('height',  svgH);
        svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
        svg.style.cssText = 'display:block;overflow:visible;';

        // Drop-shadow filter.
        const fid  = 'ttf-' + Math.random().toString(36).slice(2, 7);
        const defs = document.createElementNS(ns, 'defs');
        const flt  = document.createElementNS(ns, 'filter');
        flt.setAttribute('id', fid);
        flt.setAttribute('x', '-40%'); flt.setAttribute('y', '-40%');
        flt.setAttribute('width', '180%'); flt.setAttribute('height', '200%');
        const ds = document.createElementNS(ns, 'feDropShadow');
        ds.setAttribute('dx', '0');
        ds.setAttribute('dy',           cfg.shadowDy    ?? '0');
        ds.setAttribute('stdDeviation', cfg.shadowStd   ?? '4');
        ds.setAttribute('flood-color',  cfg.shadowColor || '#000');
        ds.setAttribute('flood-opacity',cfg.shadowOpacity || '0');
        flt.appendChild(ds); defs.appendChild(flt); svg.appendChild(defs);

        const g = document.createElementNS(ns, 'g');
        g.setAttribute('transform', `translate(${bl},${bl})`);
        g.setAttribute('filter', `url(#${fid})`);

        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', _ttBuildPath(cw, ch, r, aw, ah, ax));
        path.setAttribute('fill', cfg.fill);
        if (cfg.strokeColor) {
            path.setAttribute('stroke', cfg.strokeColor);
            path.setAttribute('stroke-width', sw);
        }
        g.appendChild(path);

        const txt = document.createElementNS(ns, 'text');
        txt.setAttribute('x', cw / 2);
        txt.setAttribute('y', py + lh / 2);
        txt.setAttribute('dominant-baseline', 'central');
        txt.setAttribute('text-anchor', 'middle');
        txt.setAttribute('fill', cfg.textColor);
        txt.style.cssText = `font-family:sans-serif;font-size:${fs}px;font-weight:bold;`;
        txt.textContent = text;
        g.appendChild(txt);
        svg.appendChild(g);

        // Stash geometry for arrow correction on edge clamp.
        svg._path = path; svg._cw = cw; svg._ch = ch;
        svg._r = r; svg._aw = aw; svg._ah = ah;
        return svg;
    }

    // Shared fixed container for the tooltip SVG (lazily mounted on first use,
    // because @run-at document-start means document.body may not exist yet).
    let _ttHost = null;
    let _ttTimer = null;

    function _ttEnsureHost() {
        if (_ttHost) return;
        _ttHost = document.createElement('div');
        _ttHost.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
                                'top:0;left:0;opacity:0;transition:opacity 0.15s ease;';
        document.body.appendChild(_ttHost);
    }

    function _ttShow(btn) {
        const text = btn.getAttribute('data-tooltip');
        if (!text) return;
        _ttEnsureHost();
        const svg = _ttMakeSVG(text, _ttCfg);
        if (_ttTimer) { clearTimeout(_ttTimer); _ttTimer = null; }
        while (_ttHost.firstChild) _ttHost.removeChild(_ttHost.firstChild);
        _ttHost.appendChild(svg);
        _ttHost.style.opacity = '0';

        const sw  = parseFloat(svg.getAttribute('width'))  || 0;
        const sh  = parseFloat(svg.getAttribute('height')) || 0;
        const GAP = 5, vw = document.documentElement.clientWidth;
        const br  = btn.getBoundingClientRect();
        const idealLeft = br.left + br.width / 2 - sw / 2;
        let left = Math.min(vw - sw - 4, Math.max(4, idealLeft));
        let top  = br.top - sh - GAP;
        if (top < 4) top = br.bottom + GAP;

        // Correct arrow X so it still points at the button center after clamping.
        if (svg._path && svg._cw !== undefined) {
            const delta = idealLeft - left;
            const ax = Math.max(svg._aw, Math.min(svg._cw - svg._aw, svg._cw / 2 + delta));
            svg._path.setAttribute('d', _ttBuildPath(svg._cw, svg._ch, svg._r, svg._aw, svg._ah, ax));
        }

        _ttHost.style.left = left + 'px';
        _ttHost.style.top  = top  + 'px';
        requestAnimationFrame(() => { _ttHost.style.opacity = '1'; });
    }

    function _ttHide() {
        _ttHost.style.opacity = '0';
        _ttTimer = setTimeout(() => {
            while (_ttHost.firstChild) _ttHost.removeChild(_ttHost.firstChild);
            _ttTimer = null;
        }, 150);
    }

    /** Binds the SVG tooltip to a set button element (must have data-tooltip). */
    function _ttBind(btn) {
        btn.addEventListener('mouseenter', () => _ttShow(btn));
        btn.addEventListener('mouseleave', _ttHide);
        btn.addEventListener('click',      _ttHide);
    }

    /**
     * Shows a one-off tooltip with `text` above `el` for `ms` milliseconds,
     * then restores the element's own tooltip text (if any).
     */
    function _ttFlash(el, text, ms = 1500) {
        const own = el.getAttribute('data-tooltip');
        el.setAttribute('data-tooltip', text);
        _ttShow(el);
        if (own === null) el.removeAttribute('data-tooltip'); else el.setAttribute('data-tooltip', own);
        setTimeout(_ttHide, ms);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PLAYER CONTROL BAR — CONTAINER CREATION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Creates the ycm-bar div with all speed buttons, CC buttons,
     * and the set button, then binds their event handlers.
     *
     * The container is inserted into .ytp-right-controls by initPlayers().
     * Each button uses inline styles derived from COLOR_NORMAL / COLOR_SELECTED
     * so colors can be updated globally via refreshContainers().
     *
     * @param {number} curspeed  Currently active playback speed.
     * @param {number} id        Unique container ID from nextSlotId().
     * @returns {HTMLElement}    The constructed div element (not yet inserted).
     */
    function buildControlBar(curspeed, id) {
        const box = document.createElement('div');
        box.id = 'ycm-bar' + id;
        box.style.cssText = 'margin-bottom:0;padding-bottom:0;display:flex;align-items:center;font-weight:bold;font-size:80%;';

        const btnStyle = color => 'margin-right:10px;color:' + color + ';cursor:pointer;font-size:' + PLAYER_FONT_SIZE + ';';
        const add = (css, attrs, text) => {
            const s = document.createElement('span');
            s.style.cssText = css;
            for (const k in attrs) s.setAttribute(k, attrs[k]);
            s.textContent = text;
            box.appendChild(s);
            return s;
        };

        // Leading spacer.
        add('margin-right:15px;', {}, '');

        // Speed buttons: one per BUTTON_TEMPLATES entry.
        const speedBtns = BUTTON_TEMPLATES.map(([label, rate]) =>
            add(btnStyle(COLOR_NORMAL), { 'ycm-speed': rate }, label));
        speedBtns.forEach(b => b.addEventListener('click', onSpeedButtonClick));
        syncSpeedButtons(box, curspeed);

        // Bookmark: saves current speed + captions; shows saved / changed state.
        const bookmark = document.createElement('span');
        bookmark.setAttribute('ycm-btn', 'bookmark');
        bookmark.setAttribute('data-tooltip', LANG.playerSetTitle);
        _showBookmarkIcon(bookmark, 'none');
        bookmark.addEventListener('click', saveChannelDefaults);
        box.appendChild(bookmark);
        _ttBind(bookmark);

        // Caption group: pill (saved default) + caption button (current state).
        const group = document.createElement('div');
        group.className = 'ycm-ccgroup';
        const pill = document.createElement('div');
        pill.setAttribute('ycm-btn', 'cc-pill');
        pill.addEventListener('click', () => onCaptionPillClick(id, pill));
        _ttBind(pill);
        const ccBtn = document.createElement('div');
        ccBtn.setAttribute('ycm-btn', 'cc');
        ccBtn.setAttribute('data-tooltip', LANG.playerCCTitle);
        ccBtn.addEventListener('click', () => {
            const native = getPlayerSubtitleBtn(id);
            if (!_ccAvailable(native)) return;
            toggleCC(native.attr('aria-pressed') !== 'true', id);
        });
        _ttBind(ccBtn);
        group.append(pill, ccBtn);
        box.appendChild(group);

        // Settings entry (sliders icon), last in our bar.
        const prefs = document.createElement('div');
        prefs.setAttribute('ycm-btn', 'prefs');
        prefs.setAttribute('data-tooltip', LANG.playerPrefsTitle);
        prefs.appendChild(_buildTuneSVG());
        prefs.addEventListener('click', () => openSettingsPanel());
        _ttBind(prefs);
        box.appendChild(prefs);

        _renderCaptionWidgets(box, id);
        return box;
    }

    /** Creates an SVG element (namespace-aware, Trusted-Types safe). */
    function _svgEl(tag, attrs = {}) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const k in attrs) el.setAttribute(k, attrs[k]);
        return el;
    }

    /** Bookmark path on a 24-unit canvas (8 units wide body). */
    const _BOOKMARK_D = 'M8 3.5h8a1.5 1.5 0 0 1 1.5 1.5v15.5l-5.5-4.2-5.5 4.2V5A1.5 1.5 0 0 1 8 3.5z';

    /**
     * Each state of the bookmark and the pill is one complete, fixed SVG, and
     * a state change swaps the whole icon. (An earlier single SVG that toggled
     * layers and a mask left a notch behind when Chrome skipped the repaint.)
     */
    const _BOOKMARK_ICONS = {
        none:    () => [_svgEl('path', { d: _BOOKMARK_D, fill: 'none', stroke: '#fff', 'stroke-width': 2, 'stroke-linejoin': 'round' })],
        saved:   () => [_svgEl('path', { d: _BOOKMARK_D, fill: '#fff' })],
        // Red dot separated from the bookmark by a transparent gap (a fixed mask
        // baked into this icon), so it reads cleanly on dark and light frames.
        changed: () => {
            const mask = _svgEl('mask', { id: 'ycm-bm-gap', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 24, height: 24 });
            mask.append(_svgEl('rect', { width: 24, height: 24, fill: '#fff' }),
                        _svgEl('circle', { cx: 18, cy: 5, r: 5, fill: '#000' }));
            const defs = _svgEl('defs'); defs.appendChild(mask);
            return [defs,
                    _svgEl('path', { d: _BOOKMARK_D, fill: '#fff', mask: 'url(#ycm-bm-gap)' }),
                    _svgEl('circle', { cx: 18, cy: 5, r: 3, fill: '#ff4e45' })];
        },
        // Save animation: outline + a fill whose clip rect rises (CSS keyframes).
        anim: () => {
            const clip = _svgEl('clipPath', { id: 'ycm-bm-rise' });
            clip.appendChild(_svgEl('rect', { class: 'ycm-bm-clip', width: 24, height: 24 }));
            const defs = _svgEl('defs'); defs.appendChild(clip);
            return [defs,
                    _svgEl('path', { d: _BOOKMARK_D, fill: 'none', stroke: '#fff', 'stroke-width': 2, 'stroke-linejoin': 'round' }),
                    _svgEl('path', { d: _BOOKMARK_D, fill: '#fff', 'clip-path': 'url(#ycm-bm-rise)' })];
        },
    };

    const _PILL_ICONS = {
        on:   () => [_svgEl('rect', { width: 28, height: 16, rx: 8, fill: 'rgba(255,255,255,.3)' }),
                     _svgEl('circle', { cx: 20, cy: 8, r: 6, fill: '#fff' }),
                     _svgEl('circle', { cx: 20, cy: 8, r: 2.5, fill: '#f00' })],
        off:  () => [_svgEl('rect', { width: 28, height: 16, rx: 8, fill: 'rgba(255,255,255,.3)' }),
                     _svgEl('circle', { cx: 8, cy: 8, r: 6, fill: '#fff' })],
        none: () => [_svgEl('rect', { width: 28, height: 16, rx: 8, fill: 'rgba(255,255,255,.14)' }),
                     _svgEl('circle', { cx: 14, cy: 8, r: 4.5, fill: 'none', stroke: 'rgba(255,255,255,.55)', 'stroke-width': 2 })],
    };

    /**
     * Puts the icon for `state` into the bookmark (no-op if already shown).
     * state null only clears the marker so the next updateBookmarkState redraws.
     */
    function _showBookmarkIcon(bm, state) {
        if (state === null) { bm.removeAttribute('ycm-bm'); return; }
        if (bm.getAttribute('ycm-bm') === state) return;
        const svg = _svgEl('svg', { viewBox: '0 0 24 24', class: 'ycm-ico' });
        svg.append(..._BOOKMARK_ICONS[state]());
        bm.replaceChildren(svg);
        bm.setAttribute('ycm-bm', state);
    }

    /** Puts the icon for `state` ('on' | 'off' | 'none') into the pill. */
    function _showPillIcon(pill, state) {
        if (pill.getAttribute('ycm-pill') === state) return;
        const svg = _svgEl('svg', { viewBox: '0 0 28 16' });
        svg.append(..._PILL_ICONS[state]());
        pill.replaceChildren(svg);
        pill.setAttribute('ycm-pill', state);
    }

    /** Sliders ("tune") icon used for the settings entry. */
    function _buildTuneSVG() {
        const svg = _svgEl('svg', { viewBox: '0 0 24 24', class: 'ycm-ico', fill: 'none', stroke: '#fff', 'stroke-width': 2, 'stroke-linecap': 'round' });
        svg.append(
            _svgEl('path', { d: 'M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2' }),
            _svgEl('circle', { cx: 14, cy: 6, r: 2 }),
            _svgEl('circle', { cx: 8, cy: 12, r: 2 }),
            _svgEl('circle', { cx: 16, cy: 18, r: 2 })
        );
        return svg;
    }

    /** True if the native subtitle button exists and the video has captions. */
    function _ccAvailable(native) {
        if (!native || !native.length) return false;
        const svg = native[0].querySelector('svg');
        const fo  = svg ? parseFloat(svg.getAttribute('fill-opacity') ?? '1') : 1;
        return native[0].getAttribute('aria-disabled') !== 'true' && !(fo < 0.99);
    }

    /**
     * Renders the caption button (current state, mirrored from the native
     * button including its icon and "no captions" dimming) and the pill
     * (saved default from ycm-cc-saved: on / off / not set).
     */
    function _renderCaptionWidgets(barEl, id) {
        const ccBtn = barEl.querySelector('[ycm-btn="cc"]');
        const pill  = barEl.querySelector('[ycm-btn="cc-pill"]');
        if (!ccBtn || !pill) return;

        // Caption button: clone the native icon so it matches YouTube's look.
        const native = getPlayerSubtitleBtn(id);
        const nativeSvg = native.length ? native[0].querySelector('svg') : null;
        const icon = nativeSvg ? nativeSvg.cloneNode(true) : _svgEl('svg', { viewBox: '0 0 24 24' });
        if (!nativeSvg) {
            icon.appendChild(_svgEl('rect', { x: 2, y: 4, width: 20, height: 16, rx: 2, fill: 'none', stroke: '#fff', 'stroke-width': 2 }));
        }
        icon.removeAttribute('width'); icon.removeAttribute('height');
        if (native.length && native.attr('aria-pressed') === 'true') {
            icon.appendChild(_svgEl('rect', { x: 2, y: 18, width: 20, height: 3, rx: 1, fill: '#f00', 'fill-opacity': 1 }));
        }
        ccBtn.replaceChildren(icon);

        // Pill: saved default for this channel.
        const saved = barEl.getAttribute('ycm-cc-saved');     // 'on' | 'off' | null
        _showPillIcon(pill, saved === null ? 'none' : saved);
        const stateText = saved === 'on' ? LANG.playerCCStateOn : saved === 'off' ? LANG.playerCCStateOff : LANG.playerCCStateNone;
        pill.setAttribute('data-tooltip', LANG.playerPillTitle.replace('{cc}', stateText));
    }

    /**
     * Updates the bookmark: hollow when no speed is saved for the channel,
     * filled when it is, and the filled-with-red-dot icon when the user's
     * current speed or captions differ from what is saved. A video without captions does not
     * count as a caption difference (the user cannot turn them on), and the
     * caption check waits while the auto-apply controller is still working.
     *
     * @param {number|string} id  ycm-bar numeric id.
     */
    function updateBookmarkState(id) {
        const barEl = document.getElementById('ycm-bar' + id);
        const bm = barEl && barEl.querySelector('[ycm-btn="bookmark"]');
        if (!bm) return;
        const savedSpeed = barEl.getAttribute('ycm-saved-speed');
        const savedCC    = barEl.getAttribute('ycm-cc-saved');
        const video      = document.querySelector('video[ycm-video="' + id + '"]');

        let dirty = false;
        if (savedSpeed !== null && video && Math.abs(parseFloat(savedSpeed) - video.playbackRate) > 1e-6) dirty = true;
        const controllerBusy = !!(window._ysc_cc_stop && window._ysc_cc_stop[id]);
        if (savedCC !== null && !controllerBusy) {
            const native = getPlayerSubtitleBtn(id);
            if (_ccAvailable(native) && (native.attr('aria-pressed') === 'true') !== (savedCC === 'on')) dirty = true;
        }
        if (bm.getAttribute('ycm-bm') === 'anim') return;   // the save animation restores the state itself
        _showBookmarkIcon(bm, savedSpeed === null ? 'none' : (dirty ? 'changed' : 'saved'));
    }


    /**
     * Rebuilds all ycm-bars currently in the page, preserving the
     * caption button state (color + underline) and the active speed selection.
     *
     * Called after the user saves settings so new colors and button templates
     * take effect without requiring a page reload.
     */
    function refreshContainers() {
        $('[id^=ycm-bar]').each(function() {
            const old = this;
            const id  = old.id.replace('ycm-bar', '');

            // The video's actual speed is the truth (it may have been set by
            // YouTube's menu or keyboard, or be a temporary speed).
            const video    = document.querySelector('video[ycm-video="' + id + '"]');
            const selBtn   = old.querySelector('span[ycm-sel="true"]');
            const curspeed = video ? video.playbackRate
                : (selBtn ? parseFloat(selBtn.getAttribute('ycm-speed')) : 1);

            // Rebuild with new settings, carrying over the state attributes.
            const newDiv = buildControlBar(curspeed, id);
            for (const attr of ['ycm-cc-saved', 'ycm-cc-live']) {
                const v = old.getAttribute(attr);
                if (v !== null) newDiv.setAttribute(attr, v);
            }

            // Restore channel name tooltip on the bookmark.
            const channeldiv = $('[ycm-channel="' + id + '"]');
            if (channeldiv.length) {
                const channelname = readChannelCredits(-1, channeldiv);
                const bm = newDiv.querySelector('[ycm-btn="bookmark"]');
                if (bm) bm.dataset.tooltip = bm.dataset.tooltip.split(' [')[0] + (channelname !== '' ? ' [' + channelname + ']' : '');
            }

            $(old).replaceWith(newDiv);
            const savedSpeed = old.getAttribute('ycm-saved-speed');
            if (savedSpeed !== null) _markSavedSpeed(newDiv, parseFloat(savedSpeed));
            syncCCVisuals(id);
        });
    }


    /**
     * Returns a unique auto-incrementing integer used to tag each player
     * instance (ycm-bar / ycm-video / ycm-channel / ycm-audio).
     *
     * @returns {number}
     */
    function nextSlotId() {
        const n = window._ysc_slot_counter || 0;
        window._ysc_slot_counter = n + 1;
        return n;
    }

    /**
     * Updates the tooltip of the set button to show the current channel name.
     *
     * @param {number} id           ycm-bar numeric id.
     * @param {string} channelname  Channel display name; empty string clears the channel suffix.
     */
    function updateSetButtonTooltip(id, channelname = '') {
        const setBtn = document.querySelector('#ycm-bar' + id + ' > [ycm-btn="bookmark"]');
        if (!setBtn) return;
        const base = setBtn.dataset.tooltip.split(' [')[0];
        setBtn.dataset.tooltip = channelname ? `${base} [${channelname}]` : base;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SPA NAVIGATION OBSERVERS
    //
    // YouTube is a Single-Page Application. When the user navigates to a new
    // video without a full page reload, these observers detect the change and
    // reload the saved speed/caption preferences for the new video.
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * MutationObserver callback for ytd-watch-flexy[video-id].
     *
     * Fires whenever the video-id attribute changes (i.e. the user navigates to
     * a different video). Resets speed to 1x, clears underlines, then asynchronously
     * looks up the channel name (retrying up to 16 × 200ms if the DOM hasn't
     * settled yet) before applying saved speed and captions.
     */
    function onWatchVideoIdChange(records) {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const metaSel = 'ytd-watch-metadata #upload-info #channel-name';

        records.filter(r => r.attributeName === 'video-id').forEach(rec => {
            const flexy = rec.target;
            let bar = $('[id^=ycm-bar]', flexy);
            if (!bar.length) {
                // Back/forward navigation can drop the container entirely.
                console.log('YSC: ycm-bar missing after video-id change, reinitialising.');
                initPlayers();
                bar = $('[id^=ycm-bar]', flexy);
            }
            const slot = bar[0].id.replace('ycm-bar', '');
            const vid  = () => $('video[ycm-video="' + slot + '"]')[0];
            const applyRate = rate => {
                if (!$('span[ycm-speed="' + rate + '"]', bar).click().length) _setRate(vid(), rate);
            };
            let chDiv = $('#channel-name[ycm-channel="' + slot + '"]');

            // Drop to 1x right away; the real speed follows the channel lookup.
            applyRate(1);
            $('span', bar).css('text-decoration', '');
            bar[0].removeAttribute('ycm-saved-speed');
            updateSetButtonTooltip(slot);

            setTimeout(async () => {
                // Collab layouts may swap #channel-name out during navigation,
                // losing our ycm-channel tag — locate and re-tag it.
                const retag = (...sources) => {
                    for (const find of sources) {
                        chDiv = find();
                        if (chDiv.length) { chDiv.attr('ycm-channel', slot); return true; }
                    }
                    return false;
                };
                if (!chDiv.length && retag(() => $(flexy).find('#upload-info #channel-name'), () => $(metaSel))) {
                    console.log('YSC: channeldiv was stale, re-found and re-tagged.');
                }

                // Channel name can lag behind on slow loads: poll up to 16 × 200 ms.
                let name = readChannelCredits(slot, chDiv);
                for (let n = 1; name === '' && n <= 16; n++) {
                    if (n === 1) console.log('YSC: channel id', slot, 'channeldiv length', chDiv.length);
                    console.log('YSC: Waiting for channel name, attempt ' + n);
                    await sleep(200);
                    if (!chDiv.length) retag(() => $(metaSel));
                    name = readChannelCredits(slot, chDiv);
                }
                updateSetButtonTooltip(slot, name);

                // Give a second collab credit a moment to render.
                await sleep(300);

                const credits = readChannelCredits(slot, chDiv, true);
                console.log('YSC: channelArr resolved to', credits.map(c => c.id));
                const isMusic = chDiv.find('.badge-style-type-verified-artist').length > 0 || /VEVO$/.test(name);
                const [rate, why] = await resolveChannelSpeed({
                    channel:  credits,
                    defspeed: isMusic ? 1 : null,
                    force1x:  bar.closest('#movie_player').find('.ytp-live').length === 1
                });
                applyRate(rate);
                if (why === 'channelspeed') _markSavedSpeed(bar, rate);
                applySavedCaptions(slot, credits);
            }, 500);
        });
    }

    /**
     * MutationObserver callback for video[src] changes on the c4-player
     * (YouTube channel page embedded player). Resets to 1x then applies
     * saved speed and captions for the channel.
     */
    function onChannelPlayerSrcChange(records) {
        for (const rec of records) {
            if (rec.attributeName !== 'src' || rec.target.src === '') continue;
            const slot  = rec.target.getAttribute('ycm-video');
            const chDiv = $('#channel-name[ycm-channel="' + slot + '"]');
            const vid   = () => $('video[ycm-video="' + slot + '"]')[0];
            _setRate(vid(), 1);
            setTimeout(async () => {
                const credits = readChannelCredits(slot, chDiv, true);
                const isMusic = chDiv.find('.badge-style-type-verified-artist').length === 1;
                const [rate]  = await resolveChannelSpeed({ channel: credits, defspeed: isMusic ? 1 : null });
                _setRate(vid(), rate);
                applySavedCaptions(slot, credits);
            }, 1000);
        }
    }

    /**
     * Re-wires a video element that has lost its ycm-video attribute after a
     * DOM refresh (e.g. YouTube replaced the <video> element internally).
     */
    /**
     * Attaches the per-video listeners used for relative time and auto exit
     * fullscreen. (Entering fullscreen is driven by the document-level 'play'
     * listener in the START-PAUSED / FULLSCREEN section.)
     */
    function _attachVideoListeners(videoEl) {
        if (SHOW_RELATIVE_TIME) {
            for (const name of ['timeupdate', 'seeked', 'pause']) videoEl.addEventListener(name, updateRelativeTime, false);
        }
        videoEl.addEventListener('ratechange', () => {
            const slot = videoEl.getAttribute('ycm-video');
            const rate = videoEl.playbackRate;
            const target = parseFloat(videoEl.dataset.ycmTargetSpeed);
            // A change we did not make: right after a real click/key press it is
            // the user (YouTube's speed menu, Shift+< / >) → adopt it as the
            // target so the speed guardian and re-applies keep it. Without user
            // input it is YouTube resetting the speed → leave the target; the
            // guardian restores it while it runs.
            if (!_sameRate(rate, target) && performance.now() - _lastUserInput < 1500) {
                videoEl.dataset.ycmTargetSpeed = rate;
            }
            if (slot !== null) {
                syncSpeedButtons(document.getElementById('ycm-bar' + slot), rate);
                updateBookmarkState(slot);
            }
        }, false);
        videoEl.addEventListener('timeupdate', () => {
            const left = videoEl.duration - videoEl.currentTime;
            if (!isNaN(videoEl.duration) && videoEl.duration > 0 && left <= 5) tryAutoExitFullscreen(videoEl);
        }, false);
    }

    function rewireMonitoredPlayers() {
        $('#movie_player[ycm-player], #c4-player[ycm-player]').each(function() {
            const player = $(this);
            const slot   = player.attr('ycm-player');
            const vWrap  = player.find('video');
            const vEl    = vWrap[0];

            if (vWrap.attr('ycm-video') !== undefined) {
                console.log('YSC: Re-clicking active speed button', vWrap);
                reapplySelectedSpeed('#ycm-bar' + slot);
                return;
            }
            console.log('YSC: Rewiring video element', vWrap);
            setTimeout(() => {
                applyAudioBoost(vWrap, true);
                vWrap.attr('ycm-video', slot);
                reapplySelectedSpeed('#ycm-bar' + slot);
                syncCCVisuals(slot);
                _attachVideoListeners(vEl);
            }, 750);
        });
    }

    /**
     * Re-clicks the currently highlighted speed button for a given container,
     * restoring the playback rate if the video element was replaced.
     *
     * @param {string}  el   jQuery selector or element for the ycm-bar.
     * @param {boolean} log  If true, emits verbose console output.
     */
    function reapplySelectedSpeed(el, log = false) {
        try {
            $('span[ycm-speed]:visible', el)
                .filter(function() { return this.style.color == COLOR_SELECTED; })
                .click();
            syncCCVisuals($(el).attr('id').replace('ycm-bar', ''));
            if (log) console.log('YSC: reapplySelectedSpeed success');
        } catch (_) {
            if (log) console.log('YSC: reapplySelectedSpeed failed');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UTILITY FUNCTIONS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Formats a duration in seconds as H:MM:SS or M:SS.
     *
     * @param {number} duration  Duration in seconds.
     * @returns {string}
     */
    function formatClock(duration) {
        const total = Math.floor(duration);
        const h = Math.floor(total / 3600);
        const m = Math.floor(total / 60) % 60;
        const s = total % 60;
        const two = n => (n < 10 ? '0' : '') + n;
        return (h > 0 ? h + ':' + two(m) : String(m)) + ':' + two(s);
    }

    /**
     * Updates the relative-time display next to the YouTube timestamp.
     * Shows speed-adjusted current position and total duration.
     * Hidden when speed is 1x or video duration is not yet known.
     *
     * @param {Event|HTMLVideoElement} event  Video event or the video element itself.
     */
    function updateRelativeTime(event) {
        if (!SHOW_RELATIVE_TIME) return;
        const vid = typeof event.target === 'object' ? event.target : event;
        const slot = vid.getAttribute('ycm-video');
        const holder = $('#movie_player[ycm-player="' + slot + '"]:visible .ytp-time-display:visible .ytp-time-contents')[0];
        if (!holder) return;

        let out = holder.querySelector('.ycm-reltime');
        if (!out) {
            out = document.createElement('span');
            out.className = 'ycm-reltime';
            out.style.marginLeft = '8px';
            holder.appendChild(out);
        }
        const r = vid.playbackRate;
        out.innerHTML = _trustedHTML(r === 1 || isNaN(vid.duration)
            ? ''
            : `<span>( </span>${formatClock(vid.currentTime / r)} / ${formatClock(vid.duration / r)}<span> )</span>`);
    }

    /**
     * Creates a Web Audio gain+limiter graph for a video element.
     * Re-creates the graph when force=true (e.g. after AUDIO_BOOST changes).
     * A DynamicsCompressor is inserted when gain > 1 to prevent clipping.
     *
     * @param {HTMLVideoElement|null} el     Video element; defaults to `this`.
     * @param {boolean}               force  If true, tears down and rebuilds the graph.
     */
    function applyAudioBoost(el = null, force = false) {
        const media = (el !== null && typeof el === 'object') ? el : this;
        if (media.tagName !== 'VIDEO') return;

        let tag = media.getAttribute('ycm-audio');
        if (tag === null) {
            tag = String(nextSlotId());
            media.setAttribute('ycm-audio', tag);
        } else if (!force) {
            return;
        }

        // A media element can be attached to a MediaElementSource only once in
        // its lifetime, so an existing graph is re-tuned instead of rebuilt
        // (rebuilding threw "already connected" and aborted the settings save).
        const graphs = (window._ysc_audio_graphs ||= {});
        let g = graphs[tag];
        if (!g) {
            if (AUDIO_BOOST === 1 && !force) return;
            const ctx = new AudioContext();
            g = graphs[tag] = { ctx, gain: ctx.createGain(), lim: ctx.createDynamicsCompressor() };
            Object.entries({ threshold: -5, knee: 0, ratio: 40, attack: 0.001, release: 0.1 })
                .forEach(([k, v]) => { g.lim[k].value = v; });
            ctx.createMediaElementSource(media).connect(g.gain);
        }

        // Route: source → gain → (limiter when boosting) → destination.
        g.gain.gain.value = AUDIO_BOOST;
        try { g.gain.disconnect(); } catch (_) {}
        try { g.lim.disconnect(); } catch (_) {}
        if (AUDIO_BOOST > 1) {
            // Brick-wall limiter so high gain does not clip.
            g.gain.connect(g.lim);
            g.lim.connect(g.ctx.destination);
        } else {
            g.gain.connect(g.ctx.destination);
        }
    }

    /**
     * Observes the video element's src attribute for changes.
     * Clears ycm-fs-done when a new source loads so auto-fullscreen can re-run.
     *
     * @param {HTMLVideoElement} el  The video element to observe.
     */
    function watchVideoSource(el) {
        new MutationObserver(records => {
            for (const { target } of records) {
                if (target.src === '') {
                    // src cleared — the element may have been swapped out.
                    rewireMonitoredPlayers();
                    continue;
                }
                target.removeAttribute('ycm-fs-done');
                target.removeAttribute('ycm-fs-end-done');
                // A present ycm-video means a normal adaptive-stream src update.
                if (target.getAttribute('ycm-video') === null) {
                    console.log('YSC: watchVideoSource: ycm-video missing after src change, calling rewireMonitoredPlayers.');
                    rewireMonitoredPlayers();
                }
            }
        }).observe(el, { attributes: true, attributeFilter: ['src'] });
    }

    /**
     * Main initialisation function. Finds unmonitored YouTube player elements
     * and sets up the ycm-bar, speed/caption lookup, audio boost, relative
     * time display, and auto-fullscreen triggers.
     *
     * Handles:
     *   • #movie_player — standard /watch page.
     *   • #c4-player    — channel page featured video.
     */
    function initPlayers() {
        const musicBadge = div => div.find('.badge-style-type-verified-artist').length;

        $('#movie_player:visible:not([ycm-player]), #c4-player:visible:not([ycm-player])').each(async function() {
            const player = $(this);

            /** Tags player, channel block and video with a fresh slot id. */
            const claim = (chDiv, vWrap) => {
                const slot = nextSlotId();
                player.attr('ycm-player', slot);
                chDiv.attr('ycm-channel', slot);
                vWrap.attr('ycm-video', slot);
                vWrap.each(applyAudioBoost);
                return slot;
            };

            if (this.id === 'movie_player' && !this.classList.contains('ytp-player-minimized')) {
                let chDiv = player.closest('ytd-watch-flexy').find('#upload-info #channel-name');
                if (!chDiv.length) chDiv = $('ytd-watch-metadata #upload-info #channel-name');
                if (!chDiv.length) return;

                const name = readChannelCredits(-1, chDiv);
                if (name === '' && !chDiv.text()) return;

                const controls = player.find('div.ytp-right-controls');
                const vWrap    = player.find('video');
                if (!controls.length || !vWrap.length) return;

                // Several pollForPlayers ticks may race here; only initialise once.
                if (player.find('[id^="ycm-bar"]').length) {
                    console.log('YSC: ycm-bar already exists in player, skipping duplicate init.');
                    return;
                }

                const slot = claim(chDiv, vWrap);
                const vEl  = vWrap[0];


                console.log('YSC: Adding video-id observer');
                const flexy = player.closest('ytd-watch-flexy');
                new MutationObserver(onWatchVideoIdChange)
                    .observe((flexy.length ? flexy : $('ytd-watch-flexy:visible'))[0], { attributes: true });
                watchVideoSource(vEl || $('video:visible')[0]);

                const credits = readChannelCredits(-1, chDiv, true);
                const [rate, why] = await resolveChannelSpeed({
                    channel:  credits,
                    defspeed: (musicBadge(chDiv) > 0 || /VEVO$/.test(name)) ? 1 : null,
                    force1x:  player.find('.ytp-live').length === 1
                });

                const bar = buildControlBar(rate, slot);
                if (why === 'channelspeed') _markSavedSpeed(bar, rate);
                controls.prepend(bar);
                updateSetButtonTooltip(slot, name);

                _setRate(vEl, rate);                 // target updated by our buttons and by user speed changes

                // Speed guardian: YouTube sometimes resets the rate shortly after
                // load. For ~10 s, restore the target rate if it drifts.
                let ticks = 0;
                const guard = setInterval(() => {
                    if (++ticks >= 10) { clearInterval(guard); return; }
                    const want = parseFloat(vEl.dataset.ycmTargetSpeed);
                    if (!isNaN(want) && vEl.playbackRate !== want) {
                        console.log('YSC: Speed guardian correcting', vEl.playbackRate, '→', want);
                        vEl.playbackRate = want;
                    }
                }, 1000);

                applySavedCaptions(slot, credits);
                _attachVideoListeners(vEl);

            } else if (this.id === 'c4-player') {
                const chDiv = player.closest('ytd-browse').find('#header #channel-name');
                if (!chDiv.length || readChannelCredits(-1, chDiv) === '') return;
                const vWrap = player.find('video');
                if (!vWrap.length) return;

                const slot = claim(chDiv, vWrap);
                console.log('YSC: Adding c4 observer');
                new MutationObserver(onChannelPlayerSrcChange).observe(vWrap[0], { attributes: true, subtree: true });

                const credits = readChannelCredits(-1, chDiv, true);
                const [rate] = await resolveChannelSpeed({ channel: credits, defspeed: musicBadge(chDiv) === 1 ? 1 : null });
                _setRate(vWrap[0], rate);
                applySavedCaptions(slot, credits);
            }
        });

        // Catch any remaining videos (e.g. background embeds).
        if (AUDIO_BOOST !== 1) $('video:not([ycm-audio])').each(applyAudioBoost);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RELEVANT PAGE CHECK
    // Returns true if the current page is one where the script should be active:
    //   • /watch         — standard video page  (movie_player)
    //   • /@handle       — channel page         (c4-player)
    //   • /channel/<id>  — legacy channel URL   (c4-player)
    //   • /c/<name>      — legacy custom URL    (c4-player)
    //
    // This is required because @match is now set to youtube.com/* so that the
    // script is injected on every YouTube page and can receive yt-navigate-finish
    // events fired during SPA navigation from non-watch pages (e.g. home page).
    // Without this guard, pollForPlayers would spin indefinitely on unrelated pages.
    // ─────────────────────────────────────────────────────────────────────────
    function isRelevantPage() {
        const p = location.pathname;
        return p.startsWith('/watch') ||
               /^\/@[^/]/.test(p)    ||
               p.startsWith('/channel/') ||
               p.startsWith('/c/');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POLLING LOOP
    // Calls initPlayers() on a schedule until the player is fully initialised.
    // Poll interval doubles when the tab is hidden (backgrounded).
    // Stops when two [ycm-player] elements are found, or the page is no longer
    // a relevant page.
    // ─────────────────────────────────────────────────────────────────────────

    /** Tracks whether pollForPlayers is currently scheduled/running. Prevents duplicate loops. */
    let _pollRunning = false;

    function pollForPlayers() {
        _pollRunning = true;
        if (!isRelevantPage()) { _pollRunning = false; return; }   // left the page
        initPlayers();
        const tagged = document.querySelectorAll('[ycm-player]');
        if (tagged.length >= 2) { _pollRunning = false; return; }
        // Poll fast until the main player shows up, then back off; slower when hidden.
        const fast  = tagged.length === 0 || tagged[0].id !== 'movie_player';
        setTimeout(pollForPlayers, (fast ? 250 : 2000) * (isPageVisible() ? 1 : 2));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SPA NAVIGATION HANDLER
    // YouTube is a Single-Page Application. When the user navigates between
    // pages (e.g. from the home page to a watch page), the browser does NOT
    // reload — YouTube fires yt-navigate-finish instead.
    //
    // Because @match was previously set to /watch*, the script was never
    // injected on the home page, subscriptions, etc., so no yt-navigate-finish
    // listener was ever registered and the script would silently never run.
    //
    // Now that @match covers all of youtube.com/*, the script is always
    // present, and this listener starts pollForPlayers whenever the user arrives
    // at a relevant page via SPA navigation.
    // ─────────────────────────────────────────────────────────────────────────
    document.addEventListener('yt-navigate-finish', function() {
        console.log('[YSC] yt-navigate-finish. isRelevantPage:', isRelevantPage(), '| _pollRunning:', _pollRunning);
        if (isRelevantPage() && !_pollRunning) {
            pollForPlayers();
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // INITIAL START
    // Only start pollForPlayers on load if the page is already a relevant page
    // (e.g. user opened a /watch URL directly). For all other pages the
    // yt-navigate-finish listener above takes over.
    // ─────────────────────────────────────────────────────────────────────────
    function _initialStart() {
        if (isRelevantPage()) pollForPlayers();
    }

    // If audio boost is active, start polling immediately so the AudioContext
    // is created while a user gesture may still be in scope.
    // Otherwise wait for the load event so the DOM is ready before the first poll.
    // If the load event already fired before the async IIFE finished (common with
    // @run-at document-start + multiple GM.getValue awaits), call _initialStart
    // directly instead of registering a listener that will never fire.
    if (AUDIO_BOOST !== 1 || document.readyState === 'complete') {
        _initialStart();
    } else {
        window.addEventListener('load', _initialStart);
    }
})();