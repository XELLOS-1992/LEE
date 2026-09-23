// Runs on the audio thread: mixes to mono, low-pass filters and resamples to
// 16 kHz, emits Int16 PCM in ~100 ms packets plus a level reading for the meter.
class PCMRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.target;
    // Low-pass FIR (windowed sinc, cutoff just under 8 kHz) so speech above the
    // new Nyquist frequency doesn't fold back as noise when we downsample.
    const taps = 63, fc = (0.45 * this.target) / sampleRate;
    this.fir = new Float32Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const m = i - (taps - 1) / 2;
      const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1)); // Blackman
      this.fir[i] = sinc * w;
      sum += this.fir[i];
    }
    for (let i = 0; i < taps; i++) this.fir[i] /= sum;
    this.hist = new Float32Array(taps - 1); // filter state carried across blocks
    this.pos = 0;          // fractional read position into the carried input
    this.carry = new Float32Array(0);
    this.out = new Int16Array(1600);
    this.n = 0;
    this.paused = false;
    this.peak = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'pause') this.paused = true;
      else if (e.data === 'resume') this.paused = false;
      else if (e.data === 'flush') this.flush();
    };
  }

  flush() {
    if (this.n > 0) {
      const buf = this.out.slice(0, this.n).buffer;
      this.port.postMessage({ pcm: buf, level: this.peak }, [buf]);
      this.n = 0;
      this.peak = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const len = input[0].length;
    const mono = new Float32Array(len);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < len; i++) mono[i] += ch[i] / input.length;
    }
    if (this.paused) {
      this.port.postMessage({ level: 0, paused: true });
      return true;
    }
    // Low-pass filter the block (with history from the previous one).
    const taps = this.fir.length;
    const ext = new Float32Array(this.hist.length + len);
    ext.set(this.hist, 0);
    ext.set(mono, this.hist.length);
    const filtered = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let acc = 0;
      for (let k = 0; k < taps; k++) acc += this.fir[k] * ext[i + k];
      filtered[i] = acc;
    }
    this.hist = ext.slice(len);
    // Resample the filtered signal (linear interpolation is fine once band-limited).
    const data = new Float32Array(this.carry.length + len);
    data.set(this.carry, 0);
    data.set(filtered, this.carry.length);
    const r = this.ratio;
    let pos = this.pos;
    while (pos + 1 < data.length) {
      const a = Math.floor(pos), f = pos - a;
      const v = data[a] * (1 - f) + data[a + 1] * f;
      const abs = Math.abs(v);
      if (abs > this.peak) this.peak = abs;
      const s = Math.max(-1, Math.min(1, v));
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.out.length) this.flush();
      pos += r;
    }
    // pos may run past the end of this block; keep the overshoot for the next one.
    const used = Math.min(Math.floor(pos), data.length);
    this.carry = data.slice(used);
    this.pos = pos - used;
    return true;
  }
}

registerProcessor('pcm-recorder', PCMRecorder);
