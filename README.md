# HANOI FLOW LAB

Phòng thí nghiệm mô phỏng giao thông Hà Nội, chạy trên trình duyệt: bản đồ OpenStreetMap thật của một khu Đống Đa, giao thông hỗn hợp kiểu Hà Nội (xe máy lách, xe đạp, ô tô, taxi, van, SUV, xe buýt, xe tải, người đi bộ, ngõ ngách, va quẹt), đèn tín hiệu với 3 bộ điều khiển (cố định, cảm biến, AI điều phối) và chế độ so sánh khoa học.

- Bản chạy thử: https://roccat92.github.io/hanoi-flow-lab/
- Khu vực: Ô Chợ Dừa - Xã Đàn - Tây Sơn - Thái Hà - Hoàng Cầu - Láng Hạ (bbox 21.004-21.024 N, 105.814-105.838 E)
- Dữ liệu bản đồ: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)

## Hai engine, cùng một giao diện

| Engine | Dùng khi | Độ trung thực |
|---|---|---|
| SUMO qua TraCI (`backend/server.py`) | chạy local, `?backend=ws://localhost:8765/ws` | engine chuẩn (SUMO sublane 0.8 m, không teleport) |
| TypeScript Web Worker (`src/engine`) | GitHub Pages (tĩnh, không có server) | thấp hơn SUMO, có ghi rõ trên giao diện |

Engine TS: IDM theo từng loại xe, mô hình làn phụ (xe máy chọn vị trí ngang để lách khe, ô tô đổi làn kiểu MOBIL rút gọn, xếp làn trước khi rẽ), xung đột trong nút tính bằng hình học quỹ đạo, giữ chỗ (reservation) khi xe cam kết đi qua nút, luật "không vào nút khi lối ra chưa có chỗ" (tràn ngược), ưu tiên theo cấp đường ở nút không đèn, định tuyến lại theo thời gian thực mỗi 60 s. Không teleport, không xoá xe: xe chưa vào được mạng thì xếp hàng chờ ở cửa vào và vẫn bị tính trễ.

### Giao thông hỗn hợp kiểu Hà Nội

- 8 loại phương tiện: xe máy, xe đạp (~2%), ô tô con, taxi, xe van, SUV, xe buýt, xe tải.
- Thanh "mức độ hỗn loạn" (0-1, mặc định 0.6, tham số URL `chaos`): xe máy bám sát hơn, lách khe, tràn ra mép đường khi kẹt, bò qua vạch dừng khi đỏ; ô tô nhích vào khe và bị xe máy vây; chấp nhận khe hở gắt hơn khi rẽ trái/ra khỏi ngõ; thỉnh thoảng vượt đèn đỏ (chỉ khi nút trống, không có người đi bộ, không có luồng xung đột). Mọi kiểm tra khoảng cách vẫn dựa trên hình học nên không bao giờ chồng xe.
- Người đi bộ qua vạch kẻ: vạch ở nút có đèn (đi khi luồng xe cắt ngang đang đỏ) và vạch giữa phố từ OSM (chờ khe hở). Xe dừng nhường người đang qua đường.
- Ngõ/ngách: đường hẹp, chủ yếu xe máy, ô tô chỉ vào ngõ đủ rộng, xe tải/xe buýt không vào; ra khỏi ngõ bị phạt thời gian (ma sát). Cây ngõ cụt được gộp thành "vùng dân cư" phát sinh/thu hút chuyến đi (dữ liệu suy luận, có đánh dấu trên giao diện).
- Xe buýt dừng đón trả khách tại điểm dừng OSM.
- Va quẹt (bật/tắt, tần suất mỗi giờ, thời lượng 20-40 phút mô phỏng, có đám đông xem): 2 xe gần nhau dừng lại, tài xế xuống cãi nhau, chắn một phần đường, xe khác lách qua. Lịch va quẹt sinh từ seed riêng nên giống hệt nhau giữa các bộ điều khiển trong chế độ so sánh. Nhật ký "🚨 Sự cố & sự kiện" ghi bằng tiếng Việt.
- Chưa làm: đi ngược chiều ngắn ở mép đường và cắt góc khi rẽ trái sớm (chỉ có chấp nhận khe hở gắt), vì chưa bảo đảm được không chồng xe.

### Trình chỉnh sửa bản đồ (nút "Chỉnh sửa")

