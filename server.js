const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'processed');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.existsSync(d) || fs.mkdirSync(d, { recursive: true }));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB cap
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/processed', express.static(OUTPUT_DIR));

// simple in-memory job tracker so the phone can poll for progress
const jobs = {};

app.post('/process', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded' });

  const jobId = randomUUID();
  const stamp = (req.body.stamp || '').slice(0, 24).replace(/['"\\]/g, '') || defaultStamp();
  const caption = (req.body.caption || '').slice(0, 60).replace(/['"\\]/g, '');
  const preset = ['crt', 'hero', 'diary'].includes(req.body.preset) ? req.body.preset : 'crt';
  const res_choice = ['720', '1080', '4k'].includes(req.body.resolution) ? req.body.resolution : '1080';

  const inputPath = req.file.path;
  const outputName = `analog_${jobId}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  jobs[jobId] = { status: 'processing' };
  res.json({ jobId });

  const filter = buildFilter(preset, res_choice, stamp, caption);

  // 4K needs a real amount of RAM to decode+encode - only safe on a paid
  // instance. 720/1080 stay lean enough for the free tier.
  const args = [
    '-y', '-i', inputPath,
    '-vf', filter,
    '-c:v', 'libx264', '-crf', '23', '-preset', 'ultrafast',
    '-threads', '1',
    '-c:a', 'aac', '-b:a', '96k',
    outputPath
  ];

  const ff = spawn('ffmpeg', args);
  let errLog = '';
  ff.stderr.on('data', d => { errLog += d.toString(); });

  ff.on('close', code => {
    fs.unlink(inputPath, () => {});
    if (code === 0) {
      jobs[jobId] = { status: 'done', url: `/processed/${outputName}` };
    } else {
      console.error(errLog.slice(-2000));
      jobs[jobId] = { status: 'error' };
    }
  });
});

// The three locked presets from the style guide. Each is a fixed recipe -
// same filter chain every time, so the look stays consistent across posts
// instead of drifting per-video.
function buildFilter(preset, res_choice, stamp, caption) {
  const dims = { '720': 1280, '1080': 1920, '4k': 3840 };
  const cap = dims[res_choice];
  const scale = `scale='min(${cap},iw)':'min(${cap},ih)':force_original_aspect_ratio=decrease,`;
  const font = findFont();

  // Animated text: fades in and slides up into its resting position over
  // the first 0.7s instead of just sitting there static. baseAlpha is the
  // steady-state opacity once the entrance finishes.
  const animatedText = (text, x, restY, baseAlpha, color, extra = '') => {
    if (!font) return '';
    const alphaExpr = `min(t/0.7\\,${baseAlpha})`;
    const yExpr = `(${restY})+18*max(0\\,1-t/0.6)`;
    return `,drawtext=fontfile='${font}':text='${escapeText(text)}':` +
      `fontcolor=${color}:alpha='${alphaExpr}':x=${x}:y='${yExpr}'${extra}`;
  };

  if (preset === 'crt') {
    // signal breaking through: cool tint, chromatic aberration, static
    // noise, corner timestamp that fades/slides in like it's tuning in
    return scale +
      `eq=contrast=1.12:saturation=1.05:brightness=-0.02,` +
      `curves=preset=cross_process,` +
      `rgbashift=rh=-3:bh=3,` +
      `noise=alls=10:allf=t+u,` +
      `vignette=PI/5` +
      animatedText(stamp, 'w-tw-30', 'h-th-30', 0.9, '0x1B4B4A', ':fontsize=28');
  }

  if (preset === 'hero') {
    // clean, isolated, warm - the "one object, dramatic light" look
    return scale +
      `eq=contrast=1.1:saturation=1.2:gamma=1.02,` +
      `curves=preset=medium_contrast,` +
      `unsharp=5:5:0.6,` +
      `vignette=PI/6` +
      animatedText(stamp, 'w-tw-30', 'h-th-30', 0.85, '0xD9622B', ':fontsize=28');
  }

  // diary: light-leak warm grade, heavy grain, soft contrast, caption
  // fades/slides into place near the bottom like a thought settling in
  const captionExtra = ':fontsize=26:box=1:boxcolor=0x0D0D0D@0.35:boxborderw=14';
  return scale +
    `eq=contrast=0.95:saturation=1.15:gamma=1.05:brightness=0.02,` +
    `curves=preset=vintage,` +
    `noise=alls=16:allf=t+u,` +
    `vignette=PI/4` +
    (caption
      ? animatedText(caption, '(w-tw)/2', 'h-th-60', 0.95, '0xF2E8D8', captionExtra)
      : animatedText(stamp, 'w-tw-30', 'h-th-30', 0.85, '0xF2E8D8', ':fontsize=26'));
}

function escapeText(t) {
  return t.replace(/:/g, '\\:').replace(/%/g, '\\%');
}

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    // Job not found usually means the server restarted mid-processing -
    // most often because it ran out of memory (e.g. a 4K clip on the free
    // tier) and got auto-restarted, wiping the in-memory job list. Tell
    // the phone that plainly instead of leaving it polling forever.
    return res.json({ status: 'error', reason: 'lost' });
  }
  res.json(job);
});

// Look for a usable font at runtime instead of hardcoding a path that
// may not exist on the host. Falls back to no timestamp if none found.
function findFont() {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Courier New Bold.ttf'
  ];
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

function defaultStamp() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getDate()).padStart(2, '0')} ${String(d.getFullYear()).slice(2)}`;
}

app.listen(PORT, () => console.log(`Analog video tool running on port ${PORT}`));
