# Rymz Media website

Website downloader được chạy chung trong project API hiện tại nhưng tách riêng khỏi luồng OAuth và extension. Các trang công cụ chỉ xử lý URL HTTPS công khai từ nền tảng/CDN nằm trong allowlist; không vượt đăng nhập, nội dung riêng tư, mã hóa hoặc DRM.

## Chạy trên máy

```powershell
cd server
Copy-Item .env.example .env
npm install
npm test
npm run dev
```

Mở `http://localhost:8787`. API health check ở `http://localhost:8787/health`.

Để xem website tại đúng địa chỉ quen thuộc `http://localhost:3000`, chạy:

```powershell
npm run site
```

Nếu cổng 3000 đang hiển thị trang Shopee cũ thì cần dừng terminal của project cũ trước.

## Route website

- `/`: công cụ tổng hợp.
- `/facebook-video-downloader`
- `/pinterest-video-downloader`
- `/threads-video-downloader`
- `/instagram-video-downloader`
- `/tiktok-video-downloader`
- `/reddit-video-downloader`
- `/x-video-downloader`
- `/tools`, `/guides`, `/pricing`, `/api`
- `/privacy`, `/terms`, `/copyright`, `/contact`
- `/robots.txt`, `/sitemap.xml`, `/ads.txt`

## Biến môi trường production

Giữ secret ở Vercel, không chép vào extension và không commit file `.env`.

```dotenv
PUBLIC_SITE_URL=https://rymz.space
PUBLIC_BASE_URL=https://api.rymz.space
PUBLIC_CONTACT_EMAIL=contact@rymz.space
DOWNLOADER_SIGNING_SECRET=mot-chuoi-ngau-nhien-dai-it-nhat-32-ky-tu

# Tùy chọn sau khi website đã đủ điều kiện
GOOGLE_SITE_VERIFICATION=
GA_MEASUREMENT_ID=
ADSENSE_CLIENT_ID=
ADSENSE_TOP_SLOT=
ADSENSE_CONTENT_SLOT=
ADS_TXT=
```

Các biến OAuth hiện có như `META_APP_ID`, `META_APP_SECRET`, Threads và TikTok vẫn giữ nguyên. Thay đổi environment variables trên Vercel cần redeploy để deployment mới nhận cấu hình.

## Gắn domain mà không làm hỏng OAuth

1. Trong Vercel project đang chứa thư mục `server`, thêm cả `rymz.space`, `www.rymz.space` và giữ `api.rymz.space`.
2. Đặt `rymz.space` làm domain chính của website; redirect `www` về domain chính.
3. Giữ `PUBLIC_BASE_URL=https://api.rymz.space` để callback OAuth cũ không đổi.
4. Đặt `PUBLIC_SITE_URL=https://rymz.space` để canonical, sitemap và Open Graph dùng đúng domain.
5. Không xóa callback Facebook/Threads đang khai báo tại Meta nếu extension vẫn dùng chúng.

Website gọi `/api/downloader/*` cùng origin nên `rymz.space` và API downloader có thể ở cùng Vercel project. `api.rymz.space` vẫn là alias dùng cho OAuth/API của extension.

## SEO release checklist

1. Kiểm tra `https://rymz.space/robots.txt` và `https://rymz.space/sitemap.xml` trả HTTP 200.
2. Thêm property Domain `rymz.space` vào Google Search Console bằng DNS TXT.
3. Gửi `https://rymz.space/sitemap.xml` trong Search Console.
4. Dùng URL Inspection cho trang chủ và từng landing page quan trọng; yêu cầu lập chỉ mục sau khi domain đã trỏ đúng.
5. Không tạo hàng trăm trang gần giống nhau. Mỗi landing page phải có mô tả, FAQ và hướng dẫn thực sự riêng.
6. Theo dõi truy vấn, CTR, lỗi index và Core Web Vitals trước khi mở rộng nội dung.

## Kiếm tiền thực tế

- Giai đoạn 1: website miễn phí để lấy organic traffic, CTA cài extension và danh sách email Pro/API.
- Giai đoạn 2: bật AdSense sau khi có nội dung hữu ích, trang pháp lý và traffic thật. Không đặt quảng cáo sát hoặc giả dạng nút tải.
- Giai đoạn 3: bán Pro không quảng cáo, xử lý hàng đợi và API có quota.
- Affiliate chỉ đặt trong bài hướng dẫn liên quan và phải ghi rõ quan hệ tiếp thị. Không tự động chuyển hướng hoặc cài cookie khi người dùng chưa chủ động bấm.

## Giới hạn vận hành

- Nền tảng có thể đổi HTML hoặc chặn máy chủ; resolver cần test định kỳ.
- URL CDN thường hết hạn. Link tải Rymz được ký và chỉ tồn tại 15 phút.
- HLS/DASH được trả dưới dạng playlist nguồn; bản Vercel không hứa remux video dài vì giới hạn thời gian và bộ nhớ serverless.
- Nội dung cần đăng nhập nên dùng extension trong tab người dùng đã mở, khi họ có quyền sử dụng nội dung.

## Kiểm tra trước khi deploy

```powershell
cd server
npm run check
npm test
git diff --check
```

Sau đó commit/push lên repository đang kết nối với Vercel. Không commit `.env`, token Blob, App Secret hoặc access token.
