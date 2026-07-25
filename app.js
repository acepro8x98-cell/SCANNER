/* ============================================================
   OMR SCANNER - app.js
   Quy trình: Camera -> OpenCV ->
   Tìm 4 ô vuông đen ở góc phiếu (ưu tiên) hoặc dò viền tờ giấy
   (dự phòng) -> Kiểm tra ổn định -> Warp Perspective ->
   Upload (base64) lên Google Apps Script -> Google Drive
   ============================================================ */

// ---------- Phần tử DOM ----------
const video       = document.getElementById('video');
const overlay     = document.getElementById('overlay');
const canvas      = document.getElementById('canvas');   // canvas xử lý (độ phân giải nhỏ)
const resultCanvas= document.getElementById('result');    // canvas ảnh sau khi duỗi thẳng
const statusEl    = document.getElementById('status');
const captureBtn  = document.getElementById('capture');
const autoBtn     = document.getElementById('autoToggle');
const previewBox  = document.getElementById('preview');
const previewImg  = document.getElementById('previewImg');
const uploadStatusEl = document.getElementById('uploadStatus');
const retakeBtn   = document.getElementById('retake');

const overlayCtx = overlay.getContext('2d');

// ---------- Cấu hình thuật toán ----------
const PROC_WIDTH        = 640;   // độ rộng ảnh xử lý (tăng lên để 4 ô vuông góc đủ lớn để nhận ra)
const PROCESS_INTERVAL  = 90;    // ms giữa các lần xử lý (~11 khung hình/giây)
const MIN_AREA_RATIO    = 0.10;  // phiếu phải chiếm tối thiểu 10% diện tích khung hình
const ASPECT_TARGETS    = [210/297, 297/210]; // A4 dọc và ngang
const ASPECT_TOLERANCE  = 0.22;
const STABLE_WINDOW_MS  = 600;   // thời gian phải đứng yên trước khi tự chụp
const STABLE_PIXEL_TOL  = 8;     // sai lệch tối đa (px, ở độ phân giải xử lý) giữa các khung
const CAPTURE_COOLDOWN  = 2500;  // ms khoá lại sau khi vừa chụp, tránh chụp liên tục
const OUT_W = 1240, OUT_H = 1754; // kích thước ảnh xuất ra (~A4 150dpi)

// Cấu hình riêng cho nhận diện 4 Ô VUÔNG ĐEN Ở GÓC (marker) - phương pháp chính
// Phiếu trả lời có in sẵn 4 ô vuông đen nhỏ ở 4 góc để căn chỉnh, đáng tin cậy
// hơn nhiều so với việc dò viền cả tờ giấy (không bị ảnh hưởng bởi nền phía sau).
const MARKER_MIN_SIDE_RATIO = 0.010; // cạnh ô vuông tối thiểu, tính theo % chiều rộng ảnh xử lý
const MARKER_MAX_SIDE_RATIO = 0.10;  // cạnh ô vuông tối đa
const MARKER_ASPECT_MIN     = 0.55;  // ô vuông thật sẽ có tỉ lệ cạnh gần 1:1
const MARKER_ASPECT_MAX     = 1.8;
const MARKER_MIN_EXTENT     = 0.80;  // độ "đặc" của khối - phân biệt ô vuông đặc với vòng tròn/chữ

// ---------- Biến trạng thái ----------
let cvReady = false;
let procCanvas = document.createElement('canvas');
let procCtx = procCanvas.getContext('2d');
let lastQuadProc = null;     // góc phiếu mới nhất (toạ độ hệ xử lý)
let history = [];            // lịch sử {t, pts} để kiểm tra ổn định
let autoCaptureEnabled = true;
let lockedUntil = 0;         // thời điểm hết khoá sau khi chụp
let loopTimer = null;
let isBusy = false;
let lastMarkerDebug = { candidates: [] }; // để hiển thị debug: các ô vuông đang "nhìn thấy"

