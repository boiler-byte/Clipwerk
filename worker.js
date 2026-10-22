/*
 * Clipwerk 1.0 - local export worker, no dependencies or network requests.
 * Copyright (c) 2026. Generated for the recipient; use and modify freely.
 *
 * Receives decoded ImageBitmaps and PCM audio from index.html, composites
 * pictures/captions with OffscreenCanvas, encodes with WebCodecs, and writes
 * MP4 (AVC + AAC) or WebM (VP8/VP9 + Opus). No SharedArrayBuffer is required.
 *
 * The small container writers below intentionally cover only these outputs,
 * not arbitrary remuxing. Input decoding stays with the browser's media APIs.
 * References: https://www.w3.org/TR/webcodecs/
 * https://www.w3.org/TR/webcodecs-avc-codec-registration/
 * https://www.webmproject.org/docs/container/
 */
'use strict';
let job = null;
const MAX_ENCODED_BYTES = 512 * 1024 * 1024;
const MAX_PCM_BYTES = 384 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(error) {
  if (job && !job.error) { job.error = error; self.postMessage({ type: 'fatal', error: error.message || String(error) }); }
}
function checkJob() {
  if (!job) throw new Error('Kein Export gestartet.');
  if (job.error) throw job.error;
}
function videoConfig(format, width, height, codec) {
  const config = { codec, width, height, framerate: 30, bitrate: height >= 1080 ? 8000000 : 4500000, latencyMode: 'realtime', hardwareAcceleration: 'no-preference' };
  if (format === 'mp4') config.avc = { format: 'avc' };
  return config;
}
async function supported(Constructor, config) {
  if (!Constructor) return false;
  try { return (await Constructor.isConfigSupported(config)).supported; } catch { return false; }
}
async function probe(width, height) {
  if (!self.VideoEncoder || !self.OffscreenCanvas) return { mp4: false, webm: false, videoMP4: false, audioMP4: false, reason: 'WebCodecs fehlt. Nutze einen aktuellen Desktop-Browser und localhost oder HTTPS.' };
  const avcCandidates = height >= 1080 ? ['avc1.420028', 'avc1.4d4028', 'avc1.640028'] : ['avc1.42001f', 'avc1.4d401f', 'avc1.64001f'];
  let avc = null;
  for (const c of avcCandidates) if (await supported(self.VideoEncoder, videoConfig('mp4', width, height, c))) { avc = c; break; }
  let webmCodec = null;
  for (const c of [height >= 1080 ? 'vp09.00.40.08' : 'vp09.00.31.08', 'vp8']) if (await supported(self.VideoEncoder, videoConfig('webm', width, height, c))) { webmCodec = c; break; }
  const aac = await supported(self.AudioEncoder, { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 });
  const opus = await supported(self.AudioEncoder, { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 });
  return { mp4: !!avc && aac, webm: !!webmCodec && opus, videoMP4: !!avc, audioMP4: aac, videoWebM: !!webmCodec, audioWebM: opus, avc, webmCodec };
}
function collectChunk(kind, chunk, metadata) {
  if (!job || job.error) return;
  const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
  job.bytes += data.byteLength;
  if (job.bytes > MAX_ENCODED_BYTES) { fail(new Error('Die Exportdatei wird groesser als 512 MB. Bitte kuerze den Schnitt oder waehle 720p.')); return; }
  job[kind].push({ data, timestamp: chunk.timestamp, duration: chunk.duration, key: chunk.type === 'key' });
  const desc = metadata?.decoderConfig?.description;
  if (desc) job[kind + 'Description'] = new Uint8Array(desc instanceof ArrayBuffer ? desc : desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength));
}
async function start(config) {
  const caps = await probe(config.width, config.height);
  const videoOK = config.format === 'mp4' ? caps.videoMP4 : caps.videoWebM;
  const audioOK = config.format === 'mp4' ? caps.audioMP4 : caps.audioWebM;
  if (!videoOK || (config.hasAudio && !audioOK)) throw new Error('Das gewaehlte Exportformat wird von diesem Browser nicht vollstaendig unterstuetzt. Bitte WebM oder einen anderen Desktop-Browser verwenden.');
  job = { ...config, video: [], audio: [], bytes: 0, pcmBytes: 0, pcm: new Map(), error: null, frames: 0, audioDone: !config.hasAudio };
  job.codec = config.format === 'mp4' ? caps.avc : caps.webmCodec;
  job.canvas = new OffscreenCanvas(config.width, config.height);
  job.ctx = job.canvas.getContext('2d', { alpha: false });
  if (!job.ctx) throw new Error('OffscreenCanvas ist nicht verfuegbar.');
  job.videoEncoder = new VideoEncoder({ output: (chunk, meta) => collectChunk('video', chunk, meta), error: fail });
  job.videoEncoder.configure(videoConfig(config.format, config.width, config.height, job.codec));
  if (config.hasAudio) {
    job.audioEncoder = new AudioEncoder({ output: (chunk, meta) => collectChunk('audio', chunk, meta), error: fail });
    job.audioEncoder.configure({ codec: config.format === 'mp4' ? 'mp4a.40.2' : 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 });
  }
  return { codec: job.codec };
}
function addPCM(mediaId, sampleRate, planes) {
  checkJob();
  const data = planes.map(p => new Float32Array(p));
  job.pcmBytes += data.reduce((sum, p) => sum + p.byteLength, 0);
  if (job.pcmBytes > MAX_PCM_BYTES) throw new Error('Die Tonquellen brauchen zu viel Arbeitsspeicher (mehr als 384 MB). Bitte kuerzere Quelldateien verwenden oder den Originalton stummschalten.');
  job.pcm.set(mediaId, { sampleRate, data });
}
function readChannel(pcm, channel, index) {
  const data = pcm.data;
  if (!data.length) return 0;
  const sample = arr => {
    if (!arr || index < 0 || index >= arr.length) return 0;
    const i = Math.floor(index), f = index - i;
    return arr[i] * (1 - f) + (arr[Math.min(i + 1, arr.length - 1)] || 0) * f;
  };
  let value = sample(data[data.length === 1 ? 0 : channel]);
  // Conservative downmix for common 5.1 layouts. The LFE channel is omitted.
  if (data.length >= 3) value += sample(data[2]) * 0.7071;
  if (data.length >= 6) value += sample(data[4 + channel]) * 0.5;
  return value;
}
async function mixAudio() {
  checkJob();
  if (!job.hasAudio) return;
  const rate = 48000, total = Math.round(job.totalFrames / job.fps * rate), block = 4800;
  const clips = job.audioClips.filter(c => c.volume > 0 && job.pcm.has(c.mediaId));
  for (let offset = 0; offset < total; offset += block) {
    checkJob();
    const frames = Math.min(block, total - offset), data = new Float32Array(frames * 2);
    const begin = offset / rate, end = (offset + frames) / rate;
    for (const c of clips) {
      if (c.start >= end || c.start + c.duration <= begin) continue;
      const pcm = job.pcm.get(c.mediaId);
      const from = Math.max(0, Math.ceil((c.start - begin) * rate - 1e-6));
      const to = Math.min(frames, Math.ceil((c.start + c.duration - begin) * rate - 1e-6));
      for (let i = from; i < to; i++) {
        const index = (c.in + begin + i / rate - c.start) * pcm.sampleRate;
        data[i] += readChannel(pcm, 0, index) * c.volume;
        data[frames + i] += readChannel(pcm, 1, index) * c.volume;
      }
    }
    // A soft knee avoids hard digital clipping when music and original sound overlap.
    for (let i = 0; i < data.length; i++) {
      const value = data[i], abs = Math.abs(value);
      if (abs > 0.9) data[i] = Math.sign(value) * (0.9 + 0.1 * Math.tanh((abs - 0.9) / 0.1));
    }
    const audio = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: frames, numberOfChannels: 2, timestamp: Math.round(offset / rate * 1e6), data });
    job.audioEncoder.encode(audio); audio.close();
    while (job.audioEncoder.encodeQueueSize > 5) { checkJob(); await sleep(5); }
    if (offset % (block * 10) === 0) self.postMessage({ type: 'progress', phase: 'audio', fraction: offset / total });
  }
  await job.audioEncoder.flush(); checkJob();
  job.audioEncoder.close(); job.pcm.clear(); job.pcmBytes = 0; job.audioDone = true;
  self.postMessage({ type: 'progress', phase: 'audio', fraction: 1 });
}
async function addFrame(bitmap, index, fit) {
  checkJob();
  if (index !== job.frames) { bitmap?.close(); throw new Error('Die Reihenfolge der Videobilder stimmt nicht.'); }
  const { ctx, width, height } = job;
  ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, width, height);
  if (bitmap) {
    try { fitMedia(ctx, bitmap, bitmap.width, bitmap.height, width, height, fit); } finally { bitmap.close(); }
  }
  const time = index / job.fps;
  for (const c of job.textClips) if (time + 1e-7 >= c.start && time < c.start + c.duration - 1e-7) drawCaption(ctx, c, width, height);
  const timestamp = Math.round(index / job.fps * 1e6), next = Math.round((index + 1) / job.fps * 1e6);
  const frame = new VideoFrame(job.canvas, { timestamp, duration: next - timestamp });
  job.videoEncoder.encode(frame, { keyFrame: index % (job.fps * 2) === 0 }); frame.close(); job.frames++;
  while (job.videoEncoder.encodeQueueSize > 3) { checkJob(); await sleep(4); }
  checkJob();
  return { frames: job.frames };
}
async function finish() {
  checkJob();
  if (job.frames !== job.totalFrames || !job.audioDone) throw new Error('Der Export ist noch nicht vollstaendig.');
  await job.videoEncoder.flush(); checkJob(); job.videoEncoder.close();
  if (!job.video.length) throw new Error('Der Video-Encoder hat keine Bilder geliefert.');
  if (job.video.length !== job.totalFrames) throw new Error('Der Browser-Encoder hat Bilder ausgelassen. Bitte einen anderen Codec oder 720p versuchen.');
  const blob = job.format === 'mp4' ? muxMP4(job) : muxWebM(job);
  const result = { blob, format: job.format, bytes: blob.size, frames: job.frames, duration: job.totalFrames / job.fps };
  job.video = []; job.audio = []; job.pcm.clear(); job = null;
  return result;
}
self.onmessage = async event => {
  const m = event.data;
  try {
    let result;
    if (m.type === 'probe') result = await probe(m.width, m.height);
    else if (m.type === 'start') result = await start(m.config);
    else if (m.type === 'pcm') { addPCM(m.mediaId, m.sampleRate, m.planes); result = {}; }
    else if (m.type === 'audio') { await mixAudio(); result = {}; }
    else if (m.type === 'frame') result = await addFrame(m.bitmap, m.index, m.fit);
    else if (m.type === 'finish') result = await finish();
    else throw new Error('Unbekannte Worker-Nachricht.');
    self.postMessage({ id: m.id, result });
  } catch (error) { self.postMessage({ id: m.id, error: error.message || String(error) }); }
};

