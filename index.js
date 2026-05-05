require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const WebSocket = require('ws');

chromium.use(stealth);

const SONIOX_API_KEY = process.env.SONIOX_API_KEY || 'key_soniox';

// --- BỘ GIẢI MÃ OPUS ---
let createOpusDecoder;
const OpusScript = require('opusscript');
createOpusDecoder = () => {
    const engine = new OpusScript(48000, 1, OpusScript.Application.AUDIO);
    return { decode: (buf) => engine.decode(buf) };
};

// Strip common Google Meet UI prefixes/suffixes to get clean participant names.
// Supports Vietnamese, English, and Japanese.
function cleanName(raw) {
    let name = (raw || '').trim();

    // --- PREFIX patterns (action word comes first, name after) ---
    const prefixes = [
        // Vietnamese
        /^(?:micrô|micro|microphone)\s+của\s+/i,
        /^(?:camera|video)\s+của\s+/i,
        /^(?:tuỳ chọn|tùy chọn)(?:\s+khác)?\s+cho\s+/i,
        /^(?:thêm tùy chọn|thêm tuỳ chọn)\s+cho\s+/i,
        /^(?:ghim|bỏ ghim)(?:\s+ô)?(?:\s+cho)?\s+/i,
        /^(?:tắt tiếng|bật tiếng)\s+/i,
        /^(?:xóa|xoá)\s+/i,
        /^(?:đặt tiêu điểm)\s+/i,
        // English
        /^(?:mute|unmute)\s+/i,
        /^(?:pin|unpin)(?:\s+tile(?:\s+for)?)?\s+/i,
        /^(?:more options for|options for)\s+/i,
        /^(?:remove|spotlight)\s+/i,
        // Japanese (action word first, less common in Meet but possible)
        /^ミュート[:：\s]+/,
        /^ミュート解除[:：\s]+/,
        /^ピン留め[:：\s]+/,
        /^ピン留めを解除[:：\s]+/,
        /^削除[:：\s]+/,
    ];

    // --- SUFFIX patterns (name comes first, action word after — typical in Japanese) ---
    const suffixes = [
        // Japanese の/を particle constructs
        /\s*のマイク.*$/,
        /\s*のカメラ.*$/,
        /\s*をミュートにする.*$/,
        /\s*のミュートを解除.*$/,
        /\s*のその他のオプション.*$/,
        /\s*をピン留め.*$/,
        /\s*のピン留めを解除.*$/,
        /\s*を削除.*$/,
        /\s*をスポットライト.*$/,
        // English possessive suffix
        /\s*['\u2019]s\s+(?:microphone|micro|camera|video|audio).*$/i,
    ];

    // Try prefixes first
    for (const p of prefixes) {
        const cleaned = name.replace(p, '');
        if (cleaned !== name) { name = cleaned.trim(); break; }
    }
    // Then try suffixes
    for (const s of suffixes) {
        const cleaned = name.replace(s, '');
        if (cleaned !== name) { name = cleaned.trim(); break; }
    }
    return name.trim();
}

const speakerSessions = {};
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
    console.log('🔌 [LOCAL SERVER] Bot đã kết nối thành công!');

    ws.on('message', async (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) {
            console.error('❌ [WS] Malformed message:', e.message);
            return;
        }

        // DEBUG từ browser
        if (data.type === 'debug') {
            console.log(`📝 [BROWSER] ${data.message}`);
            return;
        }

        // TRACK KẾt THÚC: xóa session để SSRC có thể được tái sử dụng cho participant mới
        if (data.type === 'track_ended') {
            const ssrc = String(data.ssrc);
            const session = speakerSessions[ssrc];
            if (session) {
                if (session.sonioxWs) {
                    try { session.sonioxWs.close(); } catch(e) {}
                }
                delete speakerSessions[ssrc];
                console.log(`\n🔚 [SYS] SSRC ${ssrc} track ended → session cleared`);
            }
            return;
        }

        // LUỒNG MAPPING TÊN
        if (data.type === 'mapping') {
            const ssrc = String(data.ssrc);
            const name = cleanName(data.name);
            if (!name || name.length < 2) return;

            // isNameTaken: chỉ chặn nếu SSRC khác đang THỰC SỰ active (có audio trong 3s gần đây).
            // Nếu SSRC kia đã im lặng lâu, cho phép tên đó được claim lại
            // (tránh trường hợp Meet reassign slot nhưng tên vẫn bị block).
            const isNameTaken = (n) => {
                const now = Date.now();
                return Object.entries(speakerSessions).some(
                    ([s, sess]) => s !== ssrc &&
                                   sess.nameConfirmed &&
                                   sess.name === n &&
                                   (now - (sess.lastAudioTime || 0)) < 3000
                );
            };

            if (!speakerSessions[ssrc]) {
                speakerSessions[ssrc] = {
                    name: `Người lạ (${ssrc})`, audioQueue: [], isReady: false,
                    decoder: null, sonioxWs: null, nameConfirmed: false,
                    nameCandidate: name, nameCount: 1, transcriptBuffer: [],
                    lastAudioTime: 0
                };
                return;
            }

            const session = speakerSessions[ssrc];

            // Tên này đang thuộc về SSRC khác đang active → bỏ qua
            if (isNameTaken(name)) {
                if (session.nameCandidate === name) {
                    session.nameCandidate = null;
                    session.nameCount = 0;
                }
                return;
            }

            if (session.nameCandidate === name) {
                session.nameCount = (session.nameCount || 0) + 1;
                if (session.nameCount >= 2) {
                    const nameChanged = session.name !== name;
                    if (nameChanged) {
                        if (session.nameConfirmed) {
                            // Meet đã reassign slot này sang người mới → reset Soniox
                            console.log(`\n🔄 [SYS] SSRC ${ssrc} slot reassigned: "${session.name}" → 👤 ${name.toUpperCase()}`);
                            if (session.sonioxWs) {
                                try { session.sonioxWs.close(); } catch(e) {}
                            }
                            session.transcriptBuffer = [];
                            session.nameConfirmed = false; // cần flush buffer lại
                        } else {
                            console.log(`\n🤖 [SYS] Xác nhận SSRC ${ssrc} → 👤 ${name.toUpperCase()}`);
                        }
                        session.name = name;
                    }
                    const wasConfirmed = session.nameConfirmed;
                    session.nameConfirmed = true;
                    // Thông báo browser: SSRC này đã chốt tên hiện tại
                    try { ws.send(JSON.stringify({ type: 'confirmed', ssrc, name })); } catch(e) {}
                    // Flush transcript buffer lần đầu confirm
                    if (!wasConfirmed && session.transcriptBuffer && session.transcriptBuffer.length > 0) {
                        const lastText = session.transcriptBuffer[session.transcriptBuffer.length - 1];
                        console.log(`✨ [SONIOX] 👤 ${name.toUpperCase()}: "${lastText}"`);
                        session.transcriptBuffer = [];
                    }
                }
            } else {
                session.nameCandidate = name;
                session.nameCount = 1;
            }
        }

        // LUỒNG XỬ LÝ AUDIO
        if (data.type === 'audio') {
            const { ssrc, payload } = data;

            if (!speakerSessions[ssrc]) {
                speakerSessions[ssrc] = { name: `Người lạ (${ssrc})`, audioQueue: [], isReady: false,
                    decoder: null, sonioxWs: null, transcriptBuffer: [], nameConfirmed: false, lastAudioTime: Date.now() };
            }
            const session = speakerSessions[ssrc];
            session.lastAudioTime = Date.now(); // cập nhật mỗi khi nhận audio

            // FIX: Chỉ tạo decoder một lần - tránh memory leak (native WASM) mỗi lần reconnect
            if (!session.decoder) {
                session.decoder = createOpusDecoder();
            }

            if (!session.sonioxWs) {
                const sonioxWs = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
                session.sonioxWs = sonioxWs;

                sonioxWs.on('open', () => {
                    const initConfig = {
                        api_key: SONIOX_API_KEY,
                        model: 'stt-rt-v4',
                        audio_format: 'pcm_s16le',
                        sample_rate_hertz: 48000,
                        sample_rate: 48000,
                        num_audio_channels: 1,
                        num_channels: 1,
                        enable_language_identification: true,
                        language_hints: ['vi', 'en', 'ja']
                    };
                    sonioxWs.send(JSON.stringify(initConfig));
                    session.isReady = true;
                    while (session.audioQueue.length > 0) sonioxWs.send(session.audioQueue.shift());
                });

                sonioxWs.on('message', (responseData) => {
                    try {
                        const response = JSON.parse(responseData.toString());
                        if (response.error_code || response.error_message) return;
                        if (response.tokens && response.tokens.length > 0) {
                            const text = response.tokens.map(t => t.text).join('').trim();
                            if (!text) return;
                            if (!session.nameConfirmed) {
                                // Tên chưa được xác nhận → buffer, không in ra
                                if (!session.transcriptBuffer) session.transcriptBuffer = [];
                                if (session.transcriptBuffer.length < 30) {
                                    session.transcriptBuffer.push(text);
                                }
                            } else {
                                console.log(`✨ [SONIOX] 👤 ${session.name.toUpperCase()}: "${text}"`);
                            }
                        }
                    } catch (e) {}
                });

                // FIX: Reset isReady khi WS đóng để tránh state bẩn
                const cleanup = () => {
                    if (speakerSessions[ssrc]) {
                        speakerSessions[ssrc].isReady = false;
                        speakerSessions[ssrc].sonioxWs = null;
                    }
                };
                sonioxWs.on('close', cleanup);
                sonioxWs.on('error', cleanup);
            }

            const opusBuffer = Buffer.from(payload, 'base64');
            let pcmBuffer;
            try { pcmBuffer = session.decoder.decode(opusBuffer); } catch (err) { return; }

            if (pcmBuffer) {
                if (session.isReady && session.sonioxWs && session.sonioxWs.readyState === WebSocket.OPEN) {
                    session.sonioxWs.send(pcmBuffer);
                } else if (session.audioQueue.length < 300) {
                    // FIX: Giới hạn queue tránh OOM khi Soniox mất kết nối lâu
                    session.audioQueue.push(pcmBuffer);
                }
            }
        }
    });
});