// ============================================================
// BƯỚC 1-3: MỞ CAMERA
// ============================================================
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    resizeCanvases();
    window.addEventListener('resize', resizeCanvases);
    setStatus('Đang tải công cụ xử lý ảnh (opencv.js)... 0s');
    waitForOpenCV();
  } catch (err) {
    setStatus('Không mở được camera: ' + err.message);
  }
}

function resizeCanvases() {
  overlay.width  = window.innerWidth;
  overlay.height = window.innerHeight;

  const scale = PROC_WIDTH / video.videoWidth;
  procCanvas.width  = PROC_WIDTH;
  procCanvas.height = Math.round(video.videoHeight * scale);
}

// ============================================================
// Chờ OpenCV.js tải xong (script async trong index.html)
// ============================================================
let openCvWaitMs = 0;
let openCvInitStarted = false;

function waitForOpenCV() {
  if (typeof window.cv === 'undefined') {
    pollAgain();
    return;
  }

  // Bản build "MODULARIZE" (như @techstark/opencv-js): window.cv là một PROMISE
  // (không phải object dùng ngay được) — phải .then() để lấy công cụ OpenCV thật.
  if (window.cv instanceof Promise) {
    if (!openCvInitStarted) {
      openCvInitStarted = true;
      window.cv.then((resolvedCv) => {
        window.cv = resolvedCv; // ghi đè lại biến cv để phần code còn lại dùng bình thường
        onOpenCVReady();
      }).catch((err) => {
        setStatus('⚠ Lỗi khởi tạo opencv.js: ' + err.message, false);
        console.error('opencv init error:', err);
      });
    }
    return; // đang chờ Promise ở trên resolve, không cần poll thêm
  }

  // Bản build "thường" (docs.opencv.org gốc): cv là object có sẵn thuộc tính
  if (cv.Mat) {
    onOpenCVReady();
  } else if (!openCvInitStarted) {
    openCvInitStarted = true;
    cv.onRuntimeInitialized = onOpenCVReady;
  }
}

function pollAgain() {
  openCvWaitMs += 200;
  setStatus(`Đang tải công cụ xử lý ảnh (opencv.js)... ${Math.round(openCvWaitMs / 1000)}s`);
  if (openCvWaitMs > 25000) {
    setStatus('⚠ Không tải được opencv.js sau 25s (kiểm tra lại mạng / file trên GitHub)', false);
    return; // ngừng thử lại, tránh vòng lặp vô tận âm thầm
  }
  setTimeout(waitForOpenCV, 200);
}

function onOpenCVReady() {
  cvReady = true;
  setStatus('Đưa phiếu vào khung hình');
  loopTimer = setInterval(processFrame, PROCESS_INTERVAL);
}

// ============================================================
// BƯỚC 6, 11-19: XỬ LÝ TỪNG KHUNG HÌNH
// Gray -> Blur -> Canny -> FindContours -> Polygon 4 góc -> Kiểm tra tỉ lệ
// ============================================================
function processFrame() {
  if (!cvReady || isBusy || video.readyState < 2) return;
  if (Date.now() < lockedUntil) return; // đang trong thời gian khoá sau khi chụp

  procCtx.drawImage(video, 0, 0, procCanvas.width, procCanvas.height);

  const frameArea = procCanvas.width * procCanvas.height;
  let src, gray, blurred, edge, dilated, contours, hierarchy;
  try {
    src = cv.imread(procCanvas);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // CÁCH 1 (ưu tiên): tìm 4 ô vuông đen in sẵn ở góc phiếu
    let quad = findMarkerQuad(gray, frameArea);

    // CÁCH 2 (dự phòng): nếu không thấy đủ 4 ô vuông, quay lại dò viền cả tờ giấy
    if (!quad) {
      blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

      edge = new cv.Mat();
      cv.Canny(blurred, edge, 60, 180);

      // Giãn nhẹ để nối các đoạn cạnh bị đứt
      dilated = new cv.Mat();
      const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(edge, dilated, kernel);
      kernel.delete();

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      quad = findBestQuad(contours, frameArea);
    }

    if (quad) {
      lastQuadProc = quad;
      drawOverlay(quad, true);
      trackStability(quad);
    } else {
      lastQuadProc = null;
      drawOverlay(null, false); // vẫn vẽ các chấm vàng debug (ô vuông đã thấy nhưng chưa đủ 4)
      history = [];
      const n = lastMarkerDebug.candidates.length;
      setStatus(`Đưa phiếu vào khung hình (thấy ${n} ô vuông)`, false);
    }
  } catch (err) {
    // QUAN TRỌNG: hiện lỗi thật ra màn hình thay vì để lỗi ẩn trong console
    // (nếu không có dòng này, khi có lỗi JS thì trạng thái sẽ bị "đứng hình" mãi mãi)
    setStatus('⚠ Lỗi xử lý: ' + err.message, false);
    console.error('processFrame error:', err);
  } finally {
    // Giải phóng bộ nhớ OpenCV (bắt buộc, tránh rò rỉ)
    [src, gray, blurred, edge, dilated, contours, hierarchy].forEach(m => m && m.delete && m.delete());
  }
}