Thêm/xoá/dời đèn, chu kỳ, độ lệch pha và thời gian xanh từng pha; số làn, tốc độ, đóng đường, một chiều, cấm rẽ; hệ số nhu cầu từng vùng; mức hỗn loạn, vi phạm, va quẹt. Áp dụng ngay cho mô phỏng và cho chế độ so sánh. Lưu/mở kịch bản trong trình duyệt (localStorage), xuất/nhập JSON, khôi phục kịch bản Hà Nội mặc định. Dữ liệu suy luận (số làn, tốc độ, một chiều không có trong OSM) có nhãn "suy luận".

### Chế độ SUMO

Lớp đèn và bảng kiểm tra nút/xe giờ chạy qua backend: mỗi luồng rẽ của bản đồ TS được ghép với link điều khiển của đèn SUMO theo vị trí và hướng vào/ra (171/292 luồng ghép trực tiếp, phần còn lại lấy màu của cùng hướng vào; 28/32 nút đèn TS có đèn SUMO tương ứng). Bảng nút hiển thị pha SUMO, hàng chờ từng hướng, quan sát và áp lực của AI; bảng xe đọc qua TraCI.

## Bộ điều khiển đèn

- Cố định: chu kỳ 90 s, chia thời gian xanh theo số làn và cấp đường.
- Cảm biến (actuated): xanh tối thiểu, kéo dài khi còn xe tới trong 3 s, xanh tối đa 60 s, bỏ qua pha không có xe.
- AI điều phối v2 (nhận biết mạng lưới): với mỗi pha, lượng xe xả được = min(hàng chờ + 0.7 xe sắp tới trong 12 s + 0.5 đoàn xe nút trên vừa xả, năng lực bão hoà x 12 s, chỗ trống đường ra); áp lực = lượng xả được - 0.35 hàng chờ đường ra + 3 x (chờ lâu nhất/60)^2 + người đi bộ chờ. Chỉ đổi pha khi lợi hơn chi phí mất xanh (vàng + đỏ toàn phần); đổi ngay khi đường ra tràn ngược; giữ xanh khi đoàn xe sắp tới < 6 s; cắt xanh khi hết xe 2.5 s; xanh tối đa 90 s. Tham số chỉnh trên seed 4 (không nằm trong seed đánh giá 1-3). Mỗi quyết định có lời giải thích sinh từ số liệu thật.
- Lớp an toàn dùng chung cho cả 3: không bao giờ có 2 luồng ưu tiên xung đột cùng xanh, vàng 3 s, đỏ toàn phần 2 s, xanh tối thiểu 8 s (dài hơn khi có người đi bộ chờ), xanh tối đa 90 s, chống bỏ đói (pha có nhu cầu bị đỏ quá 120 s thì bị ép chuyển).

## Kết quả so sánh đo thật (engine TS, 30 phút, trung bình seed 1, 2, 3)

Mỗi ô: trễ TB mỗi chuyến (s) / tổng giờ-xe mất (gồm cả xe chưa xong và xe chờ ở cửa vào) / số chuyến hoàn thành. In đậm = ít giờ-xe mất nhất. Cùng seed, cùng nhu cầu, mức hỗn loạn 0.6, va quẹt 1 lần/giờ (lịch giống hệt nhau cho cả 3 bộ điều khiển).

| Kịch bản | Cố định | Cảm biến | AI v2 | AI v2 so với cố định (giờ-xe) | AI v2 so với cảm biến (giờ-xe) | Xung đột người đi bộ (9 lượt) | Va quẹt mỗi lượt |
|---|---|---|---|---|---|---|---|
| Bình thường | 106.5 / 104.5 / 2803 | **96.4 / 99.6** / 2793 | 86.7 / 102.0 / 2760 | -2.5% | +2.4% | 0 | 0-4 |
| Cao điểm sáng | 148.2 / 207.8 / 3667 | 149.8 / 211.0 / 3734 | **142.3 / 206.4** / 3812 | -0.7% | -2.2% | 0 | 0-4 |
| Cao điểm chiều | 195.0 / 373.2 / 3436 | 177.7 / 401.3 / 3348 | **182.5 / 364.7** / 3437 | -2.3% | -9.1% | 0 | 0-4 |
| Tắc cực đoan | 219.6 / 545.0 / 5018 | 210.1 / 560.9 / 4982 | **202.5 / 523.4** / 5130 | -4.0% | -6.7% | 0 | 0-4 |
| Sự cố Xã Đàn | 128.4 / 178.7 / 3431 | 121.1 / 166.5 / 3530 | **108.6 / 136.0** / 3574 | -23.9% | -18.3% | 0 | 0-4 |
| Mưa lớn | 237.1 / 303.7 / 3015 | 230.1 / 285.3 / 3127 | **210.3 / 267.6** / 3197 | -11.9% | -6.2% | 0 | 0-4 |
| Sự kiện Gò Đống Đa | 94.4 / 109.3 / 3244 | 90.0 / 98.4 / 3278 | **85.4 / 92.2** / 3247 | -15.6% | -6.3% | 0 | 0-4 |

