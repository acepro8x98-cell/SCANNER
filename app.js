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
const PROCESS_INTERVAL  = 70;    // ms giữa các lần xử lý (~14 khung hình/giây, tăng từ 90ms để phản hồi nhanh hơn)
const MIN_AREA_RATIO    = 0.10;  // phiếu phải chiếm tối thiểu 10% diện tích khung hình
const ASPECT_TARGETS    = [210/297, 297/210]; // A4 dọc và ngang
const ASPECT_TOLERANCE  = 0.22;
const STABLE_WINDOW_MS  = 350;   // thời gian phải đứng yên trước khi tự chụp (giảm từ 600ms để chụp nhanh hơn)
const STABLE_PIXEL_TOL  = 14;    // sai lệch tối đa (px) giữa các khung (tăng từ 8 để chịu được tay rung nhẹ)
const CAPTURE_COOLDOWN  = 2500;  // ms khoá lại sau khi vừa chụp, tránh chụp liên tục
const OUT_W = 1240, OUT_H = 1754; // kích thước ảnh xuất ra (~A4 150dpi)

// Cấu hình riêng cho nhận diện 4 Ô VUÔNG ĐEN Ở GÓC (marker) - phương pháp chính
// Phiếu trả lời có in sẵn 4 ô vuông đen nhỏ ở 4 góc để căn chỉnh, đáng tin cậy
// hơn nhiều so với việc dò viền cả tờ giấy (không bị ảnh hưởng bởi nền phía sau).
const MARKER_MIN_SIDE_RATIO = 0.010; // cạnh ô vuông tối thiểu, tính theo % chiều rộng ảnh xử lý
const MARKER_MAX_SIDE_RATIO = 0.10;  // cạnh ô vuông tối đa
const MARKER_ASPECT_MIN     = 0.50;  // ô vuông thật sẽ có tỉ lệ cạnh gần 1:1 (nới ra để chịu mờ/nghiêng nhẹ)
const MARKER_ASPECT_MAX     = 2.0;
const MARKER_MIN_EXTENT     = 0.70;  // độ "đặc" của khối (giảm từ 0.80 để chịu ảnh hơi mờ làm mòn viền)

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

// SBD đã quét THÀNH CÔNG trong phiên làm việc này (mất khi tải lại trang).
// Dùng để cảnh báo ngay lúc quét nếu 2 phiếu khác nhau lại ra cùng 1 SBD
// (khả năng cao là 1 trong 2 học sinh tô nhầm số báo danh).
const scannedSBDs = new Set();

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
  let bin, smoothed, contours, hierarchy;
  try {
    // Làm mượt nhẹ trước khi nhị phân hoá: giúp thuật toán chịu được ảnh hơi
    // rung/mờ (motion blur nhẹ, nhiễu hạt do thiếu sáng) mà vẫn giữ được cạnh
    // ô vuông rõ ràng (median blur giữ cạnh tốt hơn Gaussian thông thường)
    smoothed = new cv.Mat();
    cv.medianBlur(gray, smoothed, 3);

    // Nhị phân hoá ảnh: vùng tối (chữ, ô vuông đen) -> trắng, còn lại -> đen
    bin = new cv.Mat();
    cv.threshold(smoothed, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

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
    [bin, smoothed, contours, hierarchy].forEach(m => m && m.delete && m.delete());
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

    // Kiểm tra ngay các khối Số báo danh / Mã Đề / Phần I trên ảnh vừa duỗi thẳng
    const ctx2d = resultCanvas.getContext('2d');
    const sbdCheck = checkSBDGrid(ctx2d, OUT_W, OUT_H);
    const madeCheck = checkMadeGrid(ctx2d, OUT_W, OUT_H);
    const phan1Check = checkPhan1Grid(ctx2d, OUT_W, OUT_H);

    showPreviewAndUpload(sbdCheck, madeCheck, phan1Check);
  } finally {
    [src, dst, M, srcTri, dstTri].forEach(m => m && m.delete && m.delete());
    isBusy = false;
  }
}

// Một số trình duyệt (đặc biệt trên điện thoại) chặn phát âm thanh
// cho tới khi có cử chỉ chạm đầu tiên của người dùng -> "mở khoá" ở đây
function unlockAudioOnce() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume().then(() => {
    audioUnlocked = true;
    const hint = document.getElementById('audioHint');
    if (hint) hint.remove();
  });


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

