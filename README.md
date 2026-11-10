# HANOI FLOW LAB

Phòng thí nghiệm mô phỏng giao thông Hà Nội, chạy trên trình duyệt: bản đồ OpenStreetMap thật của một khu Đống Đa, xe máy lách làn (sublane), ô tô, xe buýt, xe tải, đèn tín hiệu với 3 bộ điều khiển (cố định, cảm biến, AI điều phối) và chế độ so sánh khoa học.

- Bản chạy thử: https://roccat92.github.io/hanoi-flow-lab/
- Khu vực: Ô Chợ Dừa - Xã Đàn - Tây Sơn - Thái Hà - Hoàng Cầu - Láng Hạ (bbox 21.004-21.024 N, 105.814-105.838 E)
- Dữ liệu bản đồ: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)

## Hai engine, cùng một giao diện

| Engine | Dùng khi | Độ trung thực |
|---|---|---|
| SUMO qua TraCI (`backend/server.py`) | chạy local, `?backend=ws://localhost:8765/ws` | engine chuẩn (SUMO sublane 0.8 m, không teleport) |
| TypeScript Web Worker (`src/engine`) | GitHub Pages (tĩnh, không có server) | thấp hơn SUMO, có ghi rõ trên giao diện |

Engine TS: IDM theo từng loại xe, mô hình làn phụ (xe máy chọn vị trí ngang để lách khe, ô tô đổi làn kiểu MOBIL rút gọn, xếp làn trước khi rẽ), xung đột trong nút tính bằng hình học quỹ đạo, giữ chỗ (reservation) khi xe cam kết đi qua nút, luật "không vào nút khi lối ra chưa có chỗ" (tràn ngược), ưu tiên theo cấp đường ở nút không đèn, định tuyến lại theo thời gian thực mỗi 60 s. Không teleport, không xoá xe: xe chưa vào được mạng thì xếp hàng chờ ở cửa vào và vẫn bị tính trễ.

Lưu ý khi chạy SUMO ở chế độ backend: lớp đèn tín hiệu và bảng kiểm tra nút/xe chưa nối với SUMO (chỉ có xe, số liệu và nhật ký quyết định AI).

## Bộ điều khiển đèn

- Cố định: chu kỳ 90 s, chia thời gian xanh theo số làn và cấp đường.
- Cảm biến (actuated): xanh tối thiểu, kéo dài khi còn xe tới trong 3 s, xanh tối đa 60 s, bỏ qua pha không có xe.
- AI điều phối: max-pressure có trọng số (PCU, xe buýt ưu tiên x3) + dự báo 12 s, gồm cả đoàn xe vừa được nút phía trên xả (phối hợp), trừ phần đường ra đã đầy, cộng thời gian chờ. Mỗi quyết định có lời giải thích sinh từ số liệu quan sát thật.
- Lớp an toàn dùng chung cho cả 3: không bao giờ có 2 luồng ưu tiên xung đột cùng xanh, vàng 3 s, đỏ toàn phần 2 s, xanh tối thiểu 8 s (dài hơn khi có người đi bộ chờ), xanh tối đa 90 s, chống bỏ đói (pha có nhu cầu bị đỏ quá 120 s thì bị ép chuyển).

## Kết quả so sánh đo thật (engine TS, 30 phút, trung bình seed 1, 2, 3)

Trễ trung bình mỗi chuyến đã hoàn thành (giây, càng thấp càng tốt) / số chuyến hoàn thành:

| Kịch bản | Cố định | Cảm biến | AI điều phối |
|---|---|---|---|
| Bình thường | 126.8 / 2866 | **82.5** / 2967 | 85.3 / 2965 |
| Cao điểm sáng | 194.2 / 3407 | **172.3** / 3658 | 175.1 / 3619 |
| Cao điểm chiều | 278.4 / 2782 | 266.2 / 2973 | **260.9** / 2982 |
| Tắc cực đoan | 281.5 / 4274 | 254.5 / 4246 | **243.7** / 4303 |
| Sự cố Xã Đàn | 161.1 / 3357 | **125.4** / 3560 | 127.9 / 3512 |
| Mưa lớn | 261.2 / 2811 | **215.9** / 3104 | 217.6 / 3063 |
| Sự kiện Gò Đống Đa | 108.4 / 2007 | 95.3 / 2022 | **85.2** / 2043 |

Đọc kết quả trung thực: AI và cảm biến đều tốt hơn rõ rệt so với đèn cố định, nhưng AI **không** thắng cảm biến ở mọi kịch bản; chênh lệch giữa hai bộ này chỉ vài phần trăm. 0 vi phạm an toàn tín hiệu ở mọi lần chạy. Số liệu đầy đủ: `results/compare_*.json` và `results/compare_*.log`. So sánh bằng SUMO: `results/sumo_compare_*.json`.

Mô hình chưa hiệu chỉnh với số đếm xe thực tế; nhu cầu (xe/giờ) và tỉ lệ xe máy là giả định, kết quả chỉ có giá trị so sánh tương đối.

## Chạy local

```bash
npm ci
npm run dev            # http://localhost:5173/hanoi-flow-lab/
npm test               # vitest: định tuyến, an toàn tín hiệu, tái lập, không chồng xe
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

Tham số URL: `scenario`, `controller` (fixed/actuated/ai), `seed`, `demand`, `speed`, `layer=heat|density`, `night=1`, `quality=low`, `view=split`, `compare=1`, `cap` (giới hạn số xe), `backend`.

## Ảnh chụp

`shots/normal.png`, `shots/heatmap.png`, `shots/night.png`, `shots/split.png`, `shots/comparison.png`, `shots/inspect.png`.

## Giấy phép

Mã nguồn MIT. Dữ liệu bản đồ ODbL 1.0, © OpenStreetMap contributors.