Đọc kết quả trung thực:
- AI v2 ít giờ-xe mất nhất ở 6/7 kịch bản; ở "Bình thường" thua đèn cảm biến 2.4%. Ở cao điểm sáng mọi bộ gần như ngang nhau (chênh < 3%).
- Lợi thế lớn nhất khi mạng bị xáo trộn (sự cố, mưa, sự kiện: -6% đến -18% so với cảm biến), nhỏ khi mạng bình thường.
- AI v1 (đo trên engine ngay trước bản sửa an toàn người đi bộ, nên không so trực tiếp từng con số): thua đèn cố định ở cao điểm sáng (219.8 so với 202.6 giờ-xe) và chỉ thắng cảm biến ở 1/7 kịch bản (cao điểm chiều, 337.0 giờ-xe, tốt hơn cả AI v2 lần này).
- 0 vi phạm an toàn tín hiệu, 0 xung đột người đi bộ, 0 chồng xe ở mọi lượt chạy. Số liệu đầy đủ: `results/compare_*.json`, `results/compare_*.log`, bảng: `results/COMPARISON_v2.md`.

### So sánh bằng SUMO (cao điểm sáng, 30 phút, seed 1, 2, 3, cùng chuyến đi cho cả 3)

Mạng SUMO được dựng lại từ OSM mới (có cả ngõ), nên mạng kẹt nặng hơn lần trước (tốc độ TB 5-7 km/h, 550-630 xe chờ ở cửa vào).

| | Cố định | Cảm biến | AI v2 |
|---|---|---|---|
| Trễ TB (s, SUMO timeLoss) | 145.1 | **106.4** | 145.2 |
| Thời gian đi TB (s) | 299.8 | **262.1** | 304.4 |
| Chuyến hoàn thành | 2211 | **2346** | 2278 |

Trên SUMO, AI v2 hoàn thành nhiều chuyến hơn đèn cố định nhưng trễ TB ngang đèn cố định và **thua rõ** đèn cảm biến SUMO. Bản port trong `backend/simcore.py` dùng cùng quy tắc nhưng chỉ quan sát được theo làn SUMO (không có đoàn xe từ nút trên, năng lực bão hoà ước lượng thô), và pha SUMO do netconvert sinh ra khác pha của engine TS.

## Thí nghiệm: không đèn, vàng nhấp nháy, chỉ đèn nút lớn và cấu hình tối ưu

Các chế độ mới (chọn ở ô "Điều khiển", so sánh nhiều chế độ cùng lúc trong "⚗ So sánh", kết quả ở nút "📑 Kết quả"). Chỉ 32 nút vốn có đèn theo OSM đổi cách điều khiển; hình học nút giữ nguyên để so sánh công bằng.

- Không đèn (tự thương lượng): chỉ đường lớn hơn hẳn (chênh >= 2 cấp) được nhường, còn lại ai đến trước/bạo hơn đi trước; xe máy chấp nhận khe 2 s (nhỏ hơn khi hỗn loạn cao) và chen vào sau 8 s chờ, ô tô dè dặt (nhìn mọi xe xung đột, khe 3.5 s). Vẫn không có va chạm vật lý (xe chỉ vào nút khi luồng xung đột trống), có thể kẹt cứng.
- Vàng nhấp nháy: luật đường ưu tiên, đường nhỏ nhường đường lớn (khe 3 s), xe giảm tốc khi tới gần.
- Chỉ đèn nút lớn: đèn AI v2 ở nút có >= 3 nhánh cấp secondary trở lên thuộc >= 2 tuyến (10 nút), nút khác tắt đèn.
- Nhường mọi hướng (kiểu vòng xuyến, tuỳ chọn): mọi hướng nhường nhau, khe 2 s.
- Cấu hình tối ưu (lai): kết quả tìm kiếm bằng mô phỏng bên dưới; mỗi nút có thể ghi đè chế độ trong trình chỉnh sửa.
- Chỉ số an toàn: suýt va chạm (xe vào nút khi một xe xung đột đang chạy cách < 1.5 s), phanh gấp (> 4.5 m/s²), kẹt cứng nút (mọi hướng có xe đứng > 60 s, trong nút không ai chạy).
- Chưa làm: chế độ công an điều tiết bằng tay.