// Nút thử giọng nói - bấm trực tiếp để kiểm tra máy có đọc được tiếng
// Việt hay không, tách biệt hoàn toàn khỏi luồng quét, dễ debug hơn.
// Bản thân việc bấm nút NÀY đã là 1 cử chỉ chạm hợp lệ -> tự mở khoá
// luôn tại đây, không phụ thuộc vào việc đã chạm chỗ khác trước đó chưa.
const testVoiceBtn = document.getElementById('testVoice');
if (testVoiceBtn) {
  testVoiceBtn.addEventListener('click', () => {
    // Phát nối tiếp cả 3 file MP3 thu sẵn để nghe thử - không phụ thuộc
    // trình duyệt/máy có hỗ trợ giọng đọc (TTS) hay không, vì đây là
    // phát file âm thanh bình thường (giống nghe nhạc), chạy được trên
    // mọi trình duyệt.
    speakVN('thieu');
    setTimeout(() => speakVN('sai'), 900);
    setTimeout(() => speakVN('trung'), 1800);
  });
}

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
let audioUnlocked = false;

// ============================================================
// ÂM THANH "Thiếu" / "Sai" / "Trùng" - dùng file MP3 thu giọng đọc
// tiếng Việt SẴN (nhúng thẳng vào code dạng base64, không cần tải file
// ngoài), thay vì speechSynthesis của trình duyệt. Lý do đổi: nhiều
// trình duyệt mặc định trên điện thoại (đặc biệt Mi Browser / trình
// duyệt hệ thống MIUI trên Xiaomi/Redmi) KHÔNG có Web Speech API, nên
// speechSynthesis.speak() không hoạt động. Dùng thẻ <audio> phát file
// MP3 thì chạy được trên MỌI trình duyệt, không phụ thuộc máy có cài
// giọng đọc (TTS engine) hay không.
// ============================================================
const VOICE_CLIPS = {
  thieu: 'data:audio/mpeg;base64,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',
  sai: 'data:audio/mpeg;base64,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MDBVVVVVTEFNRTMuMTAwVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8xDE3wAAA0gBwAAAVVVVVVVVVVVVVVVVVf/zEMTsAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV',
  trung: 'data:audio/mpeg;base64,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'
};

const voiceAudioCache = {};
function getVoiceAudio(key) {
  if (!voiceAudioCache[key]) {
    voiceAudioCache[key] = new Audio(VOICE_CLIPS[key]);
  }
  return voiceAudioCache[key];
}

