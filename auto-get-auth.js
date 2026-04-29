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

    try {
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false, // Phải mở UI để lừa Google đây là người dùng thật
            channel: 'chrome', 
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox'
            ]
        });

        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

        console.log('🌐 Đang vào trang đăng nhập Google...');
        await page.goto('https://accounts.google.com/');

        // --- BƯỚC 1: NHẬP EMAIL ---
        console.log(`📧 Đang nhập Email: ${email}...`);
        await page.waitForSelector('input[type="email"]', { state: 'visible' });
        await page.locator('input[type="email"]').pressSequentially(email, { delay: 120 });
        await page.keyboard.press('Enter');

        // --- BƯỚC 2: NHẬP PASSWORD ---
        console.log('🔑 Đang chờ form nhập mật khẩu...');
        await page.waitForSelector('input[type="password"]', { state: 'visible', timeout: 15000 });
        await page.waitForTimeout(1500); // Chờ hiệu ứng chuyển cảnh của Google hoàn tất
        
        console.log('⌨️ Đang gõ Mật khẩu...');
        await page.locator('input[type="password"]').pressSequentially(password, { delay: 100 });
        await page.keyboard.press('Enter');

        // --- BƯỚC 3: XỬ LÝ CÁC BÀI KIỂM TRA BẢO MẬT (RECOVERY EMAIL) ---
        console.log('⏳ Đang chờ Google duyệt... (Đang theo dõi màn hình)');
        
        let isLoggedIn = false;
        let timeout = 60; // Chờ tối đa 60 giây (mỗi giây quét 1 lần)
        
        while (timeout > 0 && !isLoggedIn) {
            const currentUrl = page.url();
            
            // Tình huống 1: Đã đăng nhập thành công mượt mà
            if (currentUrl.includes('myaccount.google.com') || currentUrl.includes('google.com/?')) {
                isLoggedIn = true;
                break;
            }

            // Tình huống 2: Bị vướng màn hình đòi Xác minh
            try {
                // 2.1: Nếu Google bắt CHỌN phương thức xác minh (Màn hình liệt kê các lựa chọn)
                // Thuộc tính data-challengetype="12" hoặc "13" thường đại diện cho Email khôi phục
                const recoveryOption = await page.$('div[data-challengetype="12"], div[data-challengetype="13"]'); 
                if (recoveryOption) {
                    console.log('🛡️ Bị Google chặn! Đang tự động click chọn "Xác nhận email khôi phục"...');
                    await recoveryOption.click();
                    await page.waitForTimeout(2000); // Chờ load trang mới
                }

                // 2.2: Nếu đang ở màn hình Ô NHẬP Email khôi phục (Input field)
                const recoveryInput = await page.$('input[name="knowledgePreregisteredEmailResponse"], input[type="email"]');
                if (recoveryInput) {
                    const isVisible = await recoveryInput.isVisible();
                    if (isVisible) {
                        if (recoveryEmail) {
                            console.log(`🛡️ Đang tự động điền Email khôi phục: ${recoveryEmail}...`);
                            // Focus và gõ email khôi phục
                            await recoveryInput.focus();
                            await recoveryInput.pressSequentially(recoveryEmail, { delay: 100 });
                            await page.keyboard.press('Enter');
                            
                            // Ngủ 5 giây để đợi Google xác thực
                            await page.waitForTimeout(5000); 
                        } else {
                            console.log('⚠️ Google đòi Email khôi phục nhưng bạn CHƯA CẤU HÌNH GOOGLE_RECOVERY_EMAIL trong .env!');
                            break; // Thoát vòng lặp vì không có email để nhập
                        }
                    }
                }
            } catch (e) {
                // Bỏ qua lỗi ngầm trong lúc DOM đang load
            }

            await page.waitForTimeout(1000);
            timeout--;
        }

        // --- BƯỚC 4: CHỐT KẾT QUẢ ---
        if (isLoggedIn) {
            console.log('✅ Đăng nhập thành công! Đang lưu Session...');
            await context.storageState({ path: 'auth.json' });
            console.log('🎉 XONG! Đã lưu file auth.json. Sẵn sàng đem Bot đi chiến đấu!');
        } else {
            console.error('❌ THẤT BẠI: Hết thời gian chờ hoặc Google chặn vì lý do khác (Vd: Bắt nhập SĐT). Hãy xem UI trình duyệt để biết chi tiết!');
        }

        // Đóng trình duyệt và xóa dọn rác
        await context.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });

    } catch (error) {
        console.error('❌ LỖI HỆ THỐNG:', error.message);
    }
})();