### Kết quả trên seed kiểm tra (1, 2, 3; không dùng khi tối ưu), 30 phút, hỗn loạn 0.6, cùng lịch va quẹt

## Giờ-xe mất (càng thấp càng tốt, in đậm = tốt nhất)

| Kịch bản | Cố định | Cảm biến | AI v2 | Không đèn | Chỉ nút lớn | Vàng nhấp nháy | Nhường mọi hướng | Tối ưu (lai) |
|---|---|---|---|---|---|---|---|---|
| Bình thường | 99.9 | 99.3 | 101.7 | **54.0** | 60.4 | 61.7 | 104.1 | 61.4 |
| Cao điểm sáng | 217.6 | 216.5 | 210.1 | 164.4 | **152.8** | 175.5 | 240.9 | 173.7 |
| Cao điểm chiều | 376.6 | 385.2 | 359.2 | 298.7 | 311.7 | 386.3 | 433.3 | **292.8** |
| Tắc cực đoan | 566.3 | 537.2 | 520.4 | 530.6 | **477.9** | 548.8 | 633.8 | 494.5 |
| Sự cố Xã Đàn | 176.0 | 165.7 | 137.6 | 118.7 | 132.4 | 145.0 | 180.1 | **110.2** |
| Mưa lớn | 299.5 | 282.6 | 266.7 | **234.9** | 239.2 | 286.8 | 319.9 | 270.1 |
| Sự kiện Gò Đống Đa | 109.1 | 96.7 | 91.9 | **62.1** | 75.3 | 80.3 | 106.6 | 72.4 |
| **Tổng 7 kịch bản** | 1845.0 | 1783.2 | 1687.7 | 1463.4 | 1449.8 | 1684.4 | 2018.7 | 1475.1 |

## An toàn và phụ (tổng 7 kịch bản, trung bình mỗi seed)

| Chỉ số | Cố định | Cảm biến | AI v2 | Không đèn | Chỉ nút lớn | Vàng nhấp nháy | Nhường mọi hướng | Tối ưu (lai) |
|---|---|---|---|---|---|---|---|---|
| Suýt va chạm (lần) | 15549 | 15070 | 15406 | 20318 | 16517 | 20751 | 18263 | 16670 |
| Phanh gấp (lần) | 212753 | 210965 | 215859 | 264722 | 250136 | 223893 | 221309 | 253171 |
| Kẹt cứng nút (lần) | 295.7 | 260.7 | 231.0 | 202.0 | 139.0 | 155.0 | 162.7 | 107.7 |
| Thời gian kẹt cứng (nút-giây) | 11557 | 12487 | 8773 | 10713 | 7423 | 8150 | 8017 | 9457 |
| Chuyến hoàn thành | 24558 | 24903 | 25238 | 25667 | 25964 | 24785 | 23835 | 25984 |
| Xung đột người đi bộ (mọi lượt) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Vi phạm an toàn tín hiệu (mọi lượt) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Trễ TB (s, TB 7 kịch bản) | 162.6 | 150.8 | 147.0 | 117.3 | 124.5 | 130.0 | 166.3 | 125.0 |
| Người đi bộ chờ TB (s) | 28.4 | 23.9 | 24.2 | 24.9 | 21.0 | 25.7 | 42.3 | 22.0 |
| Hàng chờ dài nhất TB (xe) | 40.1 | 35.9 | 40.4 | 32.0 | 31.9 | 47.7 | 39.4 | 34.1 |

### Logic tối ưu rút ra từ dữ liệu

Tìm trong 36 chính sách dễ hiểu (đèn AI v2 hoặc cảm biến ở nút có lưu lượng >= ngưỡng hoặc ở nút lớn, nút khác tắt đèn hoặc vàng nhấp nháy) trên seed huấn luyện 11, 12, 13 x cao điểm sáng, cao điểm chiều, sự cố. Mục tiêu: tổng giờ-xe mất + 0.01 x số lần suýt va chạm.

