# TAI Desktop 2.0.0

Ứng dụng Electron + React + Material UI để xem YouTube và dịch/lồng tiếng trực tiếp qua AI worker. Không cần extension, tai-be, yt-dlp hoặc local HTTP server.

## Chạy

Yêu cầu Node.js 22.12+ hoặc 24:

```powershell
cd tai-desktop
npm install
npm run dev
```

Vào **Cấu hình**: nhập URL worker HTTPS (HTTP chỉ cho localhost), Worker access key và ngôn ngữ `vi`, `en` hoặc `ja`. Dùng worker hiện có trong `../tai-worker`, endpoint `POST /process-tts`, request `{text,target_lang}`, response `audio/mpeg`. Desktop không cần Gemini key. Worker phải đang chạy và có cấu hình dịch/TTS hợp lệ.

Ở menu chính, chọn **YouTube**, tìm video trong webview hoặc dán URL YouTube vào thanh địa chỉ. Chỉ hiện nền tảng YouTube ở phiên bản này.

## Luồng v2

```text
YouTube trong desktop (WebContentsView, session riêng)
  → nhận diện video, đợi quảng cáo kết thúc, tạm dừng
  → đọc phụ đề đã lưu hoặc lấy captionTracks từ player trong webview
  → lấy phụ đề JSON3 (có fallback XML) bằng context YouTube
  → giữ start/end gốc, loại cue trống và [Music]
  → kiểm tra MP3 từng pack
  → gọi worker tuần tự cho các pack còn thiếu, lưu nguyên tử
  → khi ceil(tổng pack × 20%) pack đầu liên tiếp sẵn sàng:
       tua về 0:00 và phát
  → tiếp tục dịch nền đến hết video
```

Phụ đề do tác giả thêm và phụ đề tự động đều được hỗ trợ; ưu tiên track ứng với ngôn ngữ gốc, fallback sang track khả dụng. Chưa có bộ chọn track thủ công. UI bên phải hiển thị **phụ đề nguồn**, mốc thời gian và trạng thái từng pack; bản dịch được nghe qua giọng AI do worker trả về. Endpoint hiện tại chưa trả nội dung bản dịch dạng text.

Giọng AI được phát trong renderer tin cậy, đồng bộ theo vị trí/tốc độ video. Âm thanh webview được tắt khi giọng dịch phát; khoảng không có giọng dịch dùng âm thanh gốc. Có công tắc tắt giọng AI. Bấm một cue để tua video. Tua vào pack chưa xong hoặc xử lý chậm sẽ tạm dừng để chờ pack đó; chỉ lần tạm dừng do bộ đệm mới tự tiếp tục. Khi chuyển video, kết quả đọc phụ đề cũ không được áp vào video mới. Job dịch đã bắt đầu vẫn hoàn tất để lưu cache (tối đa 4 video).

Worker lỗi sẽ dừng job và hiển thị lỗi; **Thử lại / tiếp tục** dùng lại các pack đã có. Không tự retry vô hạn. Ngưỡng 20% tính theo số pack liên tiếp từ đầu, không phải thời lượng video hoặc bất kỳ 20% pack rời rạc nào.

## Cache và quyền truy cập

Cấu hình ở Electron userData (`%APPDATA%/TAI Desktop/settings.json`); key được mã hóa bằng safeStorage. Có thể chọn thư mục cache trong Cấu hình. Cache v2:

```text
<audioDirectory>/<profile>/<videoId>/subtitles.json
<audioDirectory>/<profile>/<videoId>/chunk_<index>.mp3
```

Profile gồm ngôn ngữ đích và phiên bản pipeline; không phụ thuộc URL tunnel. Đổi ngôn ngữ tạo cache riêng. Đổi model/voice trên cùng worker cần dọn cache liên quan khi app đã thoát. Cache không tự hết hạn hoặc tự nhận diện việc tác giả sửa phụ đề. Cache ASR cũ không được dùng làm cache caption v2; file cũ vẫn được giữ trên ổ đĩa. Chọn thư mục mới không di chuyển file cũ.

YouTube chạy trong WebContentsView không có Node, không có preload/API IPC của desktop. Worker key không được đưa vào YouTube hoặc renderer. Điều hướng giới hạn HTTPS YouTube; từ chối popup, download và yêu cầu quyền của trang. IPC chỉ nhận từ main frame của giao diện desktop. Đóng cửa sổ sẽ thoát app, hủy request worker đang chạy; không mở local server hoặc chạy trong tray.

## Phạm vi và giới hạn

- Video không có phụ đề: báo trạng thái rõ ràng. Chưa tách audio/ASR cho v2.
- Chưa hỗ trợ livestream, TikTok, Douyin, đăng nhập Google qua popup hoặc điều hướng ngoài YouTube.
- YouTube có thể chặn/trả rỗng caption, yêu cầu consent hoặc thay đổi player API. Bật CC rồi thử lại; lỗi không chuyển âm thầm sang ASR.
- Giọng AI được điều chỉnh tốc độ theo cue; câu dịch quá dài và phụ đề tự động chồng nhau có thể ảnh hưởng chất lượng nghe. Đây chưa phải đồng bộ ở mức sample.
- Worker/Colab thật cần được kiểm tra end-to-end trước khi phát hành. Bộ cài chưa ký số.

## Kiểm tra và đóng gói

```powershell
npm test
npm run build
npm run dist:win
```

Tests dùng worker giả lập kiểm tra cache, key, retry, giữ timestamp, phân tách ngôn ngữ, ngưỡng 20%, bộ đọc JSON3 và chống dùng player response cũ khi chuyển video. Chưa thay thế kiểm thử với YouTube/Colab thật.

Tham khảo API: [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [Material UI](https://mui.com/material-ui/getting-started/installation/).