// ============================================================
// PHƯƠNG PHÁP CHÍNH: tìm 4 ô vuông đen in sẵn ở góc phiếu
// (đáng tin cậy hơn dò viền giấy vì tương phản đen/trắng rất mạnh,
// không bị ảnh hưởng bởi hoa văn của mặt bàn/sàn nhà phía sau phiếu)
// ============================================================
function findMarkerQuad(gray, frameArea) {
  let bin, contours, hierarchy;
  try {
    // Nhị phân hoá ảnh: vùng tối (chữ, ô vuông đen) -> trắng, còn lại -> đen
    bin = new cv.Mat();
    cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(bin, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const w = gray.cols;
    const minSide = w * MARKER_MIN_SIDE_RATIO;
    const maxSide = w * MARKER_MAX_SIDE_RATIO;

    const candidates = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const rect = cv.boundingRect(cnt);
      const area = cv.contourArea(cnt);
      const boxArea = rect.width * rect.height;

      if (rect.width >= minSide && rect.width <= maxSide &&
          rect.height >= minSide && rect.height <= maxSide && boxArea > 0) {
        const aspect = rect.width / rect.height;
        const extent = area / boxArea; // độ "đặc": ô vuông tô đen đặc ~1.0, vòng tròn/chữ thấp hơn
        if (aspect >= MARKER_ASPECT_MIN && aspect <= MARKER_ASPECT_MAX && extent >= MARKER_MIN_EXTENT) {
          candidates.push({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            size: (rect.width + rect.height) / 2
          });
        }
      }
      cnt.delete();
    }

    if (candidates.length < 4) {
      lastMarkerDebug.candidates = candidates;
      return null;
    }

    // Loại bỏ nhiễu: chỉ giữ các khối có kích thước gần với kích thước phổ biến nhất
    const sizes = candidates.map(c => c.size).sort((a, b) => a - b);
    const medianSize = sizes[Math.floor(sizes.length / 2)];
    const filtered = candidates.filter(c => c.size > medianSize * 0.4 && c.size < medianSize * 2.5);
    const pool = filtered.length >= 4 ? filtered : candidates;
    lastMarkerDebug.candidates = pool;

    // 4 ô vuông góc luôn là các điểm CỰC TRỊ (trên-trái, trên-phải, dưới-phải, dưới-trái)
    const ordered = orderPoints(pool);

    // Kiểm tra lại: diện tích đủ lớn + tỉ lệ khung gần A4 (loại các trường hợp trùng khớp ngẫu nhiên)
    if (polygonArea(ordered) < frameArea * MIN_AREA_RATIO) return null;
    if (!aspectRatioOk(ordered)) return null;

    return ordered;
  } finally {
    [bin, contours, hierarchy].forEach(m => m && m.delete && m.delete());
  }
}

function polygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(area / 2);
}

// BƯỚC 16-18: chọn contour lớn nhất, xấp xỉ 4 góc, kiểm tra diện tích + tỉ lệ
function findBestQuad(contours, frameArea) {
  let best = null;
  let bestArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);

    if (area > bestArea && area > frameArea * MIN_AREA_RATIO) {
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const pts = matToPoints(approx);
        const ordered = orderPoints(pts);
        if (aspectRatioOk(ordered)) {
          bestArea = area;
          best = ordered;
        }
      }
      approx.delete();
    }
    cnt.delete();
  }
  return best;
}

function matToPoints(mat) {
  const data = mat.data32S;
  const pts = [];
  for (let i = 0; i < data.length; i += 2) {
    pts.push({ x: data[i], y: data[i + 1] });
  }
  return pts;
}

// Sắp xếp 4 điểm theo thứ tự: trên-trái, trên-phải, dưới-phải, dưới-trái
function orderPoints(pts) {
  const sum = pts.map(p => p.x + p.y);
  const diff = pts.map(p => p.y - p.x);
  const tl = pts[sum.indexOf(Math.min(...sum))];
  const br = pts[sum.indexOf(Math.max(...sum))];
  const tr = pts[diff.indexOf(Math.min(...diff))];
  const bl = pts[diff.indexOf(Math.max(...diff))];
  return [tl, tr, br, bl];
}

// BƯỚC 18: kiểm tra tỉ lệ khung gần với A4 (0.707) ở cả 2 chiều
function aspectRatioOk([tl, tr, br, bl]) {
  const widthTop    = dist(tl, tr);
  const widthBottom  = dist(bl, br);
  const heightLeft   = dist(tl, bl);
  const heightRight  = dist(tr, br);
  const w = (widthTop + widthBottom) / 2;
  const h = (heightLeft + heightRight) / 2;
  if (w < 10 || h < 10) return false;
  const ratio = w / h;
  return ASPECT_TARGETS.some(t => Math.abs(ratio - t) < t * ASPECT_TOLERANCE);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ============================================================
// BƯỚC 19: VẼ KHUNG XANH LÊN OVERLAY (đổi toạ độ proc -> hiển thị)
// ============================================================
function drawOverlay(quadProc, locked) {
  clearOverlay();

  // Vẽ chấm VÀNG debug tại các ô vuông ứng viên đã tìm thấy (để biết thuật toán đang "nhìn" thấy gì)
  lastMarkerDebug.candidates.forEach(c => {
    const p = procToOverlay(c);
    overlayCtx.beginPath();
    overlayCtx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    overlayCtx.strokeStyle = '#facc15';
    overlayCtx.lineWidth = 3;
    overlayCtx.stroke();
  });

  if (!quadProc) return;

  const pts = quadProc.map(p => procToOverlay(p));

  overlayCtx.beginPath();
  overlayCtx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) overlayCtx.lineTo(pts[i].x, pts[i].y);
  overlayCtx.closePath();
  overlayCtx.strokeStyle = '#22c55e';
  overlayCtx.lineWidth = 4;
  overlayCtx.stroke();

  pts.forEach(p => {
    overlayCtx.beginPath();
    overlayCtx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    overlayCtx.fillStyle = '#22c55e';
    overlayCtx.fill();
  });
}

function clearOverlay() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
}

// Video hiển thị bằng object-fit:cover -> phải quy đổi toạ độ đúng cách
function procToOverlay(p) {
  const scaleProcToVideo = video.videoWidth / procCanvas.width;
  const videoX = p.x * scaleProcToVideo;
  const videoY = p.y * scaleProcToVideo;

  const coverScale = Math.max(overlay.width / video.videoWidth, overlay.height / video.videoHeight);
  const offsetX = (overlay.width  - video.videoWidth  * coverScale) / 2;
  const offsetY = (overlay.height - video.videoHeight * coverScale) / 2;

  return {
    x: videoX * coverScale + offsetX,
    y: videoY * coverScale + offsetY
  };
}

