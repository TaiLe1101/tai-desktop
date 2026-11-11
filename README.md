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

Menu chính là grid biểu tượng ứng dụng. Chọn **YouTube**, tìm và mở video ngay trong webview. Nhấn **Lấy phụ đề** để đọc trực tiếp từ YouTube và hiển thị nội dung/start/end, không dùng cache và không gọi worker. Sau khi lấy thành công, nhấn **Dịch** để kiểm tra cache và bắt đầu xử lý AI. Có thể bấm **Lấy phụ đề** lại để kiểm tra nguồn YouTube. Mở nền tảng hoặc chuyển video không tự xử lý. Màn hình nền tảng không có header hoặc thanh địa chỉ riêng.

## Luồng v2

```text
YouTube trong desktop (WebContentsView, session riêng)
  → nhận diện video, chờ người dùng nhấn Lấy phụ đề
  → kiểm tra video sẵn sàng và quảng cáo đã kết thúc
  → bật CC bằng nút của YouTube
  → Main Process bắt request /api/timedtext hoàn tất trên session riêng của webview
  → đọc lại đúng URL YouTube đã gọi trong cùng context/cookie, đọc JSON3 hoặc XML
  → giữ start/end gốc, loại cue trống và [Music]
  → hiển thị phụ đề, chờ người dùng nhấn Dịch
  → tạm dừng video, kiểm tra cache phụ đề/MP3 từng pack
  → gọi worker tuần tự cho các pack còn thiếu, lưu nguyên tử
  → khi ceil(tổng pack × 20%) pack đầu liên tiếp sẵn sàng:
       tua về 0:00 và phát
  → tiếp tục dịch nền đến hết video
```