- Kết quả tìm kiếm: 10 nút đèn cảm biến, 22 nút tắt đèn (trên 32 nút vốn có đèn theo OSM).
- Nút giữ đèn: lưu lượng trung vị 1310 xe/h qua nút, 100% là nút lớn (>= 3 nhánh cấp secondary trở lên của >= 2 tuyến), trung vị 4 nhánh vào.
- Nút bỏ đèn: lưu lượng trung vị 647 xe/h, 0% là nút lớn, trung vị 3 nhánh vào.
- Ngưỡng đơn giản nhất tìm được: giữ đèn khi lưu lượng qua nút >= 1212 xe/h (khi chạy AI ở mọi nút) - khớp 75% lựa chọn của bộ tối ưu, nên đây chỉ là xu hướng, không phải luật tuyệt đối.
- Chính sách tốt nhất trên dữ liệu huấn luyện: đèn cảm biến ở nút lớn, nút khác tắt đèn (J = 1906; AI v2 ở mọi nút J = 2319, không đèn J = 1915, chỉ nút lớn J = 1934).
- 5 chính sách tiếp theo: tắt đèn ở mọi nút (J 1915); đèn AI v2 ở nút lớn, nút khác tắt đèn (J 1934); đèn cảm biến ở nút lớn, nút khác vàng nhấp nháy (J 1949); đèn AI v2 ở nút có lưu lượng >= 1212 xe/h, nút khác vàng nhấp nháy (J 1990); đèn AI v2 ở nút lớn, nút khác vàng nhấp nháy (J 2005).
- Đánh đổi an toàn (huấn luyện): suýt va chạm +10% so với AI v2 ở mọi nút, trong khi tắt đèn toàn bộ là +38% và vàng nhấp nháy toàn bộ +45%. Giữ đèn ở nút lớn giữ lại phần lớn lợi ích an toàn của đèn, bỏ đèn ở nút nhỏ lấy lại phần lớn lợi ích thời gian.
- Ở cùng cấu hình "chỉ nút lớn", đèn cảm biến tốt hơn AI v2 (J 1906 so với 1934), và tắt đèn hẳn ở nút nhỏ tốt hơn vàng nhấp nháy (vàng nhấp nháy bắt đường nhỏ chờ khe hở dài hơn).
- Độ tin cậy: so với AI v2 ở mọi nút, chính sách này lệch -65, -50, -26, -163, -16, -15, -45, -34, -21 giờ-xe trên từng lượt huấn luyện (độ lệch chuẩn 46). Tìm kiếm tham lam từng nút (results/optimize_greedy.log) cho thấy hiệu quả đổi một nút đơn lẻ nhỏ hơn nhiễu giữa các lượt chạy, nên luật được rút ra ở cấp chính sách đơn giản, không ở cấp từng nút.

Kiểm tra trên seed chưa thấy: cấu hình tối ưu (1475.1 giờ-xe) tốt hơn AI v2 ở mọi nút 12.6% và tốt hơn đèn cảm biến ở mọi nút 17.3%, nhưng **không** tốt hơn rõ "chỉ nút lớn (AI)" (1449.8) hay "không đèn" (1463.4); ba cấu hình này chênh nhau dưới 2%, nằm trong nhiễu giữa các lượt. Thứ hạng giữa chúng đổi theo kịch bản. Kết luận vững là ở cấp chính sách: bỏ đèn ở các nút nhỏ giảm mạnh giờ-xe mất, giữ đèn ở nút lớn giữ phần lớn an toàn (suýt va chạm +8% so với AI v2, so với +32% khi tắt đèn toàn bộ).

Lưu ý:

- Đây là kết quả của mô hình, chưa hiệu chỉnh bằng số đếm thực tế. Ở nút không đèn, mô hình cho xe vào nút chỉ khi các luồng xung đột đang trống (không có va chạm vật lý), nên nó có thể đánh giá khả năng thông qua của nút không đèn cao hơn thực tế; rủi ro an toàn được phản ánh qua số lần suýt va chạm và phanh gấp chứ không qua tai nạn thật.
- Mục tiêu tối ưu chỉ phạt nhẹ suýt va chạm (0.01 giờ-xe mỗi lần). Nếu coi an toàn quan trọng hơn, lời giải sẽ giữ nhiều đèn hơn: xem dòng "hệ số an toàn hoà vốn" bên dưới.
- Hệ số an toàn hoà vốn Không đèn so với AI v2: 164 giây trễ cho mỗi lần suýt va chạm. Nếu một lần suýt va chạm được coi là tệ hơn mức đó, AI v2 ở mọi nút thắng.
- Hệ số an toàn hoà vốn Tối ưu (lai) so với AI v2: 606 giây trễ cho mỗi lần suýt va chạm. Nếu một lần suýt va chạm được coi là tệ hơn mức đó, AI v2 ở mọi nút thắng.
- Hệ số an toàn hoà vốn Chỉ nút lớn so với AI v2: 771 giây trễ cho mỗi lần suýt va chạm. Nếu một lần suýt va chạm được coi là tệ hơn mức đó, AI v2 ở mọi nút thắng.

Kiểm tra chéo bằng SUMO (cao điểm sáng, seed 1-3; SUMO không có mô hình tự thương lượng kiểu Việt Nam, "tắt đèn" ở SUMO = đường nhỏ nhường đường lớn):

| SUMO mode | Trễ TB (s, chỉ xe đã ra) | Chuyến hoàn thành | Chờ vào mạng | Còn trong mạng |
|---|---|---|---|---|
| fixed | 145.1 | 2211 | 546 | 2154 |
| actuated | 106.4 | 2346 | 571 | 1993 |
| ai | 145.2 | 2278 | 631 | 2002 |
| nosignal | 121.5 | 1765 | 505 | 2641 |
| major | 129.4 | 2158 | 542 | 2210 |

SUMO **không** xác nhận kết quả "không đèn": tắt đèn toàn bộ làm số chuyến hoàn thành giảm mạnh (trễ TB thấp hơn chỉ vì chỉ tính xe đã ra). Đèn cảm biến tốt nhất trên SUMO; "chỉ nút lớn" đứng giữa. Vì vậy kết luận "bỏ đèn ở nút nhỏ" phụ thuộc vào mô hình hành vi ở nút không đèn và cần số liệu thực đo trước khi áp dụng.

Số liệu: `results/EXPERIMENTS.md`, `results/experiments.json`, `results/optimize.json`, `results/rules.json`. Chạy lại: `npx tsx scripts/optimize.ts && npx tsx scripts/derive_rules.ts && npx tsx scripts/experiments.ts`.

## Xe buýt theo tuyến và xe tải

**Xe buýt** chạy theo **tuyến thật**: 48 tuyến lấy từ các quan hệ OSM `route=bus` có trong tile OSM API đã lưu (`scripts/import_bus_lines.py` -> `public/data/bus_lines.json`). Overpass bị lỗi 504 nên không dùng được.
- Mỗi tuyến được khớp lên mạng đường của mô phỏng; chỉ giữ tuyến khớp ít nhất 75 % chiều dài. Tuyến không bao giờ đi vào ngõ. Tuyến bị cắt ở biên vùng thì đi tiếp theo đường ngắn nhất ra cửa gần nhất.
- Giãn cách lấy từ tag `interval` của OSM: giờ cao điểm dùng giá trị ngắn, giờ khác dùng giá trị dài. Tuyến không có tag thì dùng 15-20 phút và được đánh dấu là suy luận (`headwayInferred`). Mỗi chuyến lệch ±20 % so với lịch.
- **Khách** đến từng điểm dừng theo quá trình Poisson riêng cho từng tuyến. Mức đến là giả định: 30 khách/h sáng, 28 chiều, 14 trưa, vì không có số liệu đi xe công khai.
- Số khách xuống ở mỗi điểm theo phân phối nhị thức 14 %. Sức chứa 80.
- **Thời gian dừng** = 6 + max(2.0 s × khách lên, 1.4 s × khách xuống), nhân ngẫu nhiên 0.85-1.2.
- Lịch chạy và khách đến dùng luồng ngẫu nhiên riêng, mỗi xe buýt có luồng riêng. Vì vậy cùng seed thì giống hệt nhau ở mọi bộ điều khiển (có test kiểm tra).
- Hành vi:
  - Còn khoảng 70 m thì **tạt mạnh sang lề phải**, cắt qua dòng xe máy; xe phía sau phải phanh hoặc lách. Kiểm tra chống chồng lấn vẫn giữ, chỉ thu hẹp khoảng an toàn với xe phía sau.
  - Nếu lề bị chiếm (xe buýt khác, xe tải đỗ) thì **dừng giữa làn**.
  - Xe buýt đến sau xe buýt đang dừng thì mở cửa ngay ở vị trí thứ hai.
  - Xong thì **ép vào lại làn** trong 25 s.
  - Không có ai lên xuống thì đi qua điểm dừng.
  - **Khách vẫy dọc đường**: mỗi đoạn có xác suất 4 % (chỉnh được trên giao diện).
  - Điểm dừng được dời ra khỏi vạch đi bộ.