// key: 'thieu' | 'sai' | 'trung'
function speakVN(key) {
  try {
    const audio = getVoiceAudio(key);
    audio.currentTime = 0;
    audio.play().catch(err =>
      console.warn('[speakVN] Không phát được âm thanh "' + key + '":', err.message)
    );
  } catch (err) {
    console.warn('[speakVN] Lỗi phát âm thanh:', err.message);
  }
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
// Trả về { ok, sbdString, errorCols, missingCols, extraCols }
//   - missingCols: các cột CHƯA tô ô nào     (dùng để báo "Thiếu")
//   - extraCols:   các cột tô TỪ 2 Ô TRỞ LÊN (dùng để báo "Sai")
function checkSBDGrid(ctx, outW, outH) {
  const darkness = readGridDarkness(ctx, OMR_TEMPLATE.sbd, outW, outH);
  const errorCols = [];
  const missingCols = [];
  const extraCols = [];
  let sbdDigits = [];

  darkness.forEach((colVals, colIdx) => {
    const filledRows = [];
    colVals.forEach((d, rowIdx) => {
      if (d >= OMR_TEMPLATE.fillThreshold) filledRows.push(rowIdx);
    });
    if (filledRows.length === 0) {
      errorCols.push(colIdx + 1);
      missingCols.push(colIdx + 1); // cột này chưa tô ô nào -> "Thiếu"
      sbdDigits.push('?');
    } else if (filledRows.length >= 2) {
      errorCols.push(colIdx + 1);
      extraCols.push(colIdx + 1); // cột này tô từ 2 ô trở lên -> "Sai"
      sbdDigits.push('?');
    } else {
      sbdDigits.push(String(filledRows[0])); // filledRows[0] chính là chữ số 0-9
    }
  });

  return {
    ok: errorCols.length === 0,
    sbdString: sbdDigits.join(''),
    errorCols,
    missingCols,
    extraCols,
    darkness
  };
}

// Kiểm tra khối Mã Đề: cấu trúc giống hệt Số báo danh (mỗi cột phải có
// ĐÚNG 1 ô được tô), chỉ khác là có 3 cột thay vì 6.
function checkMadeGrid(ctx, outW, outH) {
  const darkness = readGridDarkness(ctx, OMR_TEMPLATE.made, outW, outH);
  const errorCols = [];
  let digits = [];

  darkness.forEach((colVals, colIdx) => {
    const filledRows = [];
    colVals.forEach((d, rowIdx) => {
      if (d >= OMR_TEMPLATE.fillThreshold) filledRows.push(rowIdx);
    });
    if (filledRows.length !== 1) {
      errorCols.push(colIdx + 1);
      digits.push('?');
    } else {
      digits.push(String(filledRows[0]));
    }
  });

  return {
    ok: errorCols.length === 0,
    madeString: digits.join(''),
    errorCols,
    darkness
  };
}

// Kiểm tra khối Phần I (20 câu trắc nghiệm, 4 đáp án A/B/C/D mỗi câu).
// Khác với SBD/Mã Đề: ở đây mỗi HÀNG (câu hỏi) phải có đúng 1 CỘT (đáp án)
// được tô. KHÔNG chặn upload nếu 1 câu bị bỏ trống hoặc tô nhầm 2 đáp án -
// chỉ để trống ô đó trong bảng kết quả và đánh dấu lại để kiểm tra tay,
// vì học sinh có quyền bỏ trống câu (khác với SBD/Mã Đề luôn phải có giá trị).
const ANSWER_LETTERS = ['A', 'B', 'C', 'D'];
function checkPhan1Grid(ctx, outW, outH) {
  const darkness = readGridDarkness(ctx, OMR_TEMPLATE.phan1, outW, outH); // darkness[colIdx][rowIdx]
  const numQuestions = OMR_TEMPLATE.phan1.rows.length;
  const answers = [];
  const ambiguousQuestions = []; // số thứ tự câu (1-based) bị bỏ trống hoặc tô >1 đáp án

  for (let rowIdx = 0; rowIdx < numQuestions; rowIdx++) {
    const filledCols = [];
    darkness.forEach((colVals, colIdx) => {
      if (colVals[rowIdx] >= OMR_TEMPLATE.fillThreshold) filledCols.push(colIdx);
    });
    if (filledCols.length === 1) {
      answers.push(ANSWER_LETTERS[filledCols[0]]);
    } else {
      answers.push('');
      ambiguousQuestions.push(rowIdx + 1);
    }
  }

  return { answers, ambiguousQuestions, darkness };
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


function showPreviewAndUpload(sbdCheck, madeCheck, phan1Check) {
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
    // Số báo danh tô sai (thiếu hoặc thừa ô trong 1 cột nào đó)
    // -> KHÔNG upload lên Google Drive, chỉ cảnh báo và chờ người dùng xử lý
    uploadStatusEl.textContent =
      '⚠ Số báo danh tô sai ở cột: ' + sbdCheck.errorCols.join(', ') +
      ' (mỗi cột phải tô đúng 1 ô). Ảnh này CHƯA được lưu lên Drive — ' +
      'hãy kiểm tra lại phiếu giấy rồi bấm "Chụp lại".';
    uploadStatusEl.className = 'upload-status error';
    feedbackWarning(); // "Tè tè" + rung cảnh báo
    // Đọc rõ loại lỗi: "Thiếu" nếu có cột chưa tô ô nào, "Sai" nếu có cột
    // tô từ 2 ô trở lên (đọc cả 2 nếu xảy ra đồng thời ở các cột khác nhau)
    if (sbdCheck.missingCols.length > 0) speakVN('thieu');
    if (sbdCheck.extraCols.length > 0) speakVN('sai');
    return; // dừng lại đây, không gọi uploadToDrive
  }

  if (madeCheck && !madeCheck.ok) {
    // Mã Đề tô sai (thiếu hoặc thừa ô trong 1 cột nào đó) -> cũng chặn lại,
    // vì thiếu Mã Đề sẽ không biết dùng đáp án đúng nào để chấm sau này.
    uploadStatusEl.textContent =
      '⚠ Mã Đề tô sai ở cột: ' + madeCheck.errorCols.join(', ') +
      ' (mỗi cột phải tô đúng 1 ô). Ảnh này CHƯA được lưu lên Drive — ' +
      'hãy kiểm tra lại phiếu giấy rồi bấm "Chụp lại".';
    uploadStatusEl.className = 'upload-status error';
    feedbackWarning();
    return;
  }

  // CẢNH BÁO TRÙNG SBD TRONG PHIÊN NÀY: nếu SBD này đã quét thành công
  // trước đó rồi (khác với phiếu đang cầm trên tay hiện tại), rất có thể
  // 1 trong 2 học sinh đã tô NHẦM số báo danh. Không có phiếu nào được
  // coi là "chắc chắn đúng" chỉ vì quét trước - dừng lại hỏi ngay, vì
  // đây là lúc dễ xử lý nhất (phiếu giấy vẫn đang ở trên tay).
  if (scannedSBDs.has(sbdCheck.sbdString)) {
    feedbackWarning();
    speakVN('trung'); // đọc ngay lúc phát hiện, trước khi hộp thoại confirm() hiện lên
    const overwrite = confirm(
      '⚠ SBD ' + sbdCheck.sbdString + ' ĐÃ được quét trước đó trong phiên này!\n\n' +
      'Bấm OK nếu đây là CHỤP LẠI phiếu vừa rồi (ảnh mờ/lỗi) - ghi đè bình thường.\n' +
      'Bấm Huỷ nếu đây là phiếu của HỌC SINH KHÁC - hãy kiểm tra lại SBD với ' +
      'học sinh trước khi quét tiếp (cả 2 phiếu sẽ được lưu vào tab "SBD trùng" ' +
      'trên Google Sheet để đối chiếu và gán lại SBD đúng sau).'
    );
    if (!overwrite) {
      uploadStatusEl.textContent =
        '⛔ Đã huỷ upload - kiểm tra lại SBD với học sinh rồi quét lại phiếu này.';
      uploadStatusEl.className = 'upload-status error';
      return;
    }
  }

  // Quét/nhận diện thành công ngay tại đây -> phát "Tít" NGAY LẬP TỨC,
  // không chờ upload lên Google Drive xong mới kêu
  uploadStatusEl.textContent = 'Đang tải lên Google Drive...';
  uploadStatusEl.className = 'upload-status';
  feedbackSuccess(); // "Tít" + rung nhẹ báo thành công
  scannedSBDs.add(sbdCheck.sbdString); // ghi nhận SBD này đã quét trong phiên

  // Gói lại toàn bộ dữ liệu đã đọc được để gửi kèm ảnh lên Apps Script,
  // Apps Script sẽ ghi thẳng vào Google Sheet, khớp dòng theo SBD.
  const reading = {
    sbd: sbdCheck.sbdString,
    made: madeCheck.madeString,
    answers: phan1Check.answers,               // mảng 20 phần tử: 'A'/'B'/'C'/'D' hoặc '' nếu bỏ trống/tô nhầm
    ambiguousQuestions: phan1Check.ambiguousQuestions // câu cần người chấm kiểm tra tay
  };

  if (reading.ambiguousQuestions.length > 0) {
    uploadStatusEl.textContent =
      'Đang tải lên Google Drive... (câu ' + reading.ambiguousQuestions.join(', ') +
      ' bỏ trống hoặc tô nhầm, cần kiểm tra tay)';
  }

  uploadToDrive(dataUrl, reading);
}

async function uploadToDrive(dataUrl, reading) {
  const base64 = dataUrl.split(',')[1];
  const filename = 'phieu_' + new Date().toISOString().replace(/[:.]/g, '-') + '.jpg';

  try {
    const res = await fetch(WEBAPP_URL, {
      method: 'POST',
      // Dùng text/plain để tránh trình duyệt gửi preflight OPTIONS
      // (Apps Script Web App không xử lý OPTIONS mặc định)
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ filename, mimeType: 'image/jpeg', data: base64, reading })
    });

    const result = await res.json();
    if (result && result.success) {
      if (result.sheet && result.sheet.duplicate) {
        // Server (Code.gs) phát hiện SBD này đã có dữ liệu từ trước (kể cả
        // khi 2 điện thoại khác nhau cùng quét, hoặc quét cách nhau nhiều
        // đợt - lớp bảo vệ này không phụ thuộc vào scannedSBDs của riêng
        // trình duyệt này). Ảnh vẫn đã lưu vào Drive, chỉ là Sheet chính
        // KHÔNG bị ghi đè - dữ liệu nằm ở tab "SBD trùng" chờ xử lý tay.
        uploadStatusEl.textContent =
          '⚠ Đã lưu ảnh, nhưng SBD ' + reading.sbd + ' TRÙNG với phiếu khác đã quét ' +
          'trước đó (có thể từ máy khác) - xem tab "SBD trùng" trên Google Sheet ' +
          'để đối chiếu và gán lại SBD đúng.';
        uploadStatusEl.className = 'upload-status error';
      } else {
        uploadStatusEl.textContent = '✔ Đã lưu vào Google Drive';
        uploadStatusEl.className = 'upload-status success';
      }
      // (Âm thanh "Tít" đã phát ngay lúc quét xong ở showPreviewAndUpload(),
      // không phát lại ở đây để tránh chờ mạng)

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