// ---- Small binary writers --------------------------------------------------
const utf8 = value => new TextEncoder().encode(value);
const zeros = count => new Uint8Array(count);
function concat(...parts) {
  const length = parts.reduce((sum, p) => sum + p.byteLength, 0), data = new Uint8Array(length);
  let offset = 0; for (const p of parts) { data.set(p, offset); offset += p.byteLength; }
  return data;
}
function u16(value) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, value); return b; }
function u32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value >>> 0); return b; }
function box(type, ...parts) { const n = 8 + parts.reduce((sum, p) => sum + p.byteLength, 0); return concat(u32(n), utf8(type), ...parts); }
function full(type, version, flags, ...parts) { return box(type, new Uint8Array([version, flags >> 16 & 255, flags >> 8 & 255, flags & 255]), ...parts); }
const matrix = () => concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));
function descriptor(tag, data) {
  const length = []; let n = data.length;
  do { length.unshift(n & 127); n = Math.floor(n / 128); } while (n);
  for (let i = 0; i < length.length - 1; i++) length[i] |= 128;
  return concat(new Uint8Array([tag, ...length]), data);
}
function runs(values) {
  const result = [];
  for (const value of values) {
    const last = result[result.length - 1];
    if (last && last[1] === value) last[0]++; else result.push([1, value]);
  }
  return result;
}
function muxMP4(j) {
  if (!j.videoDescription?.length) throw new Error('Der H.264-Encoder hat keine MP4-Konfiguration geliefert.');
  const duration = j.totalFrames / j.fps, movieDuration = Math.round(duration * 1000);
  const videoScale = 90000, videoStep = videoScale / j.fps;
  const ftyp = box('ftyp', utf8('isom'), u32(512), utf8('isomiso2avc1mp41'));
  const videoBytes = j.video.reduce((sum, s) => sum + s.data.length, 0), audioBytes = j.audio.reduce((sum, s) => sum + s.data.length, 0);
  function makeTrack(kind, id, offset) {
    const video = kind === 'video', samples = j[kind], scale = video ? videoScale : 48000;
    const steps = samples.map((s, i) => video ? videoStep : Math.max(1, Math.round(((i + 1 < samples.length ? samples[i + 1].timestamp - s.timestamp : s.duration) || 1024 / 48000 * 1e6) * scale / 1e6)));
    const mediaDuration = steps.reduce((a, b) => a + b, 0);
    const tkhd = full('tkhd', 0, 7, u32(0), u32(0), u32(id), u32(0), u32(movieDuration), zeros(8), u16(0), u16(0), u16(video ? 0 : 0x100), u16(0), matrix(), u32(video ? j.width * 65536 : 0), u32(video ? j.height * 65536 : 0));
    const firstAudioTime = !video && samples.length ? Math.round(samples[0].timestamp * scale / 1e6) : 0;
    const mediaStart = Math.max(0, -firstAudioTime);
    const edts = box('edts', full('elst', 0, 0, u32(1), u32(movieDuration), u32(mediaStart), u16(1), u16(0)));
    const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(scale), u32(mediaDuration), u16(0x55c4), u16(0));
    const hdlr = full('hdlr', 0, 0, u32(0), utf8(video ? 'vide' : 'soun'), zeros(12), utf8(video ? 'Clipwerk Video\0' : 'Clipwerk Audio\0'));
    let entry;
    if (video) {
      const compressor = new Uint8Array(32), name = utf8('Clipwerk'); compressor[0] = name.length; compressor.set(name, 1);
      entry = box('avc1', zeros(6), u16(1), zeros(16), u16(j.width), u16(j.height), u32(72 * 65536), u32(72 * 65536), u32(0), u16(1), compressor, u16(24), u16(0xffff), box('avcC', j.videoDescription));
    } else {
      const asc = j.audioDescription?.length ? j.audioDescription : new Uint8Array([0x11, 0x90]);
      const decoderConfig = descriptor(0x04, concat(new Uint8Array([0x40, 0x15, 0, 0, 0]), u32(160000), u32(160000), descriptor(0x05, asc)));
      const esds = full('esds', 0, 0, descriptor(0x03, concat(u16(id), new Uint8Array([0]), decoderConfig, descriptor(0x06, new Uint8Array([2])))));
      entry = box('mp4a', zeros(6), u16(1), zeros(8), u16(2), u16(16), u16(0), u16(0), u32(48000 * 65536), esds);
    }
    const stsd = full('stsd', 0, 0, u32(1), entry);
    const timing = runs(steps);
    const stts = full('stts', 0, 0, u32(timing.length), ...timing.map(([count, delta]) => concat(u32(count), u32(delta))));
    const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1));
    const stsz = full('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map(s => u32(s.data.length)));
    const stco = full('stco', 0, 0, u32(1), u32(offset));
    const extra = [];
    if (video) {
      const keys = samples.flatMap((s, i) => s.key ? [i + 1] : []);
      extra.push(full('stss', 0, 0, u32(keys.length), ...keys.map(u32)));
      const offsets = samples.map((s, i) => Math.round(s.timestamp * scale / 1e6) - i * videoStep);
      if (offsets.some(v => v !== 0)) {
        const composition = runs(offsets);
        extra.push(full('ctts', 1, 0, u32(composition.length), ...composition.map(([count, value]) => concat(u32(count), u32(value)))));
      }
    }
    const stbl = box('stbl', stsd, stts, stsc, stsz, stco, ...extra);
    const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
    const header = video ? full('vmhd', 0, 1, zeros(8)) : full('smhd', 0, 0, zeros(4));
    return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, box('minf', header, dinf, stbl)));
  }
  function moov(videoOffset, audioOffset) {
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDuration), u32(0x10000), u16(0x100), zeros(10), matrix(), zeros(24), u32(3));
    return box('moov', mvhd, makeTrack('video', 1, videoOffset), ...(j.audio.length ? [makeTrack('audio', 2, audioOffset)] : []));
  }
  const initial = moov(0, 0), videoOffset = ftyp.length + initial.length + 8;
  const movie = moov(videoOffset, videoOffset + videoBytes);
  const mdatHeader = concat(u32(videoBytes + audioBytes + 8), utf8('mdat'));
  return new Blob([ftyp, movie, mdatHeader, ...j.video.map(s => s.data), ...j.audio.map(s => s.data)], { type: 'video/mp4' });
}