async function startBot(meetingUrl) {
    console.log('🚀 Khởi động Bot');

    const browser = await chromium.launch({
        headless: true, 
        args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--autoplay-policy=no-user-gesture-required',
            '--window-size=1280,720',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ]
    });

    const context = await browser.newContext({
        storageState: fs.existsSync('auth.json') ? 'auth.json' : undefined,
        viewport: { width: 1280, height: 720 } 
    });

    const page = await context.newPage();

    await context.addInitScript(() => {
        if (window !== window.top) return;

        let ws = null;
        function getWS() {
            if (!ws || ws.readyState === WebSocket.CLOSED) {
                ws = new WebSocket('ws://localhost:8080');
                ws.addEventListener('message', (e) => {
                    try {
                        const msg = JSON.parse(e.data);
                        // Server thông báo SSRC đã chốt tên hiện tại
                        if (msg.type === 'confirmed') {
                            const key = String(msg.ssrc);
                            window.__ssrcConfirmed[key] = true;
                            // Đồng bộ tên được server confirm (tránh race condition)
                            if (msg.name) window.__ssrcMap[key] = msg.name;
                        }
                    } catch(e2) {}
                });
            }
            return ws;
        }
        function send(obj) {
            try { if (getWS().readyState === 1) getWS().send(JSON.stringify(obj)); } catch(e) {}
        }
        function dbg(msg) { send({ type: 'debug', message: msg }); }

        // ====== NAME VALIDATION ======
        const IGNORE_LIST = [
            // Vietnamese UI strings
            '(bạn)', 'tắt tiếng', 'bật tiếng', 'ghim', 'bỏ ghim',
            'trình bày', 'màn hình', 'giơ tay', 'trình chiếu', 'rời khỏi', 'xóa khỏi',
            'micrô của', 'micro của', 'microphone của', 'camera của', 'video của',
            'tuỳ chọn', 'tùy chọn', 'đặt tiêu điểm',
            // English UI strings
            '(you)', 'mute', 'unmute', 'pin', 'unpin', 'presentation',
            'turn off', 'turn on', 'more options', 'minimize',
            'leave', 'remove', 'spotlight', 'screen share', 'raise hand',
            // Japanese UI strings (standalone - not part of a name)
            'ミュート', 'ミュート解除', 'ピン留め', 'スポットライト', '削除',
            'その他のオプション', 'マイクをオフ', 'マイクをオン',
            'カメラをオフ', 'カメラをオン', '画面を共有', '手を挙げる',
        ];

        function isValidName(t) {
            if (!t || typeof t !== 'string') return false;
            const s = t.trim();
            if (s.length < 2 || s.length > 60) return false;
            if (/^\d+$/.test(s)) return false;
            if (s.includes('_')) return false;
            const l = s.toLowerCase();
            return !IGNORE_LIST.some(kw => l.includes(kw));
        }

        // ====== NAME EXTRACTION - Multiple strategies ======
        // Order matters: most specific patterns first.
        // Vietnamese & Japanese: action first OR name first depending on grammar.
        const ARIA_PATTERNS = [
            // === VIETNAMESE (action first, name after) ===
            /^(?:Micrô|Micro|Microphone)\s+của\s+(.+)/i,
            /^(?:Camera|Video)\s+của\s+(.+)/i,
            /^(?:Tuỳ chọn|Tùy chọn)(?:\s+khác)?\s+cho\s+(.+)/i,
            /^(?:Thêm tùy chọn|Thêm tuỳ chọn)\s+cho\s+(.+)/i,
            /^(?:Ghim|Bỏ ghim)(?:\s+ô)?(?:\s+cho)?\s+(.+)/i,
            /^(?:Tắt tiếng|Bật tiếng)\s+(.+)/i,
            /^(?:Xóa|Xoá)\s+(.+)/i,
            /^(?:Đặt tiêu điểm)\s+(.+)/i,
            // === ENGLISH (action first, name after) ===
            /^(?:Mute|Unmute)\s+(.+)/i,
            /^(?:Pin|Unpin)(?:\s+tile(?:\s+for)?)?\s+(.+)/i,
            /^(?:More options for|Options for)\s+(.+)/i,
            /^(?:Remove|Spotlight)\s+(.+)/i,
            // === ENGLISH (name first, possessive suffix) ===
            /^(.+?)(?:'s|\u2019s)\s+(?:microphone|micro|camera|video|audio)/i,
            // === JAPANESE (name first, の/を particle suffix — SVO reversed) ===
            /^(.+?)のマイク/,
            /^(.+?)のカメラ/,
            /^(.+?)をミュートにする/,
            /^(.+?)のミュートを解除/,
            /^(.+?)のその他のオプション/,
            /^(.+?)をピン留め/,
            /^(.+?)のピン留めを解除/,
            /^(.+?)を削除/,
            /^(.+?)をスポットライト/,
            // === JAPANESE (action first — less common in Meet) ===
            /^(?:ミュート|ミュート解除)[:：\s]+(.+)/,
            /^(?:ピン留め|ピン留めを解除)[:：\s]+(.+)/,
        ];

        function extractNameFromElement(el) {
            if (!el) return null;

            // S1: aria-label patterns (most reliable - Meet puts names in button labels)
            const ariaEls = [el, ...Array.from(el.querySelectorAll('[aria-label]'))];
            for (const a of ariaEls) {
                const lbl = a.getAttribute?.('aria-label') || '';
                for (const p of ARIA_PATTERNS) {
                    const m = lbl.match(p);
                    if (m && isValidName(m[1].trim())) return m[1].trim();
                }
            }

            // S2: title attribute
            for (const el2 of el.querySelectorAll('[title]')) {
                const t = el2.getAttribute('title');
                if (isValidName(t)) return t;
            }

            // S3: data-* name attributes
            for (const attr of ['data-participant-name', 'data-name', 'data-self-name']) {
                const found = el.querySelector(`[${attr}]`);
                if (found) {
                    const v = found.getAttribute(attr);
                    if (isValidName(v)) return v;
                }
            }

            // S4: Leaf text nodes - name overlay labels (check all spans and divs)
            for (const el2 of el.querySelectorAll('span, div')) {
                if (el2.childElementCount === 0) {
                    const t = (el2.textContent || '').trim();
                    if (isValidName(t)) return t;
                }
            }
            return null;
        }

        // Walk up DOM to find participant tile from any descendant element
        function findParticipantTile(el) {
            let cur = el;
            for (let i = 0; i < 15; i++) {
                if (!cur || cur === document.documentElement) return null;
                if (cur.hasAttribute('data-participant-id') ||
                    cur.hasAttribute('data-requested-participant-id')) return cur;
                // Broader fallback: element containing a video AND extractable name
                if (i >= 5 && cur.querySelector?.('video') && extractNameFromElement(cur)) return cur;
                cur = cur.parentElement;
            }
            return null;
        }

        // ====== PARTICIPANT ROSTER ======
        window.__roster = {};         // pid → name
        window.__ssrcMap = {};         // ssrc(string) → last sent name (for throttle dedup)
        window.__ssrcLastSent = {};    // ssrc(string) → timestamp of last send
        window.__selfName = null;      // tên của bot — bị loại khỏi mapping
        window.__ssrcConfirmed = {};   // ssrc(string) → true khi server đã lock

        function rebuildRoster() {
            document.querySelectorAll('[data-participant-id], [data-requested-participant-id]').forEach(tile => {
                const pid = tile.getAttribute('data-participant-id') ||
                            tile.getAttribute('data-requested-participant-id');
                if (!pid) return;
                const name = extractNameFromElement(tile);
                if (name) {
                    window.__roster[pid] = name;
                    // Lưu tên bot từ self-tile — chỉ cần 1 lần
                    if (!window.__selfName && isSelfTile(tile)) {
                        window.__selfName = name;
                        dbg(`[SELF] Bot name detected: "${name}"`);
                    }
                }
            });
        }
        setInterval(rebuildRoster, 1500);
        // Lần đầu chạy ngay sau khi DOM sẵn sàng
        setTimeout(rebuildRoster, 2000);
        setTimeout(rebuildRoster, 4000);

        // ====== AUDIO RECEIVERS ======
        const audioReceivers = [];

        function getActiveSsrc(threshold) {
            threshold = threshold || 0.005;
            let max = 0, ssrc = null;
            for (const rx of audioReceivers) {
                try {
                    for (const src of rx.getSynchronizationSources()) {
                        if ((src.audioLevel || 0) > max) {
                            max = src.audioLevel || 0;
                            ssrc = src.source;
                        }
                    }
                } catch(e) {}
            }
            return max >= threshold ? ssrc : null;
        }

        // Throttle: gửi mapping tối đa 1 lần / 400ms per SSRC.
        // Không skip nếu tên thay đổi (người mới nói trên cùng SSRC cần được cập nhật).
        function sendMapping(name, ssrc) {
            if (!name || ssrc == null) return;
            // CRITICAL: không bao giờ map tên của bot chính nó
            if (window.__selfName && name === window.__selfName) return;
            const key = String(ssrc);
            const now = Date.now();
            // Nếu tên thay đổi so với confirmed → reset để cho phép gửi mapping mới
            // (Meet đã reassign slot này sang người khác)
            if (window.__ssrcMap[key] !== name) {
                window.__ssrcConfirmed[key] = false;
            }
            // Throttle: skip nếu cùng tên + đã confirmed + còn trong window
            if (window.__ssrcConfirmed[key] &&
                window.__ssrcMap[key] === name &&
                now - (window.__ssrcLastSent[key] || 0) < 400) return;
            window.__ssrcMap[key] = name;
            window.__ssrcLastSent[key] = now;
            send({ type: 'mapping', ssrc, name });
        }

        // ====== SELF-TILE DETECTION ======
        // Bot's own tile (self-view) always has waveform animation from fake mic device.
        // Must be excluded from speaker detection, otherwise all SSRCs get mapped to the bot's name.
        const SELF_MARKERS = ['(bạn)', '(you)', '(あなた)', '(자신)', '(본인)'];
        function isSelfTile(tile) {
            // Check full visible text AND all aria-labels within the tile
            const allText = [
                tile.innerText || tile.textContent || '',
                ...Array.from(tile.querySelectorAll('[aria-label]'))
                    .map(e => e.getAttribute('aria-label') || '')
            ].join(' ').toLowerCase();
            return SELF_MARKERS.some(m => allText.includes(m));
        }

        // ====== DETECT SPEAKING PARTICIPANT FROM DOM (3 methods) ======
        function findSpeakingNameFromDOM() {
            const allTiles = Array.from(document.querySelectorAll('[data-participant-id], [data-requested-participant-id]'));
            // CRITICAL: exclude bot's own tile - it always has fake mic waveform activity
            const tiles = allTiles.filter(t => !isSelfTile(t));
            if (tiles.length === 0) return null;

            // M1: Computed style - Google Meet adds colored box-shadow/outline on active speaker tile
            for (const tile of tiles) {
                try {
                    const cs = window.getComputedStyle(tile);
                    const bs = cs.boxShadow || '';
                    const ol = cs.outline || '';
                    // Detect colored ring (not black/transparent)
                    const hasColoredRing =
                        (bs !== 'none' && bs.includes('rgb(') &&
                         !bs.includes('rgb(0, 0, 0') && !bs.includes('rgba(0, 0, 0')) ||
                        (ol && ol.includes('px') && ol.includes('rgb(') &&
                         !ol.includes('rgb(0, 0, 0'));
                    if (hasColoredRing) {
                        const name = extractNameFromElement(tile);
                        if (name) return name;
                    }
                } catch(e) {}
            }

            // M2: Waveform bars - look for 2+ empty divs with scaleY transform inside a tile
            for (const tile of tiles) {
                const bars = Array.from(tile.querySelectorAll('div')).filter(d => {
                    if (d.childElementCount > 0 || (d.textContent || '').trim()) return false;
                    const st = d.getAttribute('style') || '';
                    return st.includes('scaleY') || (st.includes('transform') && st.includes('scale'));
                });
                if (bars.length >= 2) {
                    const name = extractNameFromElement(tile);
                    if (name) return name;
                }
            }

            // M3: Only 1 named remote tile - must be the speaker (2-person call)
            const namedTiles = tiles
                .map(t => extractNameFromElement(t))
                .filter(Boolean);
            if (namedTiles.length === 1) return namedTiles[0];

            return null;
        }

        // ====== PRIMARY: POLLING EVERY 150ms ======
        setInterval(() => {
            const ssrc = getActiveSsrc();
            if (!ssrc) return;
            const name = findSpeakingNameFromDOM();
            if (name) sendMapping(name, ssrc);
        }, 150);

        // ====== SECONDARY: MUTATION OBSERVER for immediate response ======
        function startObservers() {
            if (!document.body) { setTimeout(startObservers, 100); return; }

            new MutationObserver((muts) => {
                for (const m of muts) {
                    if (m.type !== 'attributes') continue;
                    if (!['style', 'class', 'aria-label', 'aria-pressed'].includes(m.attributeName)) continue;
                    const ssrc = getActiveSsrc();
                    if (!ssrc) break;
                    // Try to get name from mutated element's tile first, then global search
                    const tile = findParticipantTile(m.target);
                    const name = (tile && extractNameFromElement(tile)) || findSpeakingNameFromDOM();
                    if (name) { sendMapping(name, ssrc); break; }
                }
            }).observe(document.body, {
                attributes: true, subtree: true,
                attributeFilter: ['style', 'class', 'aria-label', 'aria-pressed']
            });

            // DOM observer for roster refresh when participants join/leave
            new MutationObserver(rebuildRoster).observe(document.body, {
                childList: true, subtree: true
            });
        }
        startObservers();

        // ====== DEBUG OUTPUT every 10s ======
        setInterval(() => {
            const tiles = document.querySelectorAll('[data-participant-id]');
            const activeSsrc = getActiveSsrc(0.001);
            dbg(`[DIAG] tiles:${tiles.length} ssrc:${activeSsrc} roster:${JSON.stringify(window.__roster)} ssrcMap:${JSON.stringify(window.__ssrcMap)}`);
        }, 10000);

        // ====== WEBRTC INTERCEPT ======
        const origPC = window.RTCPeerConnection;
        window.RTCPeerConnection = function (...args) {
            if (args.length === 0) args.push({});
            if (!args[0]) args[0] = {};
            args[0].encodedInsertableStreams = true;

            const pc = new origPC(...args);

            // FIX: Capture interval ID so we can clear it when PC closes/fails
            const statsInterval = setInterval(async () => {
                try {
                    const stats = await pc.getStats();
                    let maxLvl = 0, spkSsrc = null;
                    stats.forEach(r => {
                        if (r.type === 'inbound-rtp' && r.kind === 'audio' && (r.audioLevel || 0) > maxLvl) {
                            maxLvl = r.audioLevel || 0;
                            spkSsrc = r.ssrc;
                        }
                    });
                    if (maxLvl > 0.005 && spkSsrc) {
                        const name = findSpeakingNameFromDOM();
                        if (name) sendMapping(name, spkSsrc);
                    }
                } catch(e) {}
            }, 300);

            // FIX: Clear getStats interval when connection closes to prevent memory leak
            pc.addEventListener('connectionstatechange', () => {
                if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
                    clearInterval(statsInterval);
                }
            });

            pc.addEventListener('track', event => {
                if (event.track.kind !== 'audio') return;
                audioReceivers.push(event.receiver);

                // Ghi nhớ SSRC của track này từ frame đầu tiên
                let trackSsrc = null;

                // Khi track kết thúc: dọn SSRC + báo server xóa session
                event.track.addEventListener('ended', () => {
                    const idx = audioReceivers.indexOf(event.receiver);
                    if (idx !== -1) audioReceivers.splice(idx, 1);
                    if (trackSsrc != null) {
                        const key = String(trackSsrc);
                        delete window.__ssrcConfirmed[key];
                        delete window.__ssrcMap[key];
                        delete window.__ssrcLastSent[key];
                        send({ type: 'track_ended', ssrc: trackSsrc });
                    }
                });

                const { readable, writable } = event.receiver.createEncodedStreams();
                readable.pipeThrough(new TransformStream({
                    transform(frame, controller) {
                        const ssrc = frame.getMetadata().synchronizationSource;
                        // Ghi lại SSRC lần đầu để dùng khi track ended
                        if (trackSsrc == null && ssrc != null) trackSsrc = ssrc;
                        const socket = getWS();
                        if (socket.readyState === 1) {
                            socket.send(JSON.stringify({
                                type: 'audio',
                                ssrc,
                                payload: btoa(String.fromCharCode(...new Uint8Array(frame.data)))
                            }));
                        }
                        controller.enqueue(frame);
                    }
                })).pipeTo(writable);
            });

            return pc;
        };
        window.RTCPeerConnection.prototype = origPC.prototype;
        Object.assign(window.RTCPeerConnection, origPC);
    });

    try {
        await page.goto(meetingUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);

        await page.keyboard.press('Control+d');
        await page.keyboard.press('Control+e');
        await page.waitForTimeout(2000);

        const joinButton = page.locator('button:has-text("Yêu cầu tham gia"), button:has-text("Tham gia ngay"), button:has-text("Ask to join"), button:has-text("Join now")').first();

        await joinButton.waitFor({ state: 'visible', timeout: 15000 });
        await page.waitForFunction((btn) => !btn.disabled && btn.getAttribute('aria-disabled') !== 'true', await joinButton.elementHandle(), { timeout: 15000 });

        await joinButton.focus();
        await page.waitForTimeout(500);
        await page.keyboard.press('Enter');

        console.log('✅ Đã gửi yêu cầu Tham gia! Chờ Host duyệt...');
        await page.waitForTimeout(6000); 

        await page.keyboard.press('Escape'); 
        console.log('🎧 Hệ thống Soniox STT đã sẵn sàng lắng nghe và quét Sóng âm...');

        setInterval(async () => { try { if (!page.isClosed()) await page.mouse.move(500 + Math.random() * 100, 300 + Math.random() * 100); } catch (e) { } }, 4000);
        
        let intervalsPassed = 0;
        const checkInterval = setInterval(async () => {
            try {
                intervalsPassed++;
                if (intervalsPassed < 3) return; 

                const participants = await page.locator('[data-participant-id]').count();
                if (participants > 0 && participants <= 1) {
                    console.log(`👋 Phòng trống. Bot đang tự động rời đi...`);
                    clearInterval(checkInterval);
                    await browser.close();
                    process.exit(0); 
                }
            } catch (err) {}
        }, 10000);
        
        await new Promise(() => { });
    } catch (e) {
        console.error('❌ Lỗi Playwright:', e.message);
    }
}

const MEET_URL = process.env.MEET_URL;
if (MEET_URL) {
    startBot(MEET_URL);
} else {
    console.error("❌ Vui lòng truyền biến môi trường MEET_URL!");
}