- Hiển thị: người chờ ở điểm dừng, người bước lên xe khi xe đang dừng, đèn xi-nhan khi tạt vào lề, cửa mở. Lớp **Tuyến buýt** vẽ các tuyến theo màu OSM.

**Xe tải** chia 4 loại, mỗi loại có kích thước, gia tốc và hàng hoá riêng: giao hàng 55 %, tải nặng 25 %, xe ben công trình 12 %, xe rác 8 %.
- Khoảng cách theo xe lớn hơn: T 1.6 s, s0 2.5 m.
- Không vào ngõ (có test kiểm tra).
- **GIẢ ĐỊNH**: giờ cao điểm sáng và chiều không cho xe tải nặng và xe ben vào nội đô, đổi thành xe giao hàng. Đây là quy định của Hà Nội đã được đơn giản hoá và có thể tắt.
- Xe giao hàng có xác suất 6 % mỗi đoạn **đỗ chiếm làn bốc dỡ 2-8 phút**, tối đa một lần mỗi chuyến. Xe rác dừng ngắn 20-60 s.
- Xe buýt và xe tải **rẽ rộng**: đang ở 60 % đầu của hướng rẽ thì các hướng khác cùng nhánh vào phải chờ, trừ xe máy lách được.

**Ưu tiên buýt (TSP)**: đây là tuỳ chọn cho AI v2. Khi bật, xe buýt được tính theo số khách (2.5 + 0.1 × khách PCU), và đèn xanh kéo dài tối đa thêm 15 s nếu xe buýt sắp tới vạch.

**So sánh nhanh** (engine TS, 30 phút, seed 1-3, trung bình mỗi lần chạy; `scripts/bus_compare.ts`, số liệu đầy đủ ở `results/BUS.md`):

| Biến thể | Giờ-xe mất sáng | Giờ-xe mất chiều | Buýt km/h sáng | Buýt km/h chiều | Khách chờ s (sáng / chiều) | Dồn chuyến % | Dừng giữa làn | Xe tải đỗ bốc dỡ |
|---|---|---|---|---|---|---|---|---|
| Cố định | 271.3 | 468.9 | 14.1 | 11.5 | 438 / 450 | 0.3 / 0.6 | 46 / 44 | 53 / 51 |
| Cảm biến | 252.8 | 415.3 | 14.8 | 12.6 | 438 / 438 | 0.1 / 0.3 | 46 / 53 | 54 / 53 |
| AI v2 | 253.7 | 399.4 | 14.5 | 12.6 | 425 / 436 | 0.0 / 0.2 | 49 / 53 | 47 / 63 |
| AI v2 + TSP | 265.8 | 435.2 | 15.0 | 11.8 | 429 / 431 | 0.0 / 0.6 | 51 / 50 | 46 / 49 |
| Chỉ nút lớn có đèn | 231.1 | 340.2 | 15.5 | 12.8 | 424 / 438 | 0.1 / 0.6 | 46 / 48 | 57 / 56 |
| Tối ưu | 226.1 | 331.5 | 14.9 | 13.1 | 434 / 439 | 0.0 / 0.2 | 51 / 52 | 54 / 67 |
| AI v2, đối chứng không buýt tuyến / không xe tải đỗ | 196.1 | 337.4 | - | - | 0 / 0 | 0.0 / 0.0 | 0 / 0 | 17 / 13 |

Nhận xét trung thực:
- Hành vi xe buýt và xe tải làm giờ-xe mất của AI v2 tăng khoảng 29 % buổi sáng (254 so với 196) và 18 % buổi chiều (399 so với 337) so với bản đối chứng.
- TSP **không** cho lợi ích rõ ràng với 3 seed:
  - Sáng: xe buýt nhanh hơn 0.5 km/h nhưng tổng giờ-xe mất tăng.
  - Chiều: cả hai đều xấu hơn.
  - Đây là chênh lệch nằm trong mức nhiễu, chưa kết luận được.
