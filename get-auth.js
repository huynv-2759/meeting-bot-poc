const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

(async () => {
    console.log('🚀 Kích hoạt Tuyệt chiêu cuối: Dùng Google Chrome THẬT...');

    // Tạo một thư mục tạm để lưu cache/profile giống hệt người dùng thật
    const userDataDir = path.join(__dirname, 'tmp-chrome-profile');

    try {
        // Dùng launchPersistentContext thay vì launch bình thường
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            // BẮT BUỘC: Lệnh này ép Playwright dùng Chrome thật trên máy bạn thay vì Chromium
            channel: 'chrome', 
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox'
            ]
        });

        // Lấy tab đầu tiên được tạo ra
        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

        console.log('🌐 Đang vào trang đăng nhập Google...');
        await page.goto('https://accounts.google.com/');

        console.log('👉 VUI LÒNG ĐĂNG NHẬP BẰNG TÀI KHOẢN CỦA BẠN...');
        console.log('⏳ (Google sẽ thấy đây là Chrome thật và cho phép bạn qua)');

        // Chờ cho đến khi đăng nhập xong và bị chuyển hướng về trang quản lý tài khoản
        await page.waitForURL(/myaccount\.google\.com|google\.com\/\?/, { timeout: 300000 });

        console.log('✅ Đăng nhập thành công! Đang trích xuất vé VIP...');

        // Lưu lại Session
        await context.storageState({ path: 'auth.json' });
        
        console.log('🎉 XONG! Đã lưu file auth.json thành công.');
        await context.close();

        // Dọn dẹp thư mục rác sau khi lấy xong session
        fs.rmSync(userDataDir, { recursive: true, force: true });

    } catch (error) {
        console.error('❌ Lỗi:', error.message);
        console.log('⚠️ Lưu ý: Máy tính của bạn phải được cài đặt sẵn trình duyệt Google Chrome thật để chạy được lệnh này.');
    }
})();