Đang thử **cách 2** cho nút Lấy phụ đề: dùng track CC mà YouTube đang chọn; không fallback sang cách 1 và không tự đổi query/định dạng của URL bắt được. Listener lọc theo webContents và videoId. Nếu đã thấy request trong 2 phút gần nhất của video hiện tại, app dùng lại URL đó; đây chỉ là URL trong bộ nhớ, không dùng cache nội dung phụ đề. Nếu chưa có, app bật CC và chờ tối đa 30 giây. Request lỗi, chưa bắt được request và body rỗng có thông báo riêng. [Electron onCompleted](https://www.electronjs.org/docs/latest/api/web-request#webrequestoncompletedfilter-listener) chỉ báo hoàn tất request; ứng dụng đọc lại URL trong webview để lấy body.

Select **Ngôn ngữ nguồn** gồm Tiếng Anh (mặc định), Tiếng Trung, Tiếng Nhật và Tiếng Hàn. Chọn ngôn ngữ rồi nhấn **Lấy phụ đề**: app chọn track trên YouTube, bật CC và chỉ nhận request đúng ngôn ngữ nguồn, không nhận track auto-translate (`tlang`). Hỗ trợ các biến thể như `en-US`, `zh-Hans`, `zh-Hant`. Ưu tiên track do tác giả thêm, dùng track tự động nếu khả dụng. Không có track đúng ngôn ngữ thì báo lỗi, không lấy sang tiếng khác. Khi đổi select, cần lấy lại phụ đề trước khi nhấn Dịch. Cơ chế tải vẫn dùng cách 2, không fetch URL từ metadata player.

CC của YouTube chỉ được bật tạm để lấy dữ liệu; app tự tắt CC sau khi đọc xong payload hoặc gặp lỗi. Nếu đã chuyển sang video khác, tác vụ cũ không tắt CC của video mới. Người dùng vẫn có thể tự bật lại CC sau đó.

UI bên phải hiển thị **phụ đề nguồn**, mốc thời gian và trạng thái từng pack; bản dịch được nghe qua giọng AI do worker trả về. Endpoint hiện tại chưa trả nội dung bản dịch dạng text.

Giọng AI được phát trong renderer tin cậy, đồng bộ theo vị trí/tốc độ video. Âm thanh webview được tắt khi giọng dịch phát; khoảng không có giọng dịch dùng âm thanh gốc. Có công tắc tắt giọng AI. Bấm một cue để tua video. Tua vào pack chưa xong hoặc xử lý chậm sẽ tạm dừng để chờ pack đó; chỉ lần tạm dừng do bộ đệm mới tự tiếp tục. Khi chuyển video, kết quả đọc phụ đề cũ không được áp vào video mới. Job dịch đã bắt đầu vẫn hoàn tất để lưu cache (tối đa 4 video).

Worker lỗi sẽ dừng job và hiển thị lỗi; **Thử lại / tiếp tục** dùng lại các pack đã có. Không tự retry vô hạn. Ngưỡng 20% tính theo số pack liên tiếp từ đầu, không phải thời lượng video hoặc bất kỳ 20% pack rời rạc nào.

## Cache và quyền truy cập

Cấu hình ở Electron userData (`%APPDATA%/TAI Desktop/settings.json`); key được mã hóa bằng safeStorage. Có thể chọn thư mục cache trong Cấu hình. Cache v2:

```text
<audioDirectory>/<profile>/<videoId>/subtitles.json
<audioDirectory>/<profile>/<videoId>/chunk_<index>.mp3
```

Profile gồm ngôn ngữ nguồn, ngôn ngữ đích và phiên bản pipeline; không phụ thuộc URL tunnel. Đổi ngôn ngữ nguồn hoặc đích tạo cache riêng. Cache cũ chưa ghi ngôn ngữ nguồn không được dùng trong profile mới để tránh nhầm track; file cũ vẫn giữ trên ổ đĩa. Đổi model/voice trên cùng worker cần dọn cache liên quan khi app đã thoát. Cache không tự hết hạn hoặc tự nhận diện việc tác giả sửa phụ đề. Chọn thư mục mới không di chuyển file cũ.

YouTube chạy trong WebContentsView không có Node, không có preload/API IPC của desktop. Worker key không được đưa vào YouTube hoặc renderer. Điều hướng trang chính giới hạn HTTPS YouTube và các địa chỉ đăng nhập/consent, chuyển cookie Google đã liệt kê trong `canNavigate`. Không áp danh sách điều hướng trang chính cho redirect của iframe. Popup đăng nhập hợp lệ mở cửa sổ con sandbox với cùng session, giữ nguyên opener và luồng POST. Nếu app chặn một chuyển hướng, UI chỉ hiển thị hostname, không hiện query/token đăng nhập. App không inject script player vào trang xác thực và không throttle timer của webview khi cửa sổ ở nền. Từ chối download và các quyền ngoài fullscreen của YouTube. IPC chỉ nhận từ main frame của giao diện desktop. Đóng cửa sổ sẽ ghi session/cookie xuống ổ đĩa rồi thoát app và hủy request worker đang chạy; không mở local server hoặc chạy trong tray.

Bảng phụ đề có nút thu gọn/mở rộng, ghi nhớ lựa chọn trên máy. Nút fullscreen của YouTube mở video phủ toàn màn hình; Esc hoặc nút fullscreen của player quay về bố cục trước đó. Chưa kiểm thử fullscreen thực tế ở lần chỉnh UI này.

Webview tiếp tục dùng partition cố định `persist:tai-youtube-v2`, không xóa cookie khi đóng app. Vì vậy dữ liệu đăng nhập được giữ giữa các lần mở app theo cơ chế [persistent session của Electron](https://www.electronjs.org/docs/latest/api/session). Nếu đăng nhập thành công và cookie còn hiệu lực, thông thường không phải đăng nhập lại. Google vẫn có thể chặn đăng nhập trong trình duyệt nhúng, thu hồi phiên hoặc yêu cầu xác minh lại. Chưa thử đăng nhập bằng tài khoản thật.

## Phạm vi và giới hạn

- Video không có phụ đề: báo trạng thái rõ ràng. Chưa tách audio/ASR cho v2.
- Chưa hỗ trợ livestream, TikTok, Douyin hoặc điều hướng tùy ý ngoài các trang YouTube/Google được cho phép. Luồng đăng nhập thật vẫn cần người dùng kiểm tra; [Google có thể không hỗ trợ trình duyệt nhúng](https://support.google.com/accounts/answer/7675428).
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
