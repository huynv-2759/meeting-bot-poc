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

const speakerSessions = {};
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
    console.log('🔌 [LOCAL SERVER] Bot đã kết nối thành công!');

    ws.on('message', async (message) => {
        const data = JSON.parse(message);

        // LUỒNG MAPPING TÊN 
        if (data.type === 'mapping') {
            if (!speakerSessions[data.ssrc]) {
                speakerSessions[data.ssrc] = { name: data.name, audioQueue: [], isReady: false };
                console.log(`\n🤖 [SYS] Đã gán SSRC ${data.ssrc} cho 👤 ${data.name.toUpperCase()}`);
            } else if (speakerSessions[data.ssrc].name !== data.name) {
                if (data.name !== "Unknown") {
                    console.log(`\n🤖 [SYS] CẬP NHẬT TÊN (SSRC: ${data.ssrc}): ${speakerSessions[data.ssrc].name} ➡️ ${data.name.toUpperCase()}`);
                    speakerSessions[data.ssrc].name = data.name;
                }
            }
        }

        // LUỒNG XỬ LÝ AUDIO
        if (data.type === 'audio') {
            const { ssrc, payload } = data;

            if (!speakerSessions[ssrc] || !speakerSessions[ssrc].sonioxWs) {
                if (!speakerSessions[ssrc]) speakerSessions[ssrc] = { name: `Người lạ (${ssrc})`, audioQueue: [], isReady: false };
                const session = speakerSessions[ssrc];

                session.decoder = createOpusDecoder();
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
                        language_hints: ['vi', 'en']
                    };
                    sonioxWs.send(JSON.stringify(initConfig));
                    session.isReady = true;
                    while (session.audioQueue.length > 0) sonioxWs.send(session.audioQueue.shift());
                });

                sonioxWs.on('message', (responseData) => {
                    const response = JSON.parse(responseData.toString());
                    if (response.error_code || response.error_message) return;

                    if (response.tokens && response.tokens.length > 0) {
                        const name = session.name || `Người lạ (${ssrc})`;
                        const text = response.tokens.map(t => t.text).join('');
                        console.log(`✨ [SONIOX] 👤 ${name.toUpperCase()}: "${text.trim()}"`);
                    }
                });

                sonioxWs.on('close', () => delete speakerSessions[ssrc].sonioxWs);
                sonioxWs.on('error', () => delete speakerSessions[ssrc].sonioxWs);
            }

            const session = speakerSessions[ssrc];
            const opusBuffer = Buffer.from(payload, 'base64');
            let pcmBuffer;
            try { pcmBuffer = session.decoder.decode(opusBuffer); } catch (err) { return; }

            if (pcmBuffer) {
                if (session.isReady && session.sonioxWs.readyState === WebSocket.OPEN) {
                    session.sonioxWs.send(pcmBuffer);
                } else {
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
            if (!ws) ws = new WebSocket('ws://localhost:8080');
            return ws;
        }

        // ==========================================
        // 1. MÁY QUÉT ĐỘNG NĂNG (TRACKING SÓNG ÂM) 
        // ==========================================
        window.__speakerActivity = {};
        
        const styleObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    const target = mutation.target;
                    const parent = target.parentElement;
                    
                    if (target.tagName === 'DIV' && !target.innerText && parent && parent.children.length >= 3 && parent.children.length <= 5) {
                        const tile = target.closest('div[data-participant-id]');
                        if (tile) {
                            const lines = tile.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 1);
                            
                            // 🔥 BỘ LỌC THÉP: Bổ sung triệt để các từ khóa ẩn của Google Meet
                            const ignoreKeywords = [
                                'bạn', 'you', 'tắt', 'ghim', 'bỏ ghim', 'pin', 'unpin', 'mute', 
                                'trình bày', 'presentation', 'video', 'màn hình', 'chính', 'mic', 'camera'
                            ];
                            
                            for (let line of lines) {
                                const lower = line.toLowerCase();
                                
                                // Loại bỏ nếu câu quá dài (tên người Việt hiếm khi vượt quá 35 ký tự)
                                if (line.length > 35) continue;
                                
                                // Loại bỏ mã ẩn
                                if (line.includes('_')) continue;
                                
                                // Quét xem có dính từ khóa cấm không
                                const isGarbage = ignoreKeywords.some(keyword => lower.includes(keyword));
                                if (isGarbage) continue;
                                
                                // Nếu vượt qua hết, chắc chắn 99.9% là Tên thật
                                window.__speakerActivity[line] = Date.now();
                                break;
                            }
                        }
                    }
                }
            });
        });

        function startObserver() {
            if (!document.body) {
                setTimeout(startObserver, 100);
                return;
            }
            styleObserver.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style'] });
        }
        startObserver();

        // ==========================================
        // 2. XỬ LÝ WEBRTC AUDIO 
        // ==========================================
        const originalPC = window.RTCPeerConnection;
        window.RTCPeerConnection = function (...args) {
            if (args.length === 0) args.push({});
            if (!args[0]) args[0] = {};
            args[0].encodedInsertableStreams = true;

            const pc = new originalPC(...args);
            let currentActiveSSRC = null;

            setInterval(async () => {
                try {
                    const stats = await pc.getStats();
                    let maxAudioLevel = 0;
                    let speakingSsrc = null;

                    stats.forEach(report => {
                        if (report.type === 'inbound-rtp' && report.kind === 'audio' && report.audioLevel > maxAudioLevel) {
                            maxAudioLevel = report.audioLevel;
                            speakingSsrc = report.ssrc;
                        }
                    });

                    if (maxAudioLevel > 0.005 && speakingSsrc) {
                        let eqName = null;
                        let mostRecentTime = 0;
                        const now = Date.now();

                        // Tìm người có sóng âm nảy gần đây nhất (trong 1 giây qua)
                        for (const [name, timestamp] of Object.entries(window.__speakerActivity)) {
                            if (now - timestamp < 1000 && timestamp > mostRecentTime) {
                                mostRecentTime = timestamp;
                                eqName = name;
                            }
                        }

                        if (eqName) {
                            // Cập nhật SSRC nếu đổi người
                            if (speakingSsrc !== currentActiveSSRC) {
                                currentActiveSSRC = speakingSsrc;
                            }
                            
                            // Gửi Mapping lên Server
                            if (getWS().readyState === 1) {
                                getWS().send(JSON.stringify({ type: 'mapping', ssrc: speakingSsrc, name: eqName }));
                            }
                        }
                    }
                } catch (e) { }
            }, 200); 

            pc.addEventListener('track', (event) => {
                if (event.track.kind === 'audio') {
                    const { readable, writable } = event.receiver.createEncodedStreams();
                    readable.pipeThrough(new TransformStream({
                        transform(frame, controller) {
                            const socket = getWS();
                            if (socket.readyState === 1) {
                                socket.send(JSON.stringify({
                                    type: 'audio',
                                    ssrc: frame.getMetadata().synchronizationSource,
                                    payload: btoa(String.fromCharCode(...new Uint8Array(frame.data)))
                                }));
                            }
                            controller.enqueue(frame);
                        }
                    })).pipeTo(writable);
                }
            });

            return pc;
        };
        window.RTCPeerConnection.prototype = originalPC.prototype;
        Object.assign(window.RTCPeerConnection, originalPC);
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