// ============================================================
// BƯỚC 20: KIỂM TRA ĐỘ ỔN ĐỊNH (chống rung tay)
// ============================================================
function trackStability(quad) {
  const now = Date.now();
  history.push({ t: now, pts: quad });
  history = history.filter(h => now - h.t <= STABLE_WINDOW_MS);

  if (history.length < 3) {
    setStatus('Đang căn chỉnh...', false);
    return;
  }

  const first = history[0].pts;
  const last = history[history.length - 1].pts;
  const maxMove = Math.max(...first.map((p, i) => dist(p, last[i])));
  const longEnough = (last === history[history.length-1].pts) && (now - history[0].t >= STABLE_WINDOW_MS * 0.8);

  if (maxMove <= STABLE_PIXEL_TOL && longEnough) {
    setStatus('✔ Đã ổn định', true);
    if (autoCaptureEnabled && Date.now() >= lockedUntil) {
      triggerCapture();
    }
  } else {
    setStatus('Giữ yên máy...', false);
  }
}

function setStatus(text, locked) {
  statusEl.textContent = text;
  statusEl.classList.toggle('locked', !!locked);
}

// ============================================================
// BƯỚC 5-onward: CHỤP + WARP PERSPECTIVE (duỗi thẳng phiếu)
// ============================================================
function triggerCapture() {
  if (isBusy) return;
  if (!lastQuadProc) {
    alert('Chưa nhận diện được phiếu. Hãy đưa phiếu vào giữa khung hình.');
    return;
  }
  isBusy = true;
  lockedUntil = Date.now() + CAPTURE_COOLDOWN;

  // Chụp ở ĐỘ PHÂN GIẢI GỐC của camera để ảnh nét, không dùng canvas nhỏ đã xử lý
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = video.videoWidth;
  fullCanvas.height = video.videoHeight;
  fullCanvas.getContext('2d').drawImage(video, 0, 0);

  // Quy đổi 4 góc từ toạ độ xử lý (proc) sang toạ độ độ phân giải gốc
  const scaleProcToVideo = video.videoWidth / procCanvas.width;
  const quadFull = lastQuadProc.map(p => ({ x: p.x * scaleProcToVideo, y: p.y * scaleProcToVideo }));

  warpAndShow(fullCanvas, quadFull);
}

function warpAndShow(fullCanvas, quadFull) {
  let src, dst, M, srcTri, dstTri;
  try {
    src = cv.imread(fullCanvas);
    dst = new cv.Mat();

    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      quadFull[0].x, quadFull[0].y,
      quadFull[1].x, quadFull[1].y,
      quadFull[2].x, quadFull[2].y,
      quadFull[3].x, quadFull[3].y
    ]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,  OUT_W, 0,  OUT_W, OUT_H,  0, OUT_H
    ]);

    M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(src, dst, M, new cv.Size(OUT_W, OUT_H));

    resultCanvas.width = OUT_W;
    resultCanvas.height = OUT_H;
    cv.imshow(resultCanvas, dst);

    // Kiểm tra ngay khối Số báo danh trên ảnh vừa duỗi thẳng
    const ctx2d = resultCanvas.getContext('2d');
    const sbdCheck = checkSBDGrid(ctx2d, OUT_W, OUT_H);

    showPreviewAndUpload(sbdCheck);
  } finally {
    [src, dst, M, srcTri, dstTri].forEach(m => m && m.delete && m.delete());
    isBusy = false;
  }
}

// Một số trình duyệt (đặc biệt trên điện thoại) chặn phát âm thanh
// cho tới khi có cử chỉ chạm đầu tiên của người dùng -> "mở khoá" ở đây
function unlockAudioOnce() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  document.removeEventListener('touchstart', unlockAudioOnce);
  document.removeEventListener('click', unlockAudioOnce);
}
document.addEventListener('touchstart', unlockAudioOnce, { once: true });
document.addEventListener('click', unlockAudioOnce, { once: true });

