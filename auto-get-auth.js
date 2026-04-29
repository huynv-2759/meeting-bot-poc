require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

(async () => {
    console.log('🚀 Kích hoạt luồng Auto-Login (Hỗ trợ vượt chốt chặn Email Khôi Phục)...');

    const email = process.env.GOOGLE_EMAIL;
    const password = process.env.GOOGLE_PASSWORD;
    const recoveryEmail = process.env.GOOGLE_RECOVERY_EMAIL;

    if (!email || !password) {
        console.error('❌ LỖI: Chưa cấu hình GOOGLE_EMAIL hoặc GOOGLE_PASSWORD trong file .env!');
        process.exit(1);
    }

    const userDataDir = path.join(__dirname, 'tmp-chrome-profile');

    // --- BƯỚC CHUẨN BỊ: Dọn dẹp profile cũ để tránh lỗi "Resource Busy" hoặc Treo ---
    if (fs.existsSync(userDataDir)) {
        try {
            console.log('🧹 Đang dọn dẹp profile cũ...');
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch (e) {
            console.log('⚠️ Cảnh báo: Không thể xóa profile cũ. Hãy đảm bảo không có Chrome ngầm nào đang chạy.');
        }
    }

    try {
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false, // Để false để quan sát và vượt bot dễ hơn
            channel: 'chrome', 
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox'
            ]
        });

        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

        // Nới lỏng timeout mặc định cho toàn page
        page.setDefaultTimeout(60000);

        console.log('🌐 Đang vào trang đăng nhập Google...');
        // Sử dụng domcontentloaded để tránh bị kẹt do các script tracking của Google
        await page.goto('https://accounts.google.com/', { 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });

        // --- BƯỚC 1: NHẬP EMAIL ---
        console.log(`📧 Đang nhập Email: ${email}...`);
        await page.waitForSelector('input[type="email"]', { state: 'visible' });
        await page.locator('input[type="email"]').pressSequentially(email, { delay: 120 });
        await page.keyboard.press('Enter');

        // --- BƯỚC 2: NHẬP PASSWORD ---
        console.log('🔑 Đang chờ form nhập mật khẩu...');
        await page.waitForSelector('input[type="password"]', { state: 'visible' });
        await page.waitForTimeout(2000); // Chờ ổn định giao diện
        
        console.log('⌨️ Đang gõ Mật khẩu...');
        await page.locator('input[type="password"]').pressSequentially(password, { delay: 100 });
        await page.keyboard.press('Enter');

        // --- BƯỚC 3: XỬ LÝ CÁC BÀI KIỂM TRA BẢO MẬT (RECOVERY EMAIL) ---
        console.log('⏳ Đang theo dõi màn hình để xử lý xác minh (nếu có)...');
        
        let isLoggedIn = false;
        let timeoutCount = 60; 
        
        while (timeoutCount > 0 && !isLoggedIn) {
            const currentUrl = page.url();
            
            // Kiểm tra nếu đã vào được trang quản lý tài khoản hoặc trang chủ Google
            if (currentUrl.includes('myaccount.google.com') || currentUrl.includes('google.com/?')) {
                isLoggedIn = true;
                break;
            }

            try {
                // 2.1: Nếu Google bắt CHỌN phương thức xác minh
                const recoveryOption = await page.$('div[data-challengetype="12"], div[data-challengetype="13"]'); 
                if (recoveryOption) {
                    console.log('🛡️ Phát hiện màn hình chọn xác minh. Đang chọn "Xác nhận email khôi phục"...');
                    await recoveryOption.click();
                    await page.waitForTimeout(3000);
                }

                // 2.2: Nếu đang ở màn hình Ô NHẬP Email khôi phục
                const recoveryInput = await page.$('input[name="knowledgePreregisteredEmailResponse"], input[type="email"]');
                if (recoveryInput && await recoveryInput.isVisible()) {
                    if (recoveryEmail) {
                        console.log(`🛡️ Đang tự động điền Email khôi phục: ${recoveryEmail}...`);
                        await recoveryInput.focus();
                        await recoveryInput.pressSequentially(recoveryEmail, { delay: 100 });
                        await page.keyboard.press('Enter');
                        await page.waitForTimeout(5000); 
                    } else {
                        console.log('⚠️ Google yêu cầu Email khôi phục nhưng bạn chưa cấu hình trong .env!');
                        break;
                    }
                }
            } catch (e) {
                // Bỏ qua lỗi selector trong khi chuyển trang
            }

            await page.waitForTimeout(1500);
            timeoutCount--;
        }

        // --- BƯỚC 4: CHỐT KẾT QUẢ ---
        if (isLoggedIn) {
            console.log('✅ Đăng nhập thành công!');
            await context.storageState({ path: 'auth.json' });
            console.log('🎉 Đã lưu file auth.json thành công.');
        } else {
            console.error('❌ THẤT BẠI: Quá thời gian chờ hoặc bị chặn bởi yếu tố bảo mật khác (như SĐT).');
        }

        // Đóng trình duyệt
        await context.close();
        
        // Dọn dẹp sau khi chạy xong
        if (fs.existsSync(userDataDir)) {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }

    } catch (error) {
        console.error('❌ LỖI HỆ THỐNG:', error.message);
    }
})();