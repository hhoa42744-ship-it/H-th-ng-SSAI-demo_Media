const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile, exec } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

const INPUT_DIR = path.join(__dirname, "input");
const OUTPUT_DIR = path.join(__dirname, "output");

const regionConfigs = {
  hanoi: {
    adFile: "ad_video1.mp4",
    adStart: 20,
    adDuration: 34
  },
  danang: {
    adFile: "ad_video2.mp4",
    adStart: 20,
    adDuration: 26
  }
};

const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 720;
const TARGET_FPS = 30;
const TARGET_AUDIO_RATE = 48000;
const TARGET_AUDIO_CHANNELS = 2;
const VIDEO_BITRATE = "2500k";
const AUDIO_BITRATE = "128k";

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

app.use(express.static(__dirname));
app.use("/output", express.static(OUTPUT_DIR));

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (error, stdout, stderr) => {
      if (error) {
        console.error("\n===== FFmpeg ERROR =====");
        console.error(stderr);
        console.error("========================\n");
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function getDuration(file) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      (error, stdout, stderr) => {
        if (error) {
          console.error(stderr);
          reject(error);
          return;
        }
        const duration = Number.parseFloat(stdout.trim());
        if (!Number.isFinite(duration)) {
          reject(new Error("Không đọc được thời lượng video."));
          return;
        }
        resolve(duration);
      }
    );
  });
}

const videoFilter = `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps=${TARGET_FPS},format=yuv420p`;

// Hàm xử lý dựng hình SSAI trước cho từng khu vực
async function buildStreamForRegion(region) {
  const config = regionConfigs[region];
  const mainVideo = path.join(INPUT_DIR, "main_video.mp4");
  const adVideo = path.join(INPUT_DIR, config.adFile);

  if (!fs.existsSync(mainVideo) || !fs.existsSync(adVideo)) {
    console.error(`[${region}] Không tìm thấy file video trong input!`);
    return;
  }

  const workDir = path.join(OUTPUT_DIR, region);
  const playlist = path.join(workDir, "stream.m3u8");

  // Nếu đã render sẵn rồi thì bỏ qua để khởi động siêu nhanh
  if (fs.existsSync(playlist)) {
    console.log(`[SSAI Cache] Luồng '${region}' đã sẵn sàng.`);
    return;
  }

  fs.mkdirSync(workDir, { recursive: true });
  console.log(`[SSAI Engine] Đang xử lý dựng hình cho khu vực: ${region}...`);

  const mainPart1 = path.join(workDir, "main_part1.mp4");
  const mainPart2 = path.join(workDir, "main_part2.mp4");
  const adPart = path.join(workDir, "ad.mp4");
  const joined = path.join(workDir, "joined.mp4");
  const concatFile = path.join(workDir, "concat.txt");

  try {
    const mainDuration = await getDuration(mainVideo);

    // 1. Cắt Main Phần 1 (Dùng preset ultrafast để render nhanh gấp nhiều lần)
    await runFFmpeg([
      "-y", "-i", mainVideo, "-t", String(config.adStart),
      "-vf", videoFilter, "-c:v", "libx264", "-preset", "ultrafast", "-b:v", VIDEO_BITRATE,
      "-r", String(TARGET_FPS), "-pix_fmt", "yuv420p", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
      "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", String(TARGET_AUDIO_RATE), "-ac", String(TARGET_AUDIO_CHANNELS),
      "-movflags", "+faststart", mainPart1
    ]);

    // 2. Cắt Main Phần 2
    await runFFmpeg([
      "-y", "-ss", String(config.adStart), "-i", mainVideo,
      "-vf", videoFilter, "-c:v", "libx264", "-preset", "ultrafast", "-b:v", VIDEO_BITRATE,
      "-r", String(TARGET_FPS), "-pix_fmt", "yuv420p", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
      "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", String(TARGET_AUDIO_RATE), "-ac", String(TARGET_AUDIO_CHANNELS),
      "-movflags", "+faststart", mainPart2
    ]);

    // 3. Chuẩn hóa Quảng cáo
    await runFFmpeg([
      "-y", "-i", adVideo,
      "-vf", videoFilter, "-c:v", "libx264", "-preset", "ultrafast", "-b:v", VIDEO_BITRATE,
      "-r", String(TARGET_FPS), "-pix_fmt", "yuv420p", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
      "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", String(TARGET_AUDIO_RATE), "-ac", String(TARGET_AUDIO_CHANNELS),
      "-movflags", "+faststart", adPart
    ]);

    // 4. Tạo file concat (concatenate)
    fs.writeFileSync(
      concatFile,
      `file '${mainPart1.replace(/\\/g, "/")}'\n` +
      `file '${adPart.replace(/\\/g, "/")}'\n` +
      `file '${mainPart2.replace(/\\/g, "/")}'\n`
    );

    // 5. Ghép nối
    await runFFmpeg([
      "-y", "-f", "concat", "-safe", "0", "-i", concatFile,
      "-c", "copy", "-movflags", "+faststart", joined
    ]);

    // 6. Đóng gói HLS (chia nhỏ segment 2 giây để siêu mượt, giảm thiểu độ trễ)
    await runFFmpeg([
      "-y", "-i", joined, "-c", "copy", "-start_number", "0",
      "-hls_time", "2", "-hls_list_size", "0",
      "-hls_segment_filename", path.join(workDir, "segment_%03d.ts"),
      "-f", "hls", playlist
    ]);

    console.log(`[SSAI Engine] Hoàn tất dựng hình cho: ${region}!`);
  } catch (error) {
    console.error(`Lỗi xử lý ${region}:`, error);
  }
}

// API endpoint trả về ngay lập tức vì video đã được render sẵn
app.get("/api/stream", async (req, res) => {
  const region = String(req.query.region || "").toLowerCase();
  
  if (!regionConfigs[region]) {
    return res.status(400).json({ error: "Khu vực không hợp lệ." });
  }

  const playlistPath = path.join(OUTPUT_DIR, region, "stream.m3u8");
  
  res.json({
  success: true,
  playlist: `https://h-th-ng-ssai-demo-media.onrender.com/live/${region}/stream.m3u8`
});
});

app.listen(PORT, async () => {
  console.log(` SSAI HLS Server đang chạy tại cổng ${PORT}`);
  
  // Render sẵn tất cả các vùng ngay khi khởi động để tối ưu tốc độ
  await buildStreamForRegion("hanoi");
  await buildStreamForRegion("danang");
  console.log(` Tất cả luồng SSAI đã sẵn sàng phát tức thì!`);

  if (process.platform === "win32" || process.platform === "darwin") {
    const url = `http://localhost:${PORT}`;
    const startCommand = process.platform === "win32" ? `start ${url}` : `open ${url}`;
    exec(startCommand);
  }
});