// Nút chụp thủ công
captureBtn.addEventListener('click', () => {
  if (lastQuadProc) {
    triggerCapture();
  } else {
    // Không có khung nhận diện -> vẫn cho chụp nguyên khung hình để người dùng tự xử lý
    alert('Chưa thấy phiếu rõ nét. Hãy chỉnh lại góc chụp rồi thử lại.');
  }
});

autoBtn.addEventListener('click', () => {
  autoCaptureEnabled = !autoCaptureEnabled;
  autoBtn.textContent = 'Tự động: ' + (autoCaptureEnabled ? 'BẬT' : 'TẮT');
});

retakeBtn.addEventListener('click', () => {
  previewBox.classList.add('hidden');
  history = [];
  lockedUntil = 0;
  setStatus('Đưa phiếu vào khung hình', false);
});

// ============================================================
// ÂM THANH PHẢN HỒI (giống máy quét mã vạch siêu thị)
// ============================================================
let audioCtx = null;

function playBeep(freq = 1200, durationMs = 120) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = 0.25; // âm lượng vừa phải, tránh giật mình
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs / 1000);
  } catch (err) {
    console.warn('Không phát được âm thanh:', err.message);
  }
}

// "Tít" 1 tiếng ngắn, cao -> quét/lưu THÀNH CÔNG
function feedbackSuccess() {
  playBeep(1400, 100);
  if (navigator.vibrate) navigator.vibrate(60); // rung nhẹ 1 lần
}

// "Tè tè" 2 tiếng liên tiếp, trầm hơn -> CẢNH BÁO cần dừng kiểm tra
function feedbackWarning() {
  playBeep(500, 150);
  setTimeout(() => playBeep(500, 150), 200);
  if (navigator.vibrate) navigator.vibrate([120, 80, 120]); // rung 2 nhịp dài
}

// ============================================================
// TOẠ ĐỘ CÁC Ô TRÒN TRÊN PHIẾU (đo từ file mẫu 132.docx, tính theo
// tỉ lệ % so với khung ảnh đã duỗi thẳng - khớp với 4 marker góc,
// nên áp dụng đúng cho MỌI kích thước OUT_W/OUT_H)
// ============================================================
const OMR_TEMPLATE = {
  // Số báo danh: 6 cột (mỗi cột 1 chữ số), 10 hàng (chữ số 0-9)
  sbd: {
    cols: [0.69048, 0.71998, 0.75000, 0.77981, 0.80962, 0.83944],
    rows: [0.05652, 0.07628, 0.09605, 0.11581, 0.13551, 0.15541, 0.17538, 0.19515, 0.21491, 0.23471]
  },
  // Mã đề: 3 cột, 10 hàng (dùng chung hàng với Số báo danh)
  made: {
    cols: [0.91768, 0.94749, 0.97720],
    rows: [0.05652, 0.07628, 0.09605, 0.11581, 0.13551, 0.15541, 0.17538, 0.19515, 0.21491, 0.23471]
  },
  // Phần I trắc nghiệm: 4 cột (A/B/C/D), 20 hàng (câu 1-20)
  phan1: {
    cols: [0.06841, 0.11872, 0.16904, 0.21925],
    rows: [0.30874, 0.32968, 0.35069, 0.37184, 0.39300, 0.41401, 0.43495, 0.45596, 0.47691, 0.49792,
           0.54362, 0.56456, 0.58571, 0.60693, 0.62788, 0.64889, 0.66990, 0.69092, 0.71179, 0.73280]
  },
  bubbleRadiusFrac: 0.007, // bán kính lấy mẫu (tính theo % chiều rộng OUT_W), nhỏ hơn ô thật để không dính viền
  fillThreshold: 90        // độ tối trung bình (0=trắng, 255=đen) để coi là "đã tô"
};

