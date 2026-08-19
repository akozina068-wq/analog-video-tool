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
  const stamp = (req.body.stamp || '').slice(0, 20).replace(/['"\\]/g, '') || defaultStamp();
  const intensity = req.body.intensity === 'strong' ? 'strong' : 'classic';

  const inputPath = req.file.path;
  const outputName = `analog_${jobId}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  jobs[jobId] = { status: 'processing' };
  res.json({ jobId });

  const grain = intensity === 'strong' ? 20 : 12;
  const sat = intensity === 'strong' ? 1.35 : 1.25;
  const vignette = intensity === 'strong' ? 'PI/4' : 'PI/6';

  const fontPath = findFont();
  const filter =
    `eq=contrast=1.08:saturation=${sat}:gamma=0.95,` +
    `curves=preset=vintage,` +
    `noise=alls=${grain}:allf=t+u,` +
    `vignette=${vignette}` +
    (fontPath
      ? `,drawtext=fontfile='${fontPath}':text='${stamp}':fontcolor=orange@0.85:fontsize=30:x=w-tw-35:y=h-th-35`
      : '');

  const args = [
    '-y', '-i', inputPath,
    '-vf', filter,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
    '-c:a', 'copy',
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

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'not found' });
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