// WebM/EBML. Segment positions are relative to the first byte of its payload.
function ebmlID(id) {
  const bytes = []; do { bytes.unshift(id & 255); id = Math.floor(id / 256); } while (id);
  return new Uint8Array(bytes);
}
function vint(value) {
  for (let length = 1; length <= 8; length++) {
    if (value < 2 ** (7 * length) - 1) {
      const bytes = new Uint8Array(length); let n = value;
      for (let i = length - 1; i >= 0; i--) { bytes[i] = n % 256; n = Math.floor(n / 256); }
      bytes[0] |= 1 << (8 - length); return bytes;
    }
  }
  throw new Error('WebM-Datei zu gross.');
}
function ebml(id, ...parts) { const data = concat(...parts); return concat(ebmlID(id), vint(data.length), data); }
function uint(value, size = 0) {
  if (!size) { size = 1; while (value >= 2 ** (8 * size)) size++; }
  const b = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) { b[i] = value % 256; value = Math.floor(value / 256); }
  return b;
}
function floating(value) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, value); return b; }
function muxWebM(j) {
  const duration = j.totalFrames / j.fps * 1000;
  const header = ebml(0x1a45dfa3, ebml(0x4286, uint(1)), ebml(0x42f7, uint(1)), ebml(0x42f2, uint(4)), ebml(0x42f3, uint(8)), ebml(0x4282, utf8('webm')), ebml(0x4287, uint(4)), ebml(0x4285, uint(2)));
  const info = ebml(0x1549a966, ebml(0x2ad7b1, uint(1000000)), ebml(0x4489, floating(duration)), ebml(0x4d80, utf8('Clipwerk')), ebml(0x5741, utf8('Clipwerk')));
  const videoTrack = ebml(0xae, ebml(0xd7, uint(1)), ebml(0x73c5, uint(1)), ebml(0x83, uint(1)), ebml(0x9c, uint(0)), ebml(0x86, utf8(j.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8')), ebml(0x23e383, uint(Math.round(1e9 / j.fps))), ebml(0xe0, ebml(0xb0, uint(j.width)), ebml(0xba, uint(j.height))));
  let audioTrack = null, delaySamples = 0;
  if (j.audio.length) {
    let opusHead = j.audioDescription;
    if (!opusHead || opusHead.length < 19) {
      opusHead = new Uint8Array(19); opusHead.set(utf8('OpusHead')); opusHead[8] = 1; opusHead[9] = 2;
      new DataView(opusHead.buffer).setUint32(12, 48000, true);
      // Encoder timestamps before zero expose priming when no OpusHead is supplied.
      new DataView(opusHead.buffer).setUint16(10, Math.max(0, Math.round(-j.audio[0].timestamp * 48000 / 1e6)), true);
    }
    delaySamples = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength).getUint16(10, true);
    audioTrack = ebml(0xae, ebml(0xd7, uint(2)), ebml(0x73c5, uint(2)), ebml(0x83, uint(2)), ebml(0x9c, uint(0)), ebml(0x86, utf8('A_OPUS')), ebml(0x63a2, opusHead), ebml(0x56aa, uint(Math.round(delaySamples / 48000 * 1e9))), ebml(0x56bb, uint(80000000)), ebml(0xe1, ebml(0xb5, floating(48000)), ebml(0x9f, uint(2))));
  }
  const tracks = ebml(0x1654ae6b, videoTrack, ...(audioTrack ? [audioTrack] : []));
  const shiftAudio = j.audio.length ? Math.max(0, -j.audio[0].timestamp) : 0;
  const packets = [...j.video.map(s => ({ ...s, track: 1, ms: Math.round(s.timestamp / 1000) })), ...j.audio.map((s, index) => ({ ...s, track: 2, lastAudio: index === j.audio.length - 1, ms: Math.max(0, Math.round((s.timestamp + shiftAudio) / 1000)) }))].sort((a, b) => a.ms - b.ms || a.track - b.track);
  const groups = []; let group = null;
  for (const packet of packets) {
    // New clusters at video keyframes permit accurate cue-based seeking.
    if (!group || (packet.track === 1 && packet.key && packet.ms - group.time >= 1000) || packet.ms - group.time > 15000) {
      group = { time: packet.ms, packets: [] }; groups.push(group);
    }
    group.packets.push(packet);
  }
  const clusters = groups.map(g => {
    const blocks = g.packets.map(s => {
      const block = new Uint8Array(4); block[0] = 0x80 | s.track;
      new DataView(block.buffer).setInt16(1, s.ms - g.time);
      block[3] = s.key ? 0x80 : 0;
      if (s.lastAudio) {
        const packetSamples = Math.round((s.duration || 20000) * 48000 / 1e6);
        const endSamples = Math.round(s.ms / 1000 * 48000) - delaySamples + packetSamples;
        const wantedSamples = Math.round(j.totalFrames / j.fps * 48000);
        const padding = Math.max(0, Math.min(packetSamples, endSamples - wantedSamples));
        if (padding) {
          block[3] = 0; // The keyframe flag is not part of Block (only SimpleBlock).
          return ebml(0xa0, ebml(0xa1, block, s.data), ebml(0x75a2, uint(Math.round(padding / 48000 * 1e9), 8)));
        }
      }
      return ebml(0xa3, block, s.data);
    });
    return ebml(0x1f43b675, ebml(0xe7, uint(g.time)), ...blocks);
  });
  function seekHead(infoPos, tracksPos, cuesPos) {
    return ebml(0x114d9b74, ...[[0x1549a966, infoPos], [0x1654ae6b, tracksPos], [0x1c53bb6b, cuesPos]].map(([id, position]) => ebml(0x4dbb, ebml(0x53ab, ebmlID(id)), ebml(0x53ac, uint(position, 8)))));
  }
  let seek = seekHead(0, 0, 0), offset = seek.length + info.length + tracks.length;
  const cuePoints = [];
  groups.forEach((g, i) => {
    if (g.packets.some(s => s.track === 1 && s.key)) cuePoints.push(ebml(0xbb, ebml(0xb3, uint(g.time)), ebml(0xb7, ebml(0xf7, uint(1)), ebml(0xf1, uint(offset)))));
    offset += clusters[i].length;
  });
  const cues = ebml(0x1c53bb6b, ...cuePoints);
  seek = seekHead(seek.length, seek.length + info.length, offset);
  const segmentLength = offset + cues.length;
  return new Blob([header, ebmlID(0x18538067), vint(segmentLength), seek, info, tracks, ...clusters, cues], { type: 'video/webm' });
}
// The same renderer is embedded in the page and the worker.
function drawCaption(ctx, c, width, height) {
  if (!c || !c.text || !c.text.trim()) return;
  ctx.save();
  const scale = height / 720;
  let size = (Number(c.fontSize) || 36) * scale;
  const maxWidth = width * 0.86;
  let lines = [];
  function wrap() {
    ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const out = [];
    for (const para of c.text.split('\n')) {
      if (!para.trim()) { out.push(''); continue; }
      let line = '';
      for (const word of para.trim().split(/\s+/)) {
        if (ctx.measureText(word).width > maxWidth) {
          if (line) { out.push(line); line = ''; }
          for (const ch of word) {
            if (line && ctx.measureText(line + ch).width > maxWidth) { out.push(line); line = ch; }
            else line += ch;
          }
        } else if (line && ctx.measureText(line + ' ' + word).width > maxWidth) {
          out.push(line); line = word;
        } else line += (line ? ' ' : '') + word;
      }
      out.push(line);
    }
    return out;
  }
  lines = wrap();
  while (lines.length * size * 1.24 > height * 0.72 && size > 13 * scale) {
    size *= 0.92; lines = wrap();
  }
  const lineHeight = size * 1.24;
  const blockHeight = lines.length * lineHeight;
  const paddingX = 18 * scale, paddingY = 11 * scale;
  const top = c.position === 'top' ? height * 0.10 : c.position === 'middle' ? (height - blockHeight) / 2 : height * 0.90 - blockHeight;
  const textWidth = Math.min(maxWidth, Math.max(...lines.map(s => ctx.measureText(s).width)));
  if (c.background !== false) {
    ctx.fillStyle = 'rgba(8, 10, 17, 0.78)';
    const x = (width - textWidth) / 2 - paddingX, y = top - paddingY;
    ctx.beginPath();
    ctx.roundRect(x, y, textWidth + 2 * paddingX, blockHeight + 2 * paddingY, 8 * scale);
    ctx.fill();
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = c.color || '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 3 * scale; ctx.shadowOffsetY = 1 * scale;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], width / 2, top + lineHeight * (i + 0.5), maxWidth);
  ctx.restore();
}
function fitMedia(ctx, source, sourceWidth, sourceHeight, width, height, mode) {
  const scale = mode === 'cover' ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight);
  const w = sourceWidth * scale, h = sourceHeight * scale;
  ctx.drawImage(source, (width - w) / 2, (height - h) / 2, w, h);
}