// Đo độ tối trung bình của một vùng nhỏ quanh tâm ô tròn (0 = trắng, 255 = đen tuyệt đối)
function sampleBubbleDarkness(ctx, cx, cy, radius) {
  const size = radius * 2;
  const x0 = Math.max(0, Math.round(cx - radius));
  const y0 = Math.max(0, Math.round(cy - radius));
  const imgData = ctx.getImageData(x0, y0, size, size);
  let sum = 0, count = 0;
  for (let i = 0; i < imgData.data.length; i += 4) {
    const gray = (imgData.data[i] + imgData.data[i + 1] + imgData.data[i + 2]) / 3;
    sum += (255 - gray);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

// Đọc độ tối của toàn bộ 1 khối lưới (vd: sbd, made, phan1)
// Trả về mảng 2 chiều: darkness[colIndex][rowIndex]
function readGridDarkness(ctx, gridDef, outW, outH) {
  const radius = Math.max(3, Math.round(outW * OMR_TEMPLATE.bubbleRadiusFrac));
  const darkness = [];
  for (const fx of gridDef.cols) {
    const colVals = [];
    const px = fx * outW;
    for (const fy of gridDef.rows) {
      const py = fy * outH;
      colVals.push(sampleBubbleDarkness(ctx, px, py, radius));
    }
    darkness.push(colVals);
  }
  return darkness;
}

// Kiểm tra khối Số báo danh: mỗi cột (6 cột) phải có ĐÚNG 1 ô được tô.
// Trả về { ok: boolean, sbdString: string|null, errorCols: number[] }
function checkSBDGrid(ctx, outW, outH) {
  const darkness = readGridDarkness(ctx, OMR_TEMPLATE.sbd, outW, outH);
  const errorCols = [];
  let sbdDigits = [];

  darkness.forEach((colVals, colIdx) => {
    const filledRows = [];
    colVals.forEach((d, rowIdx) => {
      if (d >= OMR_TEMPLATE.fillThreshold) filledRows.push(rowIdx);
    });
    if (filledRows.length !== 1) {
      errorCols.push(colIdx + 1); // lưu số thứ tự cột (1-6) cho dễ đọc thông báo
      sbdDigits.push('?');
    } else {
      sbdDigits.push(String(filledRows[0])); // filledRows[0] chính là chữ số 0-9
    }
  });

  return {
    ok: errorCols.length === 0,
    sbdString: sbdDigits.join(''),
    errorCols,
    darkness
  };
}

// ============================================================
// DEBUG: vẽ chấm màu tại từng điểm lấy mẫu để kiểm tra toạ độ có
// đúng tâm ô tròn không (chỉ hiển thị trên preview, KHÔNG upload)
// Bật/tắt bằng biến DEBUG_OMR bên dưới.
// ============================================================
const DEBUG_OMR = true;

function drawDebugOverlay(sourceCanvas, gridDef, outW, outH, darkness) {
  const debugCanvas = document.createElement('canvas');
  debugCanvas.width = outW;
  debugCanvas.height = outH;
  const dctx = debugCanvas.getContext('2d');
  dctx.drawImage(sourceCanvas, 0, 0);

  const radius = Math.max(3, Math.round(outW * OMR_TEMPLATE.bubbleRadiusFrac));

  gridDef.cols.forEach((fx, colIdx) => {
    const px = fx * outW;
    gridDef.rows.forEach((fy, rowIdx) => {
      const py = fy * outH;
      const d = darkness[colIdx][rowIdx];
      const filled = d >= OMR_TEMPLATE.fillThreshold;
      dctx.beginPath();
      dctx.arc(px, py, radius, 0, Math.PI * 2);
      dctx.strokeStyle = filled ? '#00ff00' : '#ff0000';
      dctx.lineWidth = 2;
      dctx.stroke();
      // Ghi giá trị độ đậm (0-255) nhỏ bên cạnh để đọc số cụ thể
      dctx.fillStyle = filled ? '#00ff00' : '#ff0000';
      dctx.font = '9px sans-serif';
      dctx.fillText(Math.round(d), px + radius + 1, py + 3);
    });
  });

  return debugCanvas;
}


function showPreviewAndUpload(sbdCheck) {
  const dataUrl = resultCanvas.toDataURL('image/jpeg', 0.92); // ảnh SẠCH để upload
  previewBox.classList.remove('hidden');

  if (DEBUG_OMR && sbdCheck && sbdCheck.darkness) {
    // Hiển thị bản có chấm debug (không ảnh hưởng ảnh upload lên Drive)
    const debugCanvas = drawDebugOverlay(resultCanvas, OMR_TEMPLATE.sbd, OUT_W, OUT_H, sbdCheck.darkness);
    previewImg.src = debugCanvas.toDataURL('image/jpeg', 0.92);
  } else {
    previewImg.src = dataUrl;
  }

  if (sbdCheck && !sbdCheck.ok) {
    // Số báo danh tô sai (thiếu hoặc thừa ô trong 1 cột nào đó) -> cảnh báo ngay,
    // không chờ upload xong, để người dùng dừng lại kiểm tra ngay lập tức
    uploadStatusEl.textContent =
      '⚠ Số báo danh tô sai ở cột: ' + sbdCheck.errorCols.join(', ') +
      ' (mỗi cột phải tô đúng 1 ô) — Đang tải lên...';
    uploadStatusEl.className = 'upload-status error';
    feedbackWarning(); // "Tè tè" + rung cảnh báo
  } else {
    uploadStatusEl.textContent = 'Đang tải lên Google Drive...';
    uploadStatusEl.className = 'upload-status';
  }

  uploadToDrive(dataUrl, sbdCheck);
}

async function uploadToDrive(dataUrl, sbdCheck) {
  const base64 = dataUrl.split(',')[1];
  const filename = 'phieu_' + new Date().toISOString().replace(/[:.]/g, '-') + '.jpg';
  const sbdError = sbdCheck && !sbdCheck.ok;

  try {
    const res = await fetch(WEBAPP_URL, {
      method: 'POST',
      // Dùng text/plain để tránh trình duyệt gửi preflight OPTIONS
      // (Apps Script Web App không xử lý OPTIONS mặc định)
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ filename, mimeType: 'image/jpeg', data: base64 })
    });

    const result = await res.json();
    if (result && result.success) {
      if (sbdError) {
        // Vẫn lưu ảnh (không mất dữ liệu), nhưng GIỮ màn hình preview để
        // người dùng biết mà kiểm tra lại phiếu này -> không tự động chuyển bài
        uploadStatusEl.textContent =
          '⚠ Đã lưu ảnh, nhưng Số báo danh lỗi ở cột: ' + sbdCheck.errorCols.join(', ') +
          '. Hãy kiểm tra lại phiếu giấy rồi bấm "Chụp lại" nếu cần.';
        uploadStatusEl.className = 'upload-status error';
        return; // dừng ở đây, không auto-advance
      }

      uploadStatusEl.textContent = '✔ Đã lưu vào Google Drive';
      uploadStatusEl.className = 'upload-status success';
      feedbackSuccess(); // "Tít" + rung nhẹ báo thành công

      // Tự động quay lại chế độ quét ngay sau khi lưu thành công,
      // để chụp phiếu tiếp theo mà không cần bấm "Chụp lại"
      setTimeout(() => {
        previewBox.classList.add('hidden');
        history = [];
        lockedUntil = 0;
        setStatus('Đưa phiếu vào khung hình', false);
      }, 400); // để 0.4s cho kịp thấy dấu ✔ rồi quay lại ngay
    } else {
      throw new Error((result && result.error) || 'Không rõ lỗi');
    }
  } catch (err) {
    uploadStatusEl.textContent = '✖ Lỗi tải lên: ' + err.message;
    uploadStatusEl.className = 'upload-status error';
  }
}

// ---------- Khởi động ----------
startCamera();