- Thứ hạng các chế độ đèn vẫn giữ: "tối ưu" và "chỉ nút lớn" tốt nhất trong engine TS. Lưu ý SUMO không xác nhận ưu thế của chế độ không đèn (xem phần trên).
- Dồn chuyến gần như bằng 0 trong 30 phút, vì một xe buýt chỉ đi qua vùng mất khoảng 10 phút. Muốn thấy dồn chuyến cần chạy dài hơn.
- Thời gian khách chờ khoảng 7 phút. Con số này chủ yếu do giãn cách giả định và theo từng tuyến (khách đợi đúng tuyến của mình).

## Benchmark (đo trên máy build: Intel Xeon, Node 24, dt = 0.5 s)

| Số xe trong mạng | ms/bước | bước/s | nhanh hơn thời gian thực |
|---|---|---|---|
| 1 000 | 1.58 | 635 | x318 |
| 3 000 | 3.44 | 291 | x146 |
| 5 000 | 5.15 | 194 | x97 |
| 10 000 | 9.04 | 111 | x55 |

Chậm hơn bản trước khoảng 1.5-3 lần vì mạng lớn hơn nhiều (thêm ngõ: 1 582 nút, 4 097 link), có người đi bộ, vùng dân cư, va quẹt và hỗn loạn. Ở 10 000 xe mạng lưới gần như kẹt cứng (đo hiệu năng, không phải kịch bản thực tế). Hiển thị: headless Chrome dùng SwiftShader (vẽ bằng CPU) đạt ~60 FPS với ~600 xe; chưa đo FPS ở 3k-10k xe trên GPU thật. Có chế độ nhẹ (`?quality=low`). Số liệu: `results/bench.json`.

Mô hình chưa hiệu chỉnh với số đếm xe thực tế; nhu cầu (xe/giờ) và tỉ lệ xe máy là giả định, kết quả chỉ có giá trị so sánh tương đối.

## Chạy local

```bash
npm ci
npm run dev            # http://localhost:5173/hanoi-flow-lab/
npm test               # vitest: định tuyến, an toàn tín hiệu, tái lập, không chồng xe, người đi bộ, xe đạp, ngõ, va quẹt, trình chỉnh sửa
npm run build
npx tsx scripts/compare.ts morning 30 1,2,3   # so sánh không giao diện
npx tsx scripts/bench.ts                      # benchmark engine

# Lấy lại dữ liệu OSM (Overpass, dự phòng OSM API 0.6)
python3 scripts/import_osm.py

# Backend SUMO
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt
python backend/build_net.py          # netconvert từ data/raw/dongda_roads.osm
python backend/server.py             # ws://localhost:8765/ws
# mở http://localhost:5173/hanoi-flow-lab/?backend=ws://localhost:8765/ws
python backend/compare_sumo.py morning 30 1,2,3
```

Tham số URL: `scenario`, `controller` (fixed/actuated/ai), `seed`, `demand`, `speed`, `layer=heat|density`, `night=1`, `quality=low`, `view=split`, `compare=1`, `cap` (giới hạn số xe), `chaos` (0-1), `crash=0` (tắt va quẹt), `crashRate` (lần/giờ), `editor=1`, `edits` (JSON), `results=1`, controller thêm `nosignal`, `major`, `flash`, `allway`, `optimal`, `backend`.

## Ảnh chụp

- `shots/bus-stop.png`: xe buýt tuyến 23 tạt vào lề đón khách, có người chờ và lớp tuyến buýt. `shots/truck-unload.png`: xe tải giao hàng đỗ chiếm làn bốc dỡ (thùng hàng trên vỉa hè, đèn khẩn cấp).

`shots/normal.png`, `shots/heatmap.png`, `shots/night.png`, `shots/split.png`, `shots/comparison.png`, `shots/inspect.png`, `shots/closeup.png` (cận cảnh hỗn loạn), `shots/pedestrians.png`, `shots/crash.png` (va quẹt), `shots/editor.png`, `shots/alleys.png` (ngõ), `shots/nosignal-gridlock.png` (không đèn, tắc cực đoan), `shots/optimal-map.png` (bản đồ chế độ từng nút), `shots/results.png` (trang kết quả).

## Giấy phép

Mã nguồn MIT. Dữ liệu bản đồ ODbL 1.0, © OpenStreetMap